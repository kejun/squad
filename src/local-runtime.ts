import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Intent } from './types.js';
import type { LocalOperation, LocalToolResult, SkillBinding } from './local-operation.js';
import { digest, LocalToolError, SkillRegistry, within, type RegistryOptions, type SkillPage } from './local-skills.js';
import { CliJournal, identityAlive, minimalCliEnvironment, processIdentity, resolveExecutable, SandboxCliBackend, type CliBackend, type CliCompletion } from './local-cli.js';

export interface LocalRuntimeOptions {
  dataRoot: string; skillRoots?: string[]; workspaceRoot?: string; commandTimeoutMs?: number;
  /** Trusted host profiles only; neither skill text nor model actions can change these. */
  commandEnv?: Record<string, Record<string, string>>; redact?: string[];
  backend?: CliBackend; registryLimits?: Omit<RegistryOptions, 'roots' | 'snapshotRoot'>;
  /** Explicit for non-service embedding/tests; production bootstrap always takes the single-host lock. */
  acquireServiceLock?: boolean;
  clock?: () => number;
}
interface Workspace { path: string; revision: string; isolated: boolean }
export interface LocalExecution extends CliCompletion { workspaceRevision?: string; isolated?: boolean }
const secretName = (name: string) => name === '.git' || name === '.home' || name === '.tmp' || name === '.squad-local'
  || name === '.env' || name.startsWith('.env.') || /\.sqlite(?:-|$)/.test(name);

