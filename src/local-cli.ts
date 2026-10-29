import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, readlink, realpath, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { digest, LocalToolError, within } from './local-skills.js';
import type { LocalToolResult } from './local-operation.js';

export interface CliInvocation {
  executable: string; args: string[]; cwd: string; workspace: string; skillPath?: string;
  env: Record<string, string>; timeoutMs: number; sessionId: string; logPath: string;
}
export interface CliCompletion { result: LocalToolResult; settled: boolean; effectsKnown: boolean }
export interface CliBackend {
  readonly available: boolean; readonly unavailableReason?: string | undefined;
  execute(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>): Promise<CliCompletion>;
  close?(): Promise<void>;
}
export interface ProcessIdentity { pid: number; procPid: string; pidNamespace: string; startTime: string; bootId: string }
const literal = (path: string) => ({ path, literal: true as const });
export function sandboxPolicy(input: Pick<CliInvocation, 'workspace' | 'skillPath'>): SandboxRuntimeConfig {
  const reads = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/alternatives', '/etc/ssl/certs', '/dev/null', '/dev/urandom', dirname(dirname(process.execPath)), input.workspace, ...(input.skillPath ? [input.skillPath] : [])];
  return { network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
    filesystem: { denyRead: ['/', literal(process.cwd()), literal(join(input.workspace, '.env')), join(input.workspace, '**/.env'), join(input.workspace, '**/.env.*'), join(input.workspace, '**/*.sqlite'), join(input.workspace, '**/*.sqlite-*')], allowRead: reads.map(literal), allowWrite: [literal(input.workspace)], denyWrite: [literal(join(input.workspace, '.env')), ...['**/.env', '**/.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/.git/config', '**/.git/hooks/**'].map(pattern => join(input.workspace, pattern))] },
    enableWeakerNestedSandbox: false, allowNestedUserNamespaces: false };
}
export function minimalCliEnvironment(workspace: string, extra: Record<string, string> = {}): Record<string, string> {
  // Host-only explicit command profiles may add credentials; never inherit process.env.
  return { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: join(workspace, '.home'), TMPDIR: join(workspace, '.tmp'),
    ...extra, NODE_OPTIONS: '', BASH_ENV: '', ENV: '', LD_PRELOAD: '', DYLD_INSERT_LIBRARIES: '' };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Pinned SRT; no unsandboxed fallback. Linux PID namespaces are required for descendant settlement. */
export class SandboxCliBackend implements CliBackend {
  private constructor(readonly available: boolean, readonly unavailableReason?: string) {}
  private initialized = false;
  static async create(): Promise<SandboxCliBackend> {
    if (process.platform !== 'linux') return new SandboxCliBackend(false, 'Linux PID namespace backend required');
    try {
      const probe = spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { timeout: 1500, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
      if (probe.error || probe.status !== 0) return new SandboxCliBackend(false, 'Required OS namespaces are unavailable');
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length) return new SandboxCliBackend(false, dependencies.errors.join('; ').slice(0, 300));
      return new SandboxCliBackend(true);
    } catch { return new SandboxCliBackend(false, 'Sandbox dependencies unavailable'); }
  }
  async execute(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>): Promise<CliCompletion> {
    if (!this.available) return { result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: { reason: this.unavailableReason ?? '' } }, settled: true, effectsKnown: true };
    let launched = false;
    try {
      if (!this.initialized) { await SandboxManager.initialize(sandboxPolicy(input)); this.initialized = true; }
      // SRT accepts shell command text internally. Every token is host-quoted from structured argv;
      // the model never supplies a shell program. Outer spawn always uses shell:false.
      const wrapped = await SandboxManager.wrapWithSandboxArgv([input.executable, ...input.args].map(quote).join(' '), undefined,
        sandboxPolicy(input), signal, input.cwd, { commandId: input.sessionId });
      // On pinned SRT Linux, wrapped.env IS process.env; proxy settings are already
      // encoded in the wrapped argv. Never copy the host environment back into the child.
      launched = true;
      return await runProcess({ ...input, executable: wrapped.argv[0]!, args: wrapped.argv.slice(1), env: input.env }, signal, onSpawn);
    } catch {
      signal.throwIfAborted();
      return { result: { ok: false, code: launched ? 'CLI_EXECUTION_UNCERTAIN' : 'CLI_SANDBOX_UNAVAILABLE', data: {} }, settled: !launched, effectsKnown: !launched };
    } finally { SandboxManager.cleanupAfterCommand(); }
  }
  async close() { if (this.initialized) { await SandboxManager.reset(); this.initialized = false; } }
}

