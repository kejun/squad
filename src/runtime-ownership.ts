import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digest, LocalToolError } from './local-skills.js';
import type { LocalOperation } from './local-operation.js';
import { localPhysicalPending } from './local-operation.js';
import type { Intent, Phase, TaskContext } from './types.js';
import { validRuntimeAsset, validRuntimeOwner, type DeletionBlocker, type RuntimeAssetOwner,
  type RuntimeCleanupAsset, type RuntimeCleanupInventory, type RuntimeOperationOwner } from './room-deletion.machine.js';

export interface RoomCleanupInput {
  roomId: string; tasks: { phase: Phase; context: TaskContext }[];
  previous?: RuntimeCleanupInventory; databaseErased?: boolean; quiescent: boolean;
}
export interface ClaimedRuntimeCleanup {
  roomId: string; deletionId: string; intentId: string; attempt: number; asset: RuntimeCleanupAsset;
}
interface OwnershipRecord {
  version: 1; owner: RuntimeOperationOwner; isolated: boolean; taskWorkspace: boolean; createdAt: number;
}
export const runtimeNamespace = (roomId: string, taskId: string) => digest(JSON.stringify({ roomId, taskId }));
const taskOwner = (owner: RuntimeAssetOwner): RuntimeAssetOwner => ({ roomId: owner.roomId, taskId: owner.taskId, namespace: owner.namespace });
const assetId = (path: string) => `asset:${digest(path)}`;
function ownedAsset(asset: RuntimeCleanupAsset): boolean {
  if (!validRuntimeAsset(asset) || asset.id !== assetId(asset.path)
    || asset.owner.namespace !== runtimeNamespace(asset.owner.roomId, asset.owner.taskId)) return false;
  const owner = asset.owner, session = owner.sessionId ? digest(owner.sessionId) : '';
  const expected: Record<RuntimeCleanupAsset['kind'], string[]> = {
    workspace: [`workspaces/${owner.namespace}`],
    copy: [`copies/${digest(`${owner.namespace}:${owner.workId}`)}`],
    copyMarker: [`copies/${digest(`${owner.namespace}:${owner.workId}`)}.json`],
    journal: [`sessions/${session}.json`], journalPending: [`sessions/${session}.json.pending`],
    log: [`logs/${session}.log`], ownership: [`ownership/${session}.json`, `ownership/${session}.json.pending`],
  };
  return expected[asset.kind].includes(asset.path);
}
const identity = (stat: Awaited<ReturnType<typeof lstat>>) => digest(JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino),
  mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs }));
function planned(record: OwnershipRecord): Omit<RuntimeCleanupAsset, 'identity' | 'status'>[] {
  const owner = record.owner, session = digest(owner.sessionId);
  const assets: { kind: RuntimeCleanupAsset['kind']; path: string; owner: RuntimeAssetOwner }[] = [];
  if (record.taskWorkspace) assets.push({ kind: 'workspace', path: `workspaces/${owner.namespace}`, owner: taskOwner(owner) });
  if (record.isolated) {
    const copy = digest(`${owner.namespace}:${owner.workId}`);
    assets.push({ kind: 'copy', path: `copies/${copy}`, owner: { ...taskOwner(owner), workId: owner.workId } },
      { kind: 'copyMarker', path: `copies/${copy}.json`, owner: { ...taskOwner(owner), workId: owner.workId } });
  }
  assets.push({ kind: 'journal', path: `sessions/${session}.json`, owner },
    { kind: 'journalPending', path: `sessions/${session}.json.pending`, owner },
    { kind: 'log', path: `logs/${session}.log`, owner },
    { kind: 'ownership', path: `ownership/${session}.json`, owner },
    { kind: 'ownership', path: `ownership/${session}.json.pending`, owner });
  return assets.map(asset => ({ ...asset, id: assetId(asset.path) }));
}
function validRecord(value: unknown): value is OwnershipRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as OwnershipRecord;
  return record.version === 1 && validRuntimeOwner(record.owner)
    && record.owner.namespace === runtimeNamespace(record.owner.roomId, record.owner.taskId)
    && typeof record.isolated === 'boolean' && typeof record.taskWorkspace === 'boolean'
    && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0;
}
async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

