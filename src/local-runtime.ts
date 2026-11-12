import { maximumTimeoutMs } from './budget-defaults.js';
import { prepareCliStdin, type PreparedCliStdin } from './local-stdin.js';
import { repeatedCliFailures } from './cli-failure.js';
import { discoverHostCapabilities } from './host-capabilities.js';
import { CliCatalogError, type CliCatalogEntry } from './cli-catalog.js';
import { ToolInventoryStore, type ToolInventorySnapshot } from './tool-inventory.js';
import type { CliDiscoveryOptions } from './automatic-cli-catalog.js';
import { observeCliAcquisitions, type CliAcquisitionReader } from './acquisition-readers.js';
import type { HostAcquisition } from './resource-acquisition.js';
import { RuntimeOwnership, type ClaimedRuntimeCleanup, type RoomCleanupInput } from './runtime-ownership.js';
import type { RuntimeCleanupInventory } from './room-deletion.machine.js';
import { resolveLocalResourcePolicy } from './local-resource-policy.js';
import type { LocalAction } from './local-operation.js';
import { publishObservation } from './measurement.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Intent } from './types.js';
import { attachCapturedEvidence } from './evidence-reader.js';
import type { HostApproval, HostCommandPlan, LocalOperation, LocalToolResult, SkillBinding } from './local-operation.js';
import { digest, LocalToolError, within, type RegistryOptions, type SkillPage } from './local-skills.js';
import { CliJournal, cliSearchPath, hostCliEnvironment, hostIdentity, identityAlive, minimalCliEnvironment, processIdentity, resolveExecutable, runProcess, SandboxCliBackend, type CliBackend, type CliCompletion } from './local-cli.js';

export interface LocalRuntimeOptions {
  dataRoot: string; skillRoots?: string[]; workspaceRoot?: string; commandTimeoutMs?: number;
  /** Trusted host profiles only; neither skill text nor model actions can change these. */
  commandEnv?: Record<string, Record<string, string>>; redact?: string[];
  /** Host-maintained usage metadata only; does not grant execution permission. */
  cliCatalog?: CliCatalogEntry[];
  cliCatalogFile?: string;
  cliDiscovery?: CliDiscoveryOptions;
  /** Zero disables background file observation and periodic refresh for controlled embeddings. */
  catalogRefreshIntervalMs?: number;
  acquisitionReaders?: CliAcquisitionReader[];
  backend?: CliBackend; registryLimits?: Omit<RegistryOptions, 'roots' | 'snapshotRoot'>;
  /** Explicit for non-service embedding/tests; production bootstrap always takes the single-host lock. */
  acquireServiceLock?: boolean;
  clock?: () => number;
}
interface Workspace { path: string; revision: string; isolated: boolean }
async function executableDigest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
export interface LocalExecution extends CliCompletion { workspaceRevision?: string; isolated?: boolean; approval?: HostApproval }
const secretName = (name: string) => name === '.git' || name === '.home' || name === '.tmp' || name === '.squad-local'
  || name === '.env' || name.startsWith('.env.') || /\.sqlite(?:-|$)/.test(name);