async function namespaceOf(path: string) { return readlink(`${path}/ns/pid`); }
async function namespacePid(path: string): Promise<number> {
  const line = (await readFile(`${path}/status`, 'utf8')).split('\n').find(l => l.startsWith('NSpid:'));
  return Number(line?.trim().split(/\s+/).at(-1));
}
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const namespace = await namespaceOf('/proc/self');
  let procPid = pid === process.pid ? await readlink('/proc/self') : String(pid);
  if (pid !== process.pid) {
    let matches = false;
    try { matches = await namespacePid(`/proc/${procPid}`) === pid && await namespaceOf(`/proc/${procPid}`) === namespace; } catch { /* /proc may be mounted from an outer PID namespace. */ }
    if (!matches) {
      const self = await readlink('/proc/self');
      const children = (await readFile(`/proc/${self}/task/${self}/children`, 'utf8')).trim().split(/\s+/);
      let found: string | undefined;
      for (const child of children) { try { if (await namespacePid(`/proc/${child}`) === pid && await namespaceOf(`/proc/${child}`) === namespace) { found = child; break; } } catch { /* Child already exited. */ } }
      if (!found) throw Object.assign(new Error('Process already exited or identity unavailable'), { code: 'ENOENT' });
      procPid = found;
    }
  }
  const content = await readFile(`/proc/${procPid}/stat`, 'utf8');
  const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
  return { pid, procPid, pidNamespace: namespace, startTime: fields[19]!, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
}
export async function identityAlive(identity: ProcessIdentity): Promise<boolean | 'unknown'> {
  try {
    const content = await readFile(`/proc/${identity.procPid}/stat`, 'utf8');
    const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
    if (fields[19] !== identity.startTime || (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== identity.bootId || fields[0] === 'Z') return false;
    if (await namespaceOf('/proc/self') !== identity.pidNamespace || await namespacePid(`/proc/${identity.procPid}`) !== identity.pid) return 'unknown';
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown'; }
}
/** Real process lifecycle, also used by the controlled integration fixture (which is NOT an OS sandbox). */
export async function runProcess(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>): Promise<CliCompletion> {
  signal.throwIfAborted();
  await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
  const log = await open(input.logPath, 'wx', 0o600);
  let child: ChildProcess | undefined; let timedOut = false, aborted = false, stdout = '', stderr = '', logBytes = 0, truncated = false;
  let spawnError = false; let identity: ProcessIdentity | undefined; let spawnedRecorded = false;
  const outputLimit = 16_000, logLimit = 128_000;
  const write = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if ((kind === 'stdout' ? stdout : stderr).length + text.length > outputLimit) truncated = true;
    if (kind === 'stdout') stdout = (stdout + text).slice(0, outputLimit); else stderr = (stderr + text).slice(0, outputLimit);
    const data = Buffer.from(`[${kind}] ${text}`); const allowed = data.subarray(0, Math.max(0, logLimit - logBytes));
    logBytes += allowed.length; if (allowed.length < data.length) truncated = true;
    if (allowed.length) { /* fd writes are synchronous and bounded; avoids a queue proportional to attacker output. */
      writeBounded(log.fd, allowed);
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let unconfirmed!: (value: { code: null; signal: null; closed: false }) => void;
  const settlementDeadline = new Promise<{ code: null; signal: null; closed: false }>(resolveDeadline => { unconfirmed = resolveDeadline; });
  const kill = (signalName: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signalName); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') spawnError = true; }
  };
  const cancel = () => {
    aborted = true; kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 300);
    hardTimer ??= setTimeout(() => {
      kill('SIGKILL'); unconfirmed({ code: null, signal: null, closed: false });
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }, 1800);
  };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, input.timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
      child!.once('error', () => { spawnError = true; });
      child!.once('close', (code, exitSignal) => resolveClose({ code, signal: exitSignal }));
    });
    child.stdout!.on('data', (data: Buffer) => write('stdout', data)); child.stderr!.on('data', (data: Buffer) => write('stderr', data));
    if (child.pid) {
      try { identity = await processIdentity(child.pid); await onSpawn(identity); spawnedRecorded = true; }
      catch (error) {
        // A very short command may exit before /proc can be sampled. It still has a durable receipt below.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { spawnError = true; cancel(); }
      }
    }
    if (signal.aborted) cancel();
    const exit = await Promise.race([close.then(value => ({ ...value, closed: true })), settlementDeadline]);
    // No process group survives normal completion, timeout or explicit cancellation.
    kill('SIGKILL');
    const result: LocalToolResult = { ok: !spawnError && !aborted && exit.code === 0,
      code: !exit.closed ? 'CLI_SESSION_UNCERTAIN' : spawnError ? 'CLI_NOT_FOUND' : timedOut ? 'timeout' : aborted ? 'cancelled' : exit.code === 0 ? 'succeeded' : 'failed',
      data: { exitCode: exit.code, signal: exit.signal, stdout, stderr, truncated, logBytes, logId: basenameSafe(input.logPath),
        sessionId: input.sessionId, processRecorded: spawnedRecorded } };
    return { result, settled: exit.closed, effectsKnown: exit.closed && !aborted };
  } finally {
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (hardTimer) clearTimeout(hardTimer); signal.removeEventListener('abort', cancel); await log.sync(); await log.close();
  }
}
import { writeSync } from 'node:fs';
const writeBounded = (fd: number, data: Buffer) => { try { writeSync(fd, data); } catch { /* Model receipt still records the exit; no unbounded retry. */ } };
const basenameSafe = (path: string) => path.split('/').at(-1)!;