/** File ownership is registered before preparation. Only claimed deletion intents may consume it. */
export class RuntimeOwnership {
  constructor(private readonly root: string, private readonly sourceRoot?: string, private readonly clock: () => number = Date.now) {}
  private async parent(path: string) {
    const folder = join(this.root, path.split('/')[0]!);
    const stat = await optionalStat(folder);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new LocalToolError('RUNTIME_CLEANUP_PARENT_INVALID');
  }
  private staged(path: string) { return join(this.root, 'cleanup', `${digest(path)}.data`); }
  async register(work: Intent, op: LocalOperation, owner: { roomId: string; taskId: string }) {
    if (op.action.type !== 'runCli') return;
    const binding: RuntimeOperationOwner = { ...owner, namespace: op.namespace, workId: work.id,
      operationId: op.id, parentAttempt: op.parentAttempt, attempt: op.attempt, sessionId: op.sessionId! };
    if (!validRuntimeOwner(binding) || binding.namespace !== runtimeNamespace(owner.roomId, owner.taskId)) throw new LocalToolError('OWNERSHIP_NAMESPACE_MISMATCH');
    const record: OwnershipRecord = { version: 1, owner: binding, isolated: work.kind === 'check' || !!work.discussionId,
      taskWorkspace: !this.sourceRoot, createdAt: this.clock() };
    await this.parent('ownership/x');
    await mkdir(join(this.root, 'ownership'), { recursive: true, mode: 0o700 });
    const path = join(this.root, 'ownership', `${digest(binding.sessionId)}.json`);
    const old = await optionalStat(path);
    if (old) {
      if (!old.isFile() || old.isSymbolicLink()) throw new LocalToolError('OWNERSHIP_RECORD_INVALID');
      const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!validRecord(saved) || JSON.stringify(saved.owner) !== JSON.stringify(binding)) throw new LocalToolError('OWNERSHIP_SESSION_CONFLICT');
      return;
    }
    const handle = await open(`${path}.pending`, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(`${path}.pending`, path); await syncDirectory(dirname(path));
  }
  private blocker(blockers: DeletionBlocker[], id: string, reason: string, human = true, kind: DeletionBlocker['kind'] = 'ownership') {
    if (!blockers.some(blocker => blocker.id === id)) blockers.push({ id, kind, reason, human });
  }
  private async names(folder: string) {
    await this.parent(`${folder}/x`);
    try { return await readdir(join(this.root, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async inventory(input: RoomCleanupInput): Promise<RuntimeCleanupInventory> {
    const blockers: DeletionBlocker[] = [];
    if (!input.quiescent) this.blocker(blockers, 'room-executions', '会话的执行、取消或等待器尚未全部退役', false, 'execution');
    const tasks = input.tasks.map(({ phase, context }) => ({ taskId: context.taskId, namespace: runtimeNamespace(input.roomId, context.taskId),
      phase, outcome: context.outcome, workIds: context.intents.map(work => work.id),
      operationIds: context.intents.flatMap(work => work.localOperations?.map(op => op.id) ?? []) }));
    if (!tasks.length && input.databaseErased && input.previous?.complete && input.previous.executionsSettled)
      tasks.push(...structuredClone(input.previous.tasks));
    const sessions = new Map<string, RuntimeOperationOwner>();
    const records = new Map<string, OwnershipRecord>();
    const globalRecords = new Map<string, OwnershipRecord>();
    const candidates = new Map<string, Omit<RuntimeCleanupAsset, 'identity' | 'status'>>();
    const add = (asset: Omit<RuntimeCleanupAsset, 'identity' | 'status'>) => {
      const existing = candidates.get(asset.path);
      if (existing && (existing.owner.roomId !== asset.owner.roomId || existing.owner.namespace !== asset.owner.namespace))
        this.blocker(blockers, `conflict:${asset.id}`, '资源所有权声明冲突');
      else candidates.set(asset.path, asset);
    };
    const addRecord = (record: OwnershipRecord) => {
      if (record.owner.roomId !== input.roomId) return;
      if (!tasks.some(task => task.taskId === record.owner.taskId && task.namespace === record.owner.namespace)) {
        this.blocker(blockers, `task-missing:${digest(record.owner.taskId)}`, '所有权记录指向缺失的历史任务'); return;
      }
      sessions.set(record.owner.sessionId, record.owner); records.set(record.owner.sessionId, record);
      for (const asset of planned(record)) add(asset);
    };
    for (const { context } of input.tasks) for (const work of context.intents) {
      if (work.kind !== 'cancel' && ['inflight', 'uncertain'].includes(work.status) || localPhysicalPending(work))
        this.blocker(blockers, `work:${digest(work.id)}`, '历史工作或物理效果尚未结算', false, 'effects');
      const namespace = runtimeNamespace(input.roomId, context.taskId);
      if (!this.sourceRoot) add({ id: assetId(`workspaces/${namespace}`), kind: 'workspace', path: `workspaces/${namespace}`,
        owner: { roomId: input.roomId, taskId: context.taskId, namespace } });
      if (work.kind === 'check' || work.discussionId) {
        const copy = digest(`${namespace}:${work.id}`), owner = { roomId: input.roomId, taskId: context.taskId, namespace, workId: work.id };
        add({ id: assetId(`copies/${copy}`), kind: 'copy', path: `copies/${copy}`, owner });
        add({ id: assetId(`copies/${copy}.json`), kind: 'copyMarker', path: `copies/${copy}.json`, owner });
      }
      for (const op of work.localOperations ?? []) if (op.sessionId && op.action.type === 'runCli') {
        addRecord({ version: 1, owner: { roomId: input.roomId, taskId: context.taskId, namespace, workId: work.id,
          operationId: op.id, parentAttempt: op.parentAttempt, attempt: op.attempt, sessionId: op.sessionId },
          isolated: work.kind === 'check' || !!work.discussionId, taskWorkspace: !this.sourceRoot, createdAt: op.createdAt });
      }
    }
    for (const owner of input.previous?.sessions ?? []) if (validRuntimeOwner(owner))
      addRecord({ version: 1, owner, isolated: false, taskWorkspace: false, createdAt: 0 });
    for (const asset of input.previous?.assets ?? []) if (validRuntimeAsset(asset) && asset.owner.roomId === input.roomId) add(asset);

    for (const name of await this.names('ownership')) {
      if (!/^[a-f0-9]{64}\.json(?:\.pending)?$/.test(name)) { this.blocker(blockers, `owner-name:${digest(name)}`, '运行时存在不能识别归属的所有权文件'); continue; }
      const path = join(this.root, 'ownership', name), stat = await optionalStat(path);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) { this.blocker(blockers, `owner-file:${digest(name)}`, '所有权记录类型或大小无效'); continue; }
      let record: unknown;
      try { record = JSON.parse(await readFile(path, 'utf8')); } catch { record = undefined; }
      if (!validRecord(record) || name.slice(0, 64) !== digest(record.owner.sessionId)) {
        if (![...sessions.keys()].some(session => digest(session) === name.slice(0, 64)))
          this.blocker(blockers, `owner-record:${digest(name)}`, '历史所有权记录未能可靠归属');
        continue;
      }
      globalRecords.set(digest(record.owner.sessionId), record); addRecord(record);
    }
    const knownSessionHashes = new Set([...sessions.keys()].map(session => digest(session)));
    const operations = new Set(tasks.flatMap(task => task.operationIds));
    for (const name of await this.names('sessions')) {
      if (!/^[a-f0-9]{64}\.json(?:\.pending)?$/.test(name)) { this.blocker(blockers, `session-name:${digest(name)}`, '会话日志存在未知归属项'); continue; }
      const key = name.slice(0, 64);
      if (knownSessionHashes.has(key) || globalRecords.has(key)) continue;
      const path = join(this.root, 'sessions', name), stat = await optionalStat(path);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000) {
        this.blocker(blockers, `session-type:${key}`, '历史会话日志不能可靠核对'); continue;
      }
      try {
        const value = JSON.parse(await readFile(path, 'utf8')) as { operationId?: unknown };
        if (typeof value.operationId !== 'string' || operations.has(value.operationId))
          this.blocker(blockers, `legacy-session:${key}`, '旧会话日志缺少唯一的room和session所有权');
      } catch { this.blocker(blockers, `legacy-session:${key}`, '旧会话日志内容无效且归属不明'); }
    }
    for (const name of await this.names('logs')) if (/^[a-f0-9]{64}\.log$/.test(name)) {
      const key = name.slice(0, 64);
      if (!knownSessionHashes.has(key) && !globalRecords.has(key)) this.blocker(blockers, `legacy-log:${key}`, '历史执行日志缺少可验证的会话所有权');
    } else this.blocker(blockers, `log-name:${digest(name)}`, '运行时存在未知归属日志');

    const assets: RuntimeCleanupAsset[] = [];
    for (const asset of candidates.values()) {
      if (!ownedAsset({ ...asset, identity: null, status: 'pending' })) {
        this.blocker(blockers, `asset:${asset.id}`, '清理清单路径或所有权无效'); continue;
      }
      try {
        await this.parent(asset.path); await this.parent('cleanup/x');
        const direct = await optionalStat(join(this.root, asset.path)), staged = await optionalStat(this.staged(asset.path));
        if (direct && staged) { this.blocker(blockers, `staged:${asset.id}`, '原资源与清理暂存项同时存在，需核对'); continue; }
        const stat = direct ?? staged;
        if (stat?.isSymbolicLink()) { this.blocker(blockers, `link:${asset.id}`, '清理目标是符号链接，未删除'); continue; }
        assets.push({ ...asset, identity: stat ? identity(stat) : null, status: 'pending' });
      } catch (error) { this.blocker(blockers, `boundary:${asset.id}`, error instanceof LocalToolError ? error.code : '清理路径核对失败'); }
    }
    const order: Record<RuntimeCleanupAsset['kind'], number> = { workspace: 0, copy: 1, copyMarker: 2, log: 3, journalPending: 4, journal: 5, ownership: 6 };
    assets.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));
    return { tasks, sessions: [...sessions.values()], assets, blockers,
      complete: !blockers.some(blocker => ['ownership', 'dependency'].includes(blocker.kind)),
      executionsSettled: !blockers.some(blocker => ['execution', 'effects'].includes(blocker.kind)) };
  }
  async remove(claim: ClaimedRuntimeCleanup, signal: AbortSignal) {
    signal.throwIfAborted();
    const asset = claim.asset;
    if (!claim.deletionId || !claim.intentId || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1
      || !ownedAsset(asset) || asset.owner.roomId !== claim.roomId) throw new LocalToolError('RUNTIME_CLEANUP_IDENTITY_MISMATCH');
    await this.parent(asset.path); await this.parent('cleanup/x');
    const path = join(this.root, asset.path), stage = this.staged(asset.path);
    let direct = await optionalStat(path), staged = await optionalStat(stage);
    if (direct && staged) throw new LocalToolError('RUNTIME_CLEANUP_CONFLICT');
    if (!direct && !staged) return { assetId: asset.id, identityVerified: true as const, result: 'absent' as const };
    const observed = direct ?? staged!;
    if (observed.isSymbolicLink() || asset.identity === null || identity(observed) !== asset.identity) throw new LocalToolError('RUNTIME_CLEANUP_CHANGED');
    if (direct) {
      await mkdir(dirname(stage), { recursive: true, mode: 0o700 }); signal.throwIfAborted();
      await rename(path, stage); await syncDirectory(dirname(path)); await syncDirectory(dirname(stage));
      staged = await optionalStat(stage); direct = undefined;
      if (!staged || staged.isSymbolicLink() || identity(staged) !== asset.identity) throw new LocalToolError('RUNTIME_CLEANUP_CHANGED');
    }
    signal.throwIfAborted();
    await rm(stage, { recursive: true, force: true }); await syncDirectory(dirname(stage));
    return { assetId: asset.id, identityVerified: true as const, result: 'deleted' as const };
  }
  async verify(inventory: RuntimeCleanupInventory) {
    if (!inventory.complete || !inventory.executionsSettled || inventory.blockers.length) return false;
    for (const asset of inventory.assets) {
      if (!ownedAsset(asset)
        || !inventory.tasks.some(task => task.taskId === asset.owner.taskId && task.namespace === asset.owner.namespace)
        || (asset.owner.sessionId !== undefined && !inventory.sessions.some(owner => owner.roomId === asset.owner.roomId
          && owner.taskId === asset.owner.taskId && owner.namespace === asset.owner.namespace && owner.workId === asset.owner.workId
          && owner.operationId === asset.owner.operationId && owner.sessionId === asset.owner.sessionId))) return false;
      try {
        await this.parent(asset.path); await this.parent('cleanup/x');
        if (await optionalStat(join(this.root, asset.path)) || await optionalStat(this.staged(asset.path))) return false;
      } catch { return false; }
    }
    return true;
  }
}