/** Prepared before WebService recovery. No discovery or script installation inside Bot loops. */
export class LocalRuntime {
  private readonly inventory: ToolInventoryStore;
  get registry() { return this.inventory.registry; }
  private get cliCatalog() { return this.inventory.cliCatalog; }
  toolInventory(): ToolInventorySnapshot { return this.inventory.snapshot(); }
  refreshToolInventory(): Promise<ToolInventorySnapshot> { return this.inventory.refresh(); }
  /** Synchronous metadata only; no filesystem, executable probes, credential reads or process launches. */
  recommendTools(objective: string) {
    return { metadataOnly: true as const, cli: this.cliCatalog.recommend(objective), skills: this.registry.recommend(objective) };
  }
  readonly backend: CliBackend;
  readonly journal: CliJournal;
  private workspaces = new Map<string, Promise<Workspace>>();
  private lockPath: string | undefined;
  private readonly workspaceWaiters = new Map<string, { generation: number; waiters: Set<() => void> }>();
  private readonly lockToken = randomUUID();
  private readonly ownership: RuntimeOwnership;
  private readonly physicalJobs = new Map<string, Set<Promise<unknown>>>();
  private readonly legacyPhysicalJobs = new Set<Promise<unknown>>();
  private constructor(readonly options: LocalRuntimeOptions, backend: CliBackend, readonly sourceRoot?: string) {
    this.backend = backend; this.journal = new CliJournal(join(options.dataRoot, 'sessions'));
    this.inventory = new ToolInventoryStore(options, backend);
    this.ownership = new RuntimeOwnership(options.dataRoot, sourceRoot, options.clock ?? Date.now);
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
      await runtime.inventory.initialize(); return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
  private async acquireLock() {
    const path = join(this.options.dataRoot, 'service.lock');
    // Probe before creating the file: unsupported/failed native probes cannot leave an empty lock.
    const identity = await processIdentity(process.pid);
    for (let attempt = 0; attempt < 2; attempt++) {
      let created = false;
      try {
        const handle = await open(path, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(JSON.stringify({ token: this.lockToken, identity })); await handle.sync(); } finally { await handle.close(); }
        this.lockPath = path; return;
      } catch (error) {
        if (created) { await rm(path).catch(() => {}); throw error; }
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
  observeAcquisitions(work: Intent, op: LocalOperation, configuration?: HostAcquisition['configuration']): HostAcquisition[] {
    return observeCliAcquisitions(work, op, this.options.acquisitionReaders ?? [], digest, configuration);
  }
  planRoomCleanup(input: RoomCleanupInput): Promise<RuntimeCleanupInventory> { return this.ownership.inventory(input); }
  private trackPhysical<T>(roomId: string | undefined, job: Promise<T>): Promise<T> {
    let jobs = roomId ? this.physicalJobs.get(roomId) : this.legacyPhysicalJobs;
    if (!jobs) { jobs = new Set(); this.physicalJobs.set(roomId!, jobs); }
    jobs.add(job);
    return job.finally(() => {
      jobs.delete(job);
      if (roomId && jobs.size === 0) this.physicalJobs.delete(roomId);
    });
  }
  roomQuiescent(roomId: string): boolean {
    return this.legacyPhysicalJobs.size === 0 && (this.physicalJobs.get(roomId)?.size ?? 0) === 0;
  }
  private retireWorkspaceCache(asset: ClaimedRuntimeCleanup['asset']) {
    const { namespace, workId } = asset.owner;
    if (asset.kind === 'workspace') {
      for (const key of this.workspaces.keys()) if (key.startsWith(`${namespace}:`)) this.workspaces.delete(key);
    } else if (asset.kind === 'copy' && workId) this.workspaces.delete(`${namespace}:${workId}`);
  }
  cleanupRoom(claim: ClaimedRuntimeCleanup, signal: AbortSignal) {
    const cleanup = this.ownership.remove(claim, signal).then(result => {
      this.retireWorkspaceCache(claim.asset);
      return result;
    });
    return this.trackPhysical(claim.roomId, cleanup);
  }
  async verifyRoomCleanup(inventory: RuntimeCleanupInventory): Promise<boolean> {
    if (!await this.ownership.verify(inventory)) return false;
    return ![...this.workspaces.keys()].some(key => inventory.tasks.some(task => key.startsWith(`${task.namespace}:`)));
  }
  workspaceId(work: Intent, namespace?: string): string {
    // Explicit engineering roots are shared; default task roots must include room identity.
    const taskNamespace = namespace ?? digest(work.id.slice(0, work.id.lastIndexOf(':E')));
    return this.sourceRoot ? `workspace:${this.sourceRoot}` : `workspace:${join(this.options.dataRoot, 'workspaces', taskNamespace)}`;
  }
  resourcePolicy(work: Intent, action: LocalAction, namespace?: string) {
    if (action.type !== 'runCli' && action.type !== 'verifyWorkspace') return undefined;
    const taskNamespace = namespace ?? digest(work.id.slice(0, work.id.lastIndexOf(':E')));
    const isolatedWork = work.kind === 'check' || !!work.discussionId;
    const copyId = `workspace:${this.copyPath(work, { namespace: taskNamespace })}`;
    return resolveLocalResourcePolicy({ workspaceId: this.workspaceId(work, taskNamespace), copyId, isolatedWork,
      execution: action.type === 'runCli' && action.execution === 'host' ? 'host' : 'sandbox', action: action.type,
      sandboxConfinesWorkspace: this.backend.available && this.backend.isolation === 'workspace' });
  }
  workspaceGeneration(key: string): number { return this.workspaceWaiters.get(key)?.generation ?? 0; }
  /** Call only after the durable settlement has released its leases. */
  notifyResourceRelease(operation: Pick<LocalOperation, 'workspaceId' | 'resourceLeases'>): void {
    this.notifyWorkspace('resources');
    if (operation.workspaceId) this.notifyWorkspace(operation.workspaceId);
    for (const lease of operation.resourceLeases ?? []) this.notifyWorkspace(lease.key);
  }
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
  private copyPath(work: Intent, op: Pick<LocalOperation, 'namespace'>) { return join(this.options.dataRoot, 'copies', digest(`${op.namespace}:${work.id}`)); }
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
      if (old.workId === work.id && /^[a-f0-9]{64}$/.test(old.revision)) {
        // The source marker can survive a host exit before scratch preparation finishes.
        await prepareScratch(copy);
        return { path: copy, revision: old.revision, isolated };
      }
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
    const secrets = this.secrets();
    const scrub = (item: unknown): unknown => {
      if (typeof item === 'string') { for (const secret of secrets) item = (item as string).replaceAll(secret, '[redacted]'); return item; }
      if (Array.isArray(item)) return item.map(scrub);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, scrub(val)]));
      return item;
    };
    return scrub(value) as T;
  }
  private secrets(): string[] {
    return [...(this.options.redact ?? []), ...Object.values(this.options.commandEnv ?? {}).flatMap(env => Object.values(env)),
      ...Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key)).map(([, value]) => value ?? '')].filter(s => s.length >= 4);
  }

  private boundedResult(result: LocalToolResult): LocalToolResult {
    const cleaned = this.clean(result);
    if (cleaned.ok && ['discoverHost', 'listSkills'].includes(cleaned.code)) return cleaned;
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
  execute(work: Intent, op: LocalOperation, signal: AbortSignal,
    started: (metadata: { workspaceRevision?: string; isolated?: boolean }) => void,
    observe?: (phase: 'local.prepareStarted' | 'local.prepareFinished' | 'local.processStarted' | 'local.processFinished') => void,
    owner?: { roomId: string; taskId: string },
    workspacePrepared?: (metadata: { workspaceRevision?: string; isolated?: boolean }) => void): Promise<LocalExecution> {
    return this.trackPhysical(owner?.roomId, this.executeOperation(work, op, signal, started, observe, owner, workspacePrepared));
  }
  private async executeOperation(work: Intent, op: LocalOperation, signal: AbortSignal,
    started: (metadata: { workspaceRevision?: string; isolated?: boolean }) => void,
    observe?: (phase: 'local.prepareStarted' | 'local.prepareFinished' | 'local.processStarted' | 'local.processFinished') => void,
    owner?: { roomId: string; taskId: string },
    workspacePrepared?: (metadata: { workspaceRevision?: string; isolated?: boolean }) => void): Promise<LocalExecution> {
    const action = op.action; signal.throwIfAborted();
    if (action.type === 'readArtifact') return { result: { ok: false, code: 'ARTIFACT_UNAVAILABLE', data: {} }, settled: true, effectsKnown: true };
    if (action.type === 'readEvidence') return { result: { ok: false, code: 'EVIDENCE_SOURCE_REQUIRED', data: {} }, settled: true, effectsKnown: true };
    if (action.type !== 'runCli') {
      try {
        let data: object;
        if (action.type === 'discoverHost') data = await discoverHostCapabilities({
          platform: process.platform, arch: process.arch, runtimeVersion: process.version,
          sandbox: { available: this.backend.available, ...(this.backend.unavailableReason ? { reason: this.backend.unavailableReason } : {}) },
          skills: this.catalog(),
          catalog: this.cliCatalog.list(action),
          locate: async (command, execution) => {
            const profile = this.options.commandEnv?.[command];
            const env = { PATH: cliSearchPath(execution, profile) };
            try { await resolveExecutable(command, env); return true; }
            catch (error) { if (error instanceof LocalToolError && error.code === 'CLI_NOT_FOUND') return false; throw error; }
          },
        }, action.commands ?? [], signal);
        else if (action.type === 'listSkills') data = this.registry.list(action);
        else if (action.type === 'verifyWorkspace') {
          if (op.workspaceId !== this.workspaceId(work, op.namespace)) throw new LocalToolError('WORKSPACE_IDENTITY_MISMATCH');
          const root = op.workspaceId.slice('workspace:'.length);
          const currentRevision = sourceRevision(await workspaceManifest(root));
          const copyRevision = sourceRevision(await workspaceManifest(this.copyPath(work, op)));
          const matches = currentRevision === action.expectedRevision && copyRevision === action.expectedRevision;
          return { result: { ok: matches, code: matches ? 'WORKSPACE_REVISION_CONFIRMED' : 'WORKSPACE_REVISION_CHANGED',
            data: { expectedRevision: action.expectedRevision, currentRevision, copyRevision } }, settled: true, effectsKnown: true };
        }
        else if (action.type === 'loadSkill') {
          const binding = this.binding(work, action.skillId); data = await this.registry.load(binding?.skillId ?? action.skillId, binding?.skillVersion);
        }
        else {
          const binding = this.binding(work, action.skillId); if (!binding) throw new LocalToolError('SKILL_NOT_ACTIVE');
          data = await this.registry.read(binding.skillId, action.path, binding.skillVersion, action.offset);
        }
        signal.throwIfAborted();
        return { result: this.boundedResult({ ok: true, code: action.type, data: data as Record<string, unknown> }), settled: true, effectsKnown: true };
      } catch (error) {
        signal.throwIfAborted(); return { result: { ok: false, code: error instanceof LocalToolError || error instanceof CliCatalogError ? error.code : 'LOCAL_READ_FAILED', data: {} }, settled: true, effectsKnown: true };
      }
    }
    const sessionId = op.sessionId!;
    publishObservation(observe, 'local.prepareStarted');
    let prepared = false;
    const finishPreparation = () => {
      if (prepared) return;
      prepared = true;
      publishObservation(observe, 'local.prepareFinished');
    };
    if (owner) await this.ownership.register(work, op, owner);
    await this.journal.write({ operationId: op.id, sessionId, phase: 'prepared' });
    let launched = false;
    let completion: LocalExecution;
    let stdin: PreparedCliStdin | undefined;
    let invocation: (Pick<HostCommandPlan, 'executable' | 'args' | 'cwd' | 'environmentHash' | 'stdin'> & { execution: 'sandbox' | 'host' }) | undefined;
    try {
      const host = action.execution === 'host';
      if (!host && !this.backend.available) throw new LocalToolError('CLI_SANDBOX_UNAVAILABLE');
      const workspace = await this.workspace(work, op); signal.throwIfAborted();
      if (op.resourceLeases?.some(lease => lease.phase === 'prepare')) {
        if (!workspacePrepared) throw new LocalToolError('LOCAL_PREPARATION_CALLBACK_REQUIRED');
        workspacePrepared({ workspaceRevision: workspace.revision, isolated: workspace.isolated });
      }
      let skillPath: string | undefined;
      if (action.skillId) {
        const binding = this.binding(op.skillBindings ? { ...work, localSkills: op.skillBindings } : work, action.skillId);
        if (!binding) throw new LocalToolError('SKILL_NOT_ACTIVE');
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
      const env = host ? hostCliEnvironment(this.options.commandEnv?.[action.executable], this.options.redact)
        : minimalCliEnvironment(workspace.path, this.options.commandEnv?.[action.executable]);
      const executable = await resolveExecutable(await expand(action.executable), env);
      const args = await Promise.all(action.args.map(expand));
      const environmentHash = digest(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))));
      if (action.stdin) stdin = await prepareCliStdin(workspace.path, action.stdin, this.options.dataRoot, signal);
      invocation = { executable, args, cwd, execution: host ? 'host' : 'sandbox', environmentHash, ...(stdin ? { stdin: stdin.plan } : {}) };
      if (stdin && repeatedCliFailures(work, action, { ...stdin.plan, environmentHash }) >= 2) throw new LocalToolError('CLI_REPEAT_FAILURE_LIMIT');
      if (host) {
        const plan: HostCommandPlan = { executable, args, cwd, workspaceRevision: digest(JSON.stringify(await workspaceManifest(workspace.path))),
          executableHash: await executableDigest(executable, signal), environmentHash,
          ...hostIdentity(), reason: action.reason!, ...(stdin ? { stdin: stdin.plan } : {}) };
        const commandDigest = digest(JSON.stringify({ plan, action, requestHash: op.requestHash, workId: work.id, epoch: work.epoch, goalVersion: work.goalVersion }));
        const now = (this.options.clock ?? Date.now)();
        if (!op.approval) {
          const approval: HostApproval = { id: randomUUID(), digest: commandDigest, plan, status: 'pending', expiresAt: Math.min(now + 600_000, work.deadline ?? Infinity, op.deadline ?? Infinity) };
          const prepared = { result: { ok: false, code: 'HOST_APPROVAL_REQUIRED', data: {} }, settled: true, effectsKnown: true };
          await this.journal.write({ operationId: op.id, sessionId, phase: 'settled', completion: prepared });
          finishPreparation();
          return { ...prepared, approval };
        }
        if (op.approval.status !== 'approved') throw new LocalToolError('HOST_APPROVAL_REQUIRED');
        if (now >= op.approval.expiresAt) throw new LocalToolError('HOST_APPROVAL_EXPIRED');
        if (op.approval.digest !== commandDigest) throw new LocalToolError('HOST_APPROVAL_STALE');
      }
      const deadline = Math.min(work.deadline ?? Infinity, op.deadline ?? Infinity);
      const remaining = deadline === Infinity ? maximumTimeoutMs : deadline - (this.options.clock ?? Date.now)();
      const timeoutMs = Math.min(action.timeoutMs ?? this.options.commandTimeoutMs ?? maximumTimeoutMs, Math.max(1, remaining));
      if (work.kind === 'check') for (const dir of validationOutputs) await mkdir(join(workspace.path, dir), { recursive: true });
      const baseline = new Map((await workspaceManifest(workspace.path)).map(file => [file.path, file.hash]));
      const markStarted = () => {
        signal.throwIfAborted();
        started({ workspaceRevision: workspace.revision, isolated: workspace.isolated });
        launched = true;
      };
      const execute: typeof runProcess = host ? runProcess : (input, executionSignal, onSpawn) => {
        markStarted(); return this.backend.execute(input, executionSignal, onSpawn);
      };
      finishPreparation();
      const result = await execute({ executable, args, cwd, ...(stdin ? { stdinFd: stdin.file.fd } : {}), workspace: workspace.path, ...(skillPath ? { skillPath } : {}), env, timeoutMs, sessionId, redact: this.secrets(),
        ...(observe ? { observeProcess: observe } : {}),
        ...(work.kind === 'check' ? { writeRoots: [...validationOutputs, '.home', '.tmp'].map(dir => join(workspace.path, dir)) } : {}),
        logPath: join(this.options.dataRoot, 'logs', `${digest(sessionId)}.log`) }, signal,
        async identity => { await this.journal.write({ operationId: op.id, sessionId, phase: 'spawned', identity }); }, markStarted);
      let outputFiles: Awaited<ReturnType<typeof workspaceManifest>> = [], outputFilesTruncated = false;
      try { const changed = (await workspaceManifest(workspace.path)).filter(file => baseline.get(file.path) !== file.hash); outputFiles = changed.slice(0, 100); outputFilesTruncated = changed.length > 100; } catch { outputFilesTruncated = true; }
      const validationInputsChanged = work.kind === 'check' ? sourceRevision(await workspaceManifest(workspace.path)) !== workspace.revision : null;
      // A terminated sandbox may have written files. Their bounded content fingerprint makes the effect
      // observable; it is still not a proof of arbitrary network effects (network is denied by default).
      completion = { ...result, result: attachCapturedEvidence(this.boundedResult({ ...result.result, ...(validationInputsChanged ? { ok: false, code: 'CHECK_INPUTS_CHANGED' } : {}), data: { ...result.result.data, workspaceRevision: workspace.revision, isolated: workspace.isolated,
        outputFiles, outputFilesTruncated, validationInputsChanged, invocation, execution: host ? 'host' : 'sandbox' } })), workspaceRevision: workspace.revision, isolated: workspace.isolated };
    } catch (error) {
      finishPreparation();
      completion = { result: this.boundedResult({ ok: false, code: signal.aborted ? 'cancelled' : error instanceof LocalToolError ? error.code : 'CLI_EXECUTION_FAILED',
        data: launched && invocation ? { invocation } : {} }), settled: !launched, effectsKnown: !launched };
    } finally { await stdin?.file.close(); }
    await this.journal.write({ operationId: op.id, sessionId, phase: 'settled', completion });
    return completion;
  }
  private binding(work: Intent, id: string): SkillBinding | undefined {
    const exact = work.localSkills?.find(s => s.skillId === id); if (exact) return exact;
    try { const canonical = this.registry.resolveId(id); return work.localSkills?.find(s => s.skillId === canonical); } catch { return undefined; }
  }
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
    await this.inventory.close();
    await Promise.allSettled([...this.legacyPhysicalJobs, ...[...this.physicalJobs.values()].flatMap(jobs => [...jobs])]);
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