/** Prepared before WebService recovery. No discovery or script installation inside Bot loops. */
export class LocalRuntime {
  private registryValue: SkillRegistry | undefined;
  get registry(): SkillRegistry { if (!this.registryValue) throw new LocalToolError('LOCAL_RUNTIME_NOT_READY'); return this.registryValue; }
  readonly backend: CliBackend;
  readonly journal: CliJournal;
  private workspaces = new Map<string, Promise<Workspace>>();
  private lockPath: string | undefined;
  private readonly workspaceWaiters = new Map<string, { generation: number; waiters: Set<() => void> }>();
  private readonly lockToken = randomUUID();
  private constructor(readonly options: LocalRuntimeOptions, backend: CliBackend, readonly sourceRoot?: string) {
    this.backend = backend; this.journal = new CliJournal(join(options.dataRoot, 'sessions'));
  }
  static async create(options: LocalRuntimeOptions): Promise<LocalRuntime> {
    await mkdir(resolve(options.dataRoot), { recursive: true, mode: 0o700 }); const dataRoot = await realpath(resolve(options.dataRoot));
    await chmod(dataRoot, 0o700);
    const sourceRoot = options.workspaceRoot ? await realpath(resolve(options.workspaceRoot)) : undefined;
    if (sourceRoot && (within(sourceRoot, dataRoot) || within(dataRoot, sourceRoot) || within(sourceRoot, process.cwd()) || within(process.cwd(), sourceRoot))) throw new LocalToolError('WORKSPACE_SERVICE_OVERLAP');
    // Acquire before scanning/recovery; one host owns this journal and all workspace effects.
    const runtime = new LocalRuntime({ ...options, dataRoot }, options.backend ?? await SandboxCliBackend.create(), sourceRoot);
    if (options.acquireServiceLock !== false) await runtime.acquireLock();
    try {
      const registry = await SkillRegistry.discover({ ...options.registryLimits, ...(options.skillRoots ? { roots: options.skillRoots } : {}), snapshotRoot: join(dataRoot, 'skills') });
      runtime.registryValue = registry; return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  private async acquireLock() {
    const path = join(this.options.dataRoot, 'service.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ token: this.lockToken, identity: await processIdentity(process.pid) })); await handle.sync(); } finally { await handle.close(); }
        this.lockPath = path; return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let old: { identity?: Awaited<ReturnType<typeof processIdentity>> };
        try { old = JSON.parse(await readFile(path, 'utf8')) as typeof old; } catch { throw new LocalToolError('LOCAL_RUNTIME_LOCK_UNCERTAIN'); }
        if (!old.identity || await identityAlive(old.identity) !== false) throw new LocalToolError('LOCAL_RUNTIME_IN_USE');
        await rm(path);
      }
    }
    throw new LocalToolError('LOCAL_RUNTIME_IN_USE');
  }
  catalog(): SkillPage { return this.registry.list(); }
  workspaceId(work: Intent, namespace?: string): string {
    // Explicit engineering roots are shared; default task roots must include room identity.
    const taskNamespace = namespace ?? digest(work.id.slice(0, work.id.lastIndexOf(':E')));
    return this.sourceRoot ? `workspace:${this.sourceRoot}` : `workspace:${join(this.options.dataRoot, 'workspaces', taskNamespace)}`;
  }
  workspaceGeneration(key: string): number { return this.workspaceWaiters.get(key)?.generation ?? 0; }
  waitForWorkspace(key: string, generation: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let entry = this.workspaceWaiters.get(key);
    if (!entry) { entry = { generation: 0, waiters: new Set() }; this.workspaceWaiters.set(key, entry); }
    if (entry.generation !== generation) return Promise.resolve();
    return new Promise((resolveWait, rejectWait) => {
      const done = () => { entry!.waiters.delete(done); signal.removeEventListener('abort', abort); resolveWait(); };
      const abort = () => { entry!.waiters.delete(done); signal.removeEventListener('abort', abort); rejectWait(signal.reason); };
      entry!.waiters.add(done); signal.addEventListener('abort', abort, { once: true });
    });
  }
  notifyWorkspace(key: string) {
    let entry = this.workspaceWaiters.get(key);
    if (!entry) { entry = { generation: 0, waiters: new Set() }; this.workspaceWaiters.set(key, entry); }
    entry.generation++; for (const done of [...entry.waiters]) done();
  }
  private copyPath(work: Intent, op: LocalOperation) { return join(this.options.dataRoot, 'copies', digest(`${op.namespace}:${work.id}`)); }
  private async workspace(work: Intent, op: LocalOperation): Promise<Workspace> {
    if (op.workspaceId !== this.workspaceId(work, op.namespace)) throw new LocalToolError('WORKSPACE_IDENTITY_MISMATCH');
    if (work.kind !== 'check' && !work.discussionId) return this.prepareWorkspace(work, op);
    const key = `${op.namespace}:${work.id}`;
    let pending = this.workspaces.get(key);
    if (!pending) { pending = this.prepareWorkspace(work, op); this.workspaces.set(key, pending); pending.catch(() => this.workspaces.delete(key)); }
    return pending;
  }
  private async prepareWorkspace(work: Intent, op: LocalOperation): Promise<Workspace> {
    const root = this.sourceRoot ?? join(this.options.dataRoot, 'workspaces', op.namespace);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const isolated = work.kind === 'check' || !!work.discussionId;
    const files = await workspaceManifest(root);
    const revision = sourceRevision(files);
    if (!isolated) { await prepareScratch(root); return { path: root, revision, isolated }; }
    const copy = this.copyPath(work, op);
    const marker = `${copy}.json`;
    try {
      const old = JSON.parse(await readFile(marker, 'utf8')) as { revision: string; workId: string };
      if (old.workId === work.id && /^[a-f0-9]{64}$/.test(old.revision)) return { path: copy, revision: old.revision, isolated };
    } catch { /* An unpublished copy is rebuilt before any command is launched. */ }
    await rm(copy, { recursive: true, force: true }); await mkdir(copy, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = join(copy, file.path); await mkdir(join(target, '..'), { recursive: true });
      if (file.link !== undefined) { await symlink(file.link, target); continue; }
      const source = await realpath(join(root, file.path)); if (!within(root, source)) throw new LocalToolError('WORKSPACE_PATH_ESCAPE');
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if (digest(await readFile(target)) !== file.hash) throw new LocalToolError('WORKSPACE_REVISION_CHANGED');
      await chmod(target, file.executable ? 0o755 : 0o644);
    }
    if (JSON.stringify(await workspaceManifest(root)) !== JSON.stringify(files)) throw new LocalToolError('WORKSPACE_REVISION_CHANGED');
    await writeFile(marker, JSON.stringify({ workId: work.id, revision }), { mode: 0o600 }); await prepareScratch(copy); if (work.kind === 'check') for (const dir of validationOutputs) await mkdir(join(copy, dir), { recursive: true });
    return { path: copy, revision, isolated };
  }
  clean<T>(value: T): T {
    const secrets = [...(this.options.redact ?? []), ...Object.values(this.options.commandEnv ?? {}).flatMap(env => Object.values(env))].filter(s => s.length >= 4);
    const scrub = (item: unknown): unknown => {
      if (typeof item === 'string') { for (const secret of secrets) item = (item as string).replaceAll(secret, '[redacted]'); return item; }
      if (Array.isArray(item)) return item.map(scrub);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, scrub(val)]));
      return item;
    };
    return scrub(value) as T;
  }

  private boundedResult(result: LocalToolResult): LocalToolResult {
    const cleaned = this.clean(result);
    if (JSON.stringify(cleaned).length <= 90_000) return cleaned;
    const data = cleaned.data;
    if ('exitCode' in data) {
      const bounded = { ...cleaned, data: { ...data, stdout: String(data.stdout ?? '').slice(0, 6000), stderr: String(data.stderr ?? '').slice(0, 6000),
        outputFiles: Array.isArray(data.outputFiles) ? data.outputFiles.slice(0, 20) : [], truncated: true, outputFilesTruncated: true } };
      if (JSON.stringify(bounded).length <= 90_000) return bounded;
      return { ok: cleaned.ok, code: cleaned.code, data: { exitCode: data.exitCode, signal: data.signal, truncated: true, outputFilesTruncated: true,
        stdout: String(data.stdout ?? '').slice(0, 4000), stderr: String(data.stderr ?? '').slice(0, 4000) } };
    }
    return { ok: false, code: 'LOCAL_RESULT_LIMIT', data: { originalCode: cleaned.code } };
  }
  async execute(work: Intent, op: LocalOperation, signal: AbortSignal,
    started: (metadata: { workspaceRevision?: string; isolated?: boolean }) => void): Promise<LocalExecution> {
    const action = op.action; signal.throwIfAborted();
    if (action.type !== 'runCli') {
      try {
        let data: object;
        if (action.type === 'listSkills') data = this.registry.list(action);
        else if (action.type === 'verifyWorkspace') {
          if (op.workspaceId !== this.workspaceId(work, op.namespace)) throw new LocalToolError('WORKSPACE_IDENTITY_MISMATCH');
          const root = op.workspaceId.slice('workspace:'.length);
          const currentRevision = sourceRevision(await workspaceManifest(root));
          const copyRevision = sourceRevision(await workspaceManifest(this.copyPath(work, op)));
          const matches = currentRevision === action.expectedRevision && copyRevision === action.expectedRevision;
          return { result: { ok: matches, code: matches ? 'WORKSPACE_REVISION_CONFIRMED' : 'WORKSPACE_REVISION_CHANGED',
            data: { expectedRevision: action.expectedRevision, currentRevision, copyRevision } }, settled: true, effectsKnown: true };
        }
        else if (action.type === 'loadSkill') data = await this.registry.load(action.skillId, this.binding(work, action.skillId)?.skillVersion);
        else {
          const binding = this.binding(work, action.skillId); if (!binding) throw new LocalToolError('SKILL_NOT_ACTIVE');
          data = await this.registry.read(binding.skillId, action.path, binding.skillVersion, action.offset);
        }
        signal.throwIfAborted();
        return { result: this.boundedResult({ ok: true, code: action.type, data: data as Record<string, unknown> }), settled: true, effectsKnown: true };
      } catch (error) {
        signal.throwIfAborted(); return { result: { ok: false, code: error instanceof LocalToolError ? error.code : 'LOCAL_READ_FAILED', data: {} }, settled: true, effectsKnown: true };
      }
    }
    const sessionId = op.sessionId!;
    await this.journal.write({ operationId: op.id, sessionId, phase: 'prepared' });
    let launched = false;
    let completion: LocalExecution;
    try {
      if (!this.backend.available) throw new LocalToolError('CLI_SANDBOX_UNAVAILABLE');
      const workspace = await this.workspace(work, op); signal.throwIfAborted();
      let skillPath: string | undefined;
      if (action.skillId) {
        const binding = this.binding(work, action.skillId); if (!binding) throw new LocalToolError('SKILL_NOT_ACTIVE');
        skillPath = (await this.registry.snapshot(binding.skillId, binding.skillVersion)).path;
      }
      const cwd = await realpath(resolve(workspace.path, action.cwd ?? '.'));
      if (isAbsolute(action.cwd ?? '') || !within(workspace.path, cwd)) throw new LocalToolError('CLI_CWD_INVALID');
      const expand = async (arg: string) => {
        if (arg === '@workspace') return workspace.path;
        if (arg.startsWith('@workspace/')) { const target = resolve(workspace.path, arg.slice(11)); if (!within(workspace.path, target)) throw new LocalToolError('WORKSPACE_PATH_ESCAPE'); return target; }
        if (arg === '@skill' || arg.startsWith('@skill/')) {
          if (!skillPath) throw new LocalToolError('SKILL_NOT_ACTIVE');
          const target = await realpath(resolve(skillPath, arg === '@skill' ? '.' : arg.slice(7)));
          if (!within(skillPath, target)) throw new LocalToolError('SKILL_PATH_ESCAPE'); return target;
        }
        return arg;
      };
      const env = minimalCliEnvironment(workspace.path, this.options.commandEnv?.[action.executable]);
      const executable = await resolveExecutable(await expand(action.executable), env);
      const args = await Promise.all(action.args.map(expand));
      const remaining = work.deadline === null ? 120_000 : work.deadline - (this.options.clock ?? Date.now)();
      const timeoutMs = Math.min(action.timeoutMs ?? this.options.commandTimeoutMs ?? 120_000, Math.max(1, remaining));
      if (work.kind === 'check') for (const dir of validationOutputs) await mkdir(join(workspace.path, dir), { recursive: true });
      started({ workspaceRevision: workspace.revision, isolated: workspace.isolated }); signal.throwIfAborted();
      launched = true;
      const baseline = new Map((await workspaceManifest(workspace.path)).map(file => [file.path, file.hash]));
      const result = await this.backend.execute({ executable, args, cwd, workspace: workspace.path, ...(skillPath ? { skillPath } : {}), env, timeoutMs, sessionId,
        ...(work.kind === 'check' ? { writeRoots: [...validationOutputs, '.home', '.tmp'].map(dir => join(workspace.path, dir)) } : {}),
        logPath: join(this.options.dataRoot, 'logs', `${digest(sessionId)}.log`) }, signal,
        async identity => { await this.journal.write({ operationId: op.id, sessionId, phase: 'spawned', identity }); });
      let outputFiles: Awaited<ReturnType<typeof workspaceManifest>> = [], outputFilesTruncated = false;
      try { const changed = (await workspaceManifest(workspace.path)).filter(file => baseline.get(file.path) !== file.hash); outputFiles = changed.slice(0, 100); outputFilesTruncated = changed.length > 100; } catch { outputFilesTruncated = true; }
      const validationInputsChanged = work.kind === 'check' && sourceRevision(await workspaceManifest(workspace.path)) !== workspace.revision;
      // A terminated sandbox may have written files. Their bounded content fingerprint makes the effect
      // observable; it is still not a proof of arbitrary network effects (network is denied by default).
      completion = { ...result, result: this.boundedResult({ ...result.result, ...(validationInputsChanged ? { ok: false, code: 'CHECK_INPUTS_CHANGED' } : {}), data: { ...result.result.data, workspaceRevision: workspace.revision, isolated: workspace.isolated,
        outputFiles, outputFilesTruncated, validationInputsChanged } }), workspaceRevision: workspace.revision, isolated: workspace.isolated };
    } catch (error) {
      completion = { result: { ok: false, code: signal.aborted ? 'cancelled' : error instanceof LocalToolError ? error.code : 'CLI_EXECUTION_FAILED', data: {} }, settled: !launched, effectsKnown: !launched };
    }
    await this.journal.write({ operationId: op.id, sessionId, phase: 'settled', completion });
    return completion;
  }
  private binding(work: Intent, id: string): SkillBinding | undefined { return work.localSkills?.find(s => s.skillId === id); }
  async reconcile(op: LocalOperation) {
    if (op.action.type !== 'runCli') return { resolution: 'notStarted' as const, detail: 'Host-classified read-only skill operation may be replayed' };
    return this.journal.reconcile(op.id, op.sessionId!);
  }
  async reviewOperation(work: Intent, op: LocalOperation) {
    if (!op.sessionId || op.action.type !== 'runCli' || op.workspaceId !== this.workspaceId(work, op.namespace)) throw new LocalToolError('LOCAL_REVIEW_IDENTITY_MISMATCH');
    const session = await this.journal.review(op.id, op.sessionId);
    if (!session) throw new LocalToolError('LOCAL_REVIEW_UNAVAILABLE');
    const path = op.isolated ? this.copyPath(work, op) : op.workspaceId.slice('workspace:'.length);
    const files = await workspaceManifest(path);
    const review = { operationId: op.id, sessionId: op.sessionId, action: op.action, processState: session.state,
      receipt: session.record.completion?.result ?? null, workspaceRevision: digest(JSON.stringify(files)), files: files.slice(0, 100), filesTruncated: files.length > 100 };
    return { ...this.clean(review), reviewDigest: digest(JSON.stringify(review)) };
  }
  async acknowledgeOperation(work: Intent, op: LocalOperation, expectedDigest: string) {
    const review = await this.reviewOperation(work, op);
    if (review.reviewDigest !== expectedDigest) throw new LocalToolError('LOCAL_REVIEW_STALE');
    if (review.processState !== 'exited') throw new LocalToolError('LOCAL_SESSION_NOT_SETTLED');
    const result = this.clean({ ...(review.receipt ?? { ok: false, code: 'CLI_EFFECTS_RECONCILED', data: { exitCode: null } }),
      data: { ...(review.receipt?.data ?? {}), operatorConfirmed: true, reviewedWorkspaceRevision: review.workspaceRevision } });
    await this.journal.write({ operationId: op.id, sessionId: op.sessionId!, phase: 'settled', completion: { result, settled: true, effectsKnown: true } });
    return { resolution: 'receipt' as const, result, detail: `Operator acknowledged effects: ${review.reviewDigest}` };
  }
  async close() {
    await this.backend.close?.();
    if (this.lockPath) {
      try { const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token: string }; if (lock.token === this.lockToken) await rm(this.lockPath); } catch { /* Keep an uncertain lock rather than claiming it was removed. */ }
    }
  }
}
async function prepareScratch(path: string) { await mkdir(join(path, '.home'), { recursive: true, mode: 0o700 }); await mkdir(join(path, '.tmp'), { recursive: true, mode: 0o700 }); }
interface WorkspaceFile { path: string; hash: string; bytes: number; executable: boolean; link?: string }
async function workspaceManifest(root: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [], visited = new Set<string>(); let bytes = 0; const deadline = Date.now() + 10_000;
  async function walk(dir: string, prefix: string, depth: number) {
    const canonical = await realpath(dir);
    if (!within(root, canonical)) throw new LocalToolError('WORKSPACE_PATH_ESCAPE');
    if (visited.has(canonical) || depth > 24) throw new LocalToolError('WORKSPACE_LINK_CYCLE'); visited.add(canonical);
    for (const name of (await readdir(dir)).sort()) {
      if (secretName(name)) continue;
      if (Date.now() > deadline || files.length >= 50_000) throw new LocalToolError('WORKSPACE_SCAN_LIMIT');
      const rel = prefix ? `${prefix}/${name}` : name, raw = join(dir, name), path = await realpath(raw);
      if (!within(root, path)) throw new LocalToolError('WORKSPACE_PATH_ESCAPE');
      const info = await lstat(path);
      if ((await lstat(raw)).isSymbolicLink()) {
        if (info.isDirectory() && within(path, dirname(raw))) throw new LocalToolError('WORKSPACE_LINK_CYCLE');
        const link = relative(dirname(raw), path);
        files.push({ path: rel, hash: digest(`link:${link}`), bytes: 0, executable: false, link });
      } else if (info.isDirectory()) await walk(path, rel, depth + 1);
      else if (info.isFile()) {
        if (info.size > 64 * 1024 * 1024 || (bytes += info.size) > 1024 * 1024 * 1024) throw new LocalToolError('WORKSPACE_SCAN_LIMIT');
        files.push({ path: rel, hash: digest(await readFile(path)), bytes: info.size, executable: !!(info.mode & 0o111) });
      } else throw new LocalToolError('WORKSPACE_SPECIAL_FILE');
    }
    visited.delete(canonical);
  }
  await walk(root, '', 0); return files;
}

const validationOutputs = new Set(['dist', 'test-results', 'reports', 'coverage']);
const sourceRevision = (files: WorkspaceFile[]) => digest(JSON.stringify(files.filter(file => !validationOutputs.has(file.path.split('/')[0]!))));