export async function resolveExecutable(command: string, env: Record<string, string>): Promise<string> {
  if (command.includes('/') && !isAbsolute(command)) throw new LocalToolError('CLI_EXECUTABLE_INVALID');
  const candidates = isAbsolute(command) ? [command] : env.PATH!.split(':').map(dir => join(dir, command));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return await realpath(path); } catch { /* Try next installed command. */ }
  }
  throw new LocalToolError('CLI_NOT_FOUND');
}

interface SessionRecord { operationId: string; sessionId: string; phase: 'prepared' | 'spawned' | 'settled'; identity?: ProcessIdentity; completion?: CliCompletion }
/** Host-private durable receipt journal closes the DB result / process completion crash window. */
export class CliJournal {
  constructor(private readonly root: string) {}
  private path(sessionId: string) { return join(this.root, `${digest(sessionId)}.json`); }
  async write(record: SessionRecord) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(record.sessionId), temp = `${path}.pending`;
    const prior = await this.read(record.sessionId);
    if (prior?.operationId === record.operationId && prior.identity && !record.identity) record = { ...record, identity: prior.identity };
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path); const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async read(sessionId: string): Promise<SessionRecord | null> {
    try { return JSON.parse(await readFile(this.path(sessionId), 'utf8')) as SessionRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async review(operationId: string, sessionId: string) {
    const record = await this.read(sessionId);
    if (!record || record.operationId !== operationId || record.sessionId !== sessionId) return null;
    const state = record.phase === 'settled' && record.completion?.settled ? 'exited'
      : record.identity ? await identityAlive(record.identity) === false ? 'exited' : 'unconfirmed' : 'unconfirmed';
    return { record, state };
  }
  async reconcile(operationId: string, sessionId: string): Promise<{ resolution: 'notStarted' | 'receipt'; result?: LocalToolResult; detail: string } | null> {
    const record = await this.read(sessionId);
    if (!record) return { resolution: 'notStarted', detail: 'Durable launch journal absent; spawn is strictly after journal fsync' };
    if (record.operationId !== operationId || record.sessionId !== sessionId) return null;
    if (record.phase === 'settled' && record.completion?.settled && record.completion.effectsKnown) return { resolution: 'receipt', result: record.completion.result, detail: 'Durable settled process receipt' };
    if (record.identity) {
      const alive = await identityAlive(record.identity);
      if (alive === true) {
        // Never signal a bare/reused PID. The startup service lock prevents a competing host.
        try { process.kill(-record.identity.pid, 'SIGTERM'); } catch { /* Keep uncertain. */ }
        await delay(350);
        if (await identityAlive(record.identity) === true) { try { process.kill(-record.identity.pid, 'SIGKILL'); } catch { /* Keep uncertain. */ } }
      }
    }
    // Absence of a live process does not prove what it wrote. Retain the lease for explicit reconciliation.
    return null;
  }
}
