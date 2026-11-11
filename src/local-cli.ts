import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { access, mkdir, open, readFile, readlink, realpath, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { hostname, userInfo, tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { digest, LocalToolError } from './local-skills.js';
import type { LocalToolResult } from './local-operation.js';
import { darwinProcessIdentity } from './darwin-process.js';
import { publishObservation } from './measurement.js';

export interface CliInvocation {
  executable: string; args: string[]; cwd: string; workspace: string; skillPath?: string; writeRoots?: string[];
  env: Record<string, string>; timeoutMs: number; sessionId: string; logPath: string; redact?: string[];
  observeProcess?: (phase: 'local.processStarted' | 'local.processFinished') => void;
}
export interface CliCompletion { result: LocalToolResult; settled: boolean; effectsKnown: boolean }
export interface CliBackend {
  readonly available: boolean; readonly unavailableReason?: string | undefined;
  /** A trusted backend guarantee, independent of executable availability. */
  readonly isolation?: 'workspace' | undefined;
  execute(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>): Promise<CliCompletion>;
  close?(): Promise<void>;
}
export interface ProcessIdentity { platform?: 'linux' | 'darwin'; pid: number; procPid: string; pidNamespace: string; startTime: string; bootId: string }
const literal = (path: string) => ({ path, literal: true as const });
export function sandboxPolicy(input: Pick<CliInvocation, 'workspace' | 'skillPath' | 'writeRoots'>): SandboxRuntimeConfig {
  // This pinned runtime helper executes inside the masked filesystem, not on the host.
  // Restore the single trusted binary, never its node_modules or service directory.
  const runtimeReads = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)
    ? [join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')), 'vendor', 'seccomp', process.arch, 'apply-seccomp')]
    : [];
  const reads = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/alternatives', '/etc/ssl/certs', '/dev/null', '/dev/urandom',
    ...(process.platform === 'darwin' ? ['/System/Library', '/Library/Apple', '/opt/homebrew', '/dev/fd', '/dev/zero'] : []),
    ...runtimeReads, dirname(dirname(process.execPath)), input.workspace, ...(input.skillPath ? [input.skillPath] : [])];
  return { network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
    filesystem: { denyRead: ['/', literal(process.cwd()), literal(join(input.workspace, '.env')), join(input.workspace, '**/.env'), join(input.workspace, '**/.env.*'), join(input.workspace, '**/*.sqlite'), join(input.workspace, '**/*.sqlite-*')], allowRead: reads.map(literal), allowWrite: (input.writeRoots ?? [input.workspace]).map(literal), denyWrite: [...runtimeReads.map(literal), literal(join(input.workspace, '.env')), literal(join(input.workspace, '.git', 'hooks')), literal(join(input.workspace, '.git', 'config')), ...['**/.env', '**/.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/.git/config', '**/.git/hooks/**'].map(pattern => join(input.workspace, pattern))] },
    enableWeakerNestedSandbox: false, allowNestedUserNamespaces: false };
}
/** Capability discovery needs the search path, not the rest of the account environment. */
export function cliSearchPath(execution: 'sandbox' | 'host', extra: Record<string, string> = {}): string {
  if (extra.PATH !== undefined) return extra.PATH;
  return execution === 'host' ? process.env.PATH ?? `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`
    : `${dirname(process.execPath)}:${process.platform === 'darwin' ? '/opt/homebrew/bin:' : ''}/usr/local/bin:/usr/bin:/bin`;
}
export function minimalCliEnvironment(workspace: string, extra: Record<string, string> = {}): Record<string, string> {
  // Host-only explicit command profiles may add credentials; never inherit process.env.
  return { PATH: cliSearchPath('sandbox', extra), LANG: 'C.UTF-8', HOME: join(workspace, '.home'), TMPDIR: join(workspace, '.tmp'),
    ...extra, NODE_OPTIONS: '', BASH_ENV: '', ENV: '', LD_PRELOAD: '', DYLD_INSERT_LIBRARIES: '' };
}
export const hostIdentity = () => ({ host: hostname(), account: userInfo().username });
/** Only a committed one-command approval may use this environment. Never launch a login shell. */
export function hostCliEnvironment(extra: Record<string, string> = {}, privateValues: string[] = []): Record<string, string> {
  const entries = Object.entries({ ...process.env, ...extra }).filter(([key, value]) => value !== undefined
    && !/^(SQUAD_|SRT_|MODEL_|WEB_|CLOUDFLARE_|OPENAI_|ANTHROPIC_)/.test(key) && !privateValues.includes(value));
  const user = userInfo();
  return { ...Object.fromEntries(entries) as Record<string, string>, HOME: user.homedir, USER: user.username, LOGNAME: user.username,
    PATH: cliSearchPath('host', extra), TMPDIR: tmpdir(),
    NODE_OPTIONS: '', BASH_ENV: '', ENV: '', LD_PRELOAD: '', DYLD_INSERT_LIBRARIES: '' };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Pinned native SRT; no unsandboxed fallback on either supported host. */
export class SandboxCliBackend implements CliBackend {
  readonly isolation = 'workspace' as const;
  private constructor(readonly available: boolean, readonly unavailableReason?: string) {}
  private initialized = false;
  static async create(): Promise<SandboxCliBackend> {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return new SandboxCliBackend(false, 'Supported native sandbox host required');
    try {
      if (process.platform === 'linux') {
        const probe = spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { timeout: 1500, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
        if (probe.error || probe.status !== 0) return new SandboxCliBackend(false, 'Required OS namespaces are unavailable');
      } else {
        await processIdentity(process.pid);
        const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 1500, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
        if (probe.error || probe.status !== 0) return new SandboxCliBackend(false, 'Native macOS sandbox unavailable');
      }
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length) return new SandboxCliBackend(false, dependencies.errors.join('; ').slice(0, 300));
      return new SandboxCliBackend(true);
    } catch { return new SandboxCliBackend(false, 'Native process identity or sandbox dependencies unavailable'); }
  }
  async execute(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>): Promise<CliCompletion> {
    if (!this.available) return { result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: { reason: this.unavailableReason ?? '' } }, settled: true, effectsKnown: true };
    let launched = false;
    try {
      // Seatbelt compares physical paths; /var and /private/var are the same macOS tree.
      input = { ...input, workspace: await realpath(input.workspace), cwd: await realpath(input.cwd),
        ...(input.skillPath ? { skillPath: await realpath(input.skillPath) } : {}),
        ...(input.writeRoots ? { writeRoots: await Promise.all(input.writeRoots.map(path => realpath(path))) } : {}) };
      if (!this.initialized) { await SandboxManager.initialize(sandboxPolicy(input)); this.initialized = true; }
      // SRT accepts shell command text internally. Every token is host-quoted from structured argv;
      // the model never supplies a shell program. Outer spawn always uses shell:false.
      const wrapped = await SandboxManager.wrapWithSandboxArgv([input.executable, ...input.args].map(quote).join(' '), '/bin/bash',
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
  if (process.platform === 'darwin') {
    const identity = await darwinProcessIdentity(pid);
    if (!identity) throw Object.assign(new Error('Process already exited'), { code: 'ENOENT' });
    return identity;
  }
  if (process.platform !== 'linux') throw new Error('Unsupported process identity platform');
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
  return { platform: 'linux', pid, procPid, pidNamespace: namespace, startTime: fields[19]!, bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() };
}
export async function identityAlive(identity: ProcessIdentity): Promise<boolean | 'unknown'> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.procPid !== 'string'
    || !/^\d+$/.test(identity.procPid) || typeof identity.bootId !== 'string' || !identity.bootId
    || typeof identity.startTime !== 'string' || !identity.startTime || typeof identity.pidNamespace !== 'string' || !identity.pidNamespace) return 'unknown';
  // Legacy persisted identities are Linux procfs records; a foreign host is never proof of exit.
  if ((identity.platform ?? 'linux') !== process.platform) return 'unknown';
  if (process.platform === 'darwin') {
    if (identity.procPid !== String(identity.pid) || identity.pidNamespace !== 'darwin'
      || !/^\d+:\d{1,6}$/.test(identity.startTime) || !/^[0-9a-f-]{36}$/i.test(identity.bootId)) return 'unknown';
    try {
      const current = await darwinProcessIdentity(identity.pid);
      return current !== null && current.startTime === identity.startTime && current.bootId === identity.bootId;
    } catch { return 'unknown'; }
  }
  try {
    const content = await readFile(`/proc/${identity.procPid}/stat`, 'utf8');
    const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
    if (fields[19] !== identity.startTime || (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== identity.bootId || fields[0] === 'Z') return false;
    if (await namespaceOf('/proc/self') !== identity.pidNamespace || await namespacePid(`/proc/${identity.procPid}`) !== identity.pid) return 'unknown';
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : 'unknown'; }
}
/** Real process lifecycle, also used by the controlled integration fixture (which is NOT an OS sandbox). */
export async function runProcess(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>, beforeSpawn?: () => void): Promise<CliCompletion> {
  signal.throwIfAborted();
  await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
  const log = await open(input.logPath, 'wx', 0o600);
  let child: ChildProcess | undefined; let timedOut = false, aborted = false, stdout = '', stderr = '', logBytes = 0, truncated = false;
  let spawnError = false; let identity: ProcessIdentity | undefined; let spawnedRecorded = false;
  const outputLimit = 16_000, logLimit = 128_000;
  const writeText = (kind: 'stdout' | 'stderr', text: string) => {
    if ((kind === 'stdout' ? stdout : stderr).length + text.length > outputLimit) truncated = true;
    if (kind === 'stdout') stdout = (stdout + text).slice(0, outputLimit); else stderr = (stderr + text).slice(0, outputLimit);
    const data = Buffer.from(`[${kind}] ${text}`); const allowed = data.subarray(0, Math.max(0, logLimit - logBytes));
    logBytes += allowed.length; if (allowed.length < data.length) truncated = true;
    if (allowed.length) { /* fd writes are synchronous and bounded; avoids a queue proportional to attacker output. */
      writeBounded(log.fd, allowed);
    }
  };
  // Keep a bounded tail so a credential split across pipe chunks is scrubbed before disk writes.
  const secrets = [...new Set(input.redact ?? [])].filter(s => s.length >= 4).sort((a, b) => b.length - a.length);
  const tail = Math.max(1, ...secrets.map(s => s.length));
  const buffers = { stdout: '', stderr: '' }, decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const write = (kind: 'stdout' | 'stderr', chunk?: Buffer) => {
    buffers[kind] += chunk ? decoders[kind].write(chunk) : decoders[kind].end();
    const boundary = chunk ? Math.max(0, buffers[kind].length - tail + 1) : buffers[kind].length;
    let at = 0, text = '';
    while (at < boundary) {
      const secret = secrets.find(s => buffers[kind].startsWith(s, at));
      if (secret) { text += '[redacted]'; at += secret.length; } else text += buffers[kind][at++]!;
    }
    buffers[kind] = buffers[kind].slice(at);
    if (text) writeText(kind, text);
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
    signal.throwIfAborted(); beforeSpawn?.();
    child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawned = false;
    child.once('spawn', () => {
      spawned = true;
      publishObservation(input.observeProcess, 'local.processStarted');
    });
    const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
      child!.once('error', () => { spawnError = true; });
      child!.once('close', (code, exitSignal) => {
        if (spawned) publishObservation(input.observeProcess, 'local.processFinished');
        resolveClose({ code, signal: exitSignal });
      });
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
    write('stdout'); write('stderr');
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
