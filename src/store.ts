import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canAcquireResourceLeases, resourceLeaseBlockerOwners, unconfinedEffectsKey, type ResourceLease, type ResourceLeaseRow } from './local-resource-policy.js';
import { restoreRoomArchive, type RoomArchive } from './room.machine.js';
import type { ExecutionLease } from './coordination-view.js';
import { initialRoomDeletion, persistRoomDeletion, restoreRoomDeletion, stepRoomDeletion,
  type RoomDeletionEvent, type SavedRoomDeletion } from './room-deletion.machine.js';

export interface RoomData {
  schemaVersion: 1; activeTaskId: string | null;
  tasks: Record<string, unknown>; notices: { id: string; text: string }[];
  archive?: RoomArchive;
}
export interface Transaction {
  room: RoomData;
  receipt(id: string): { fingerprint: string; result: unknown } | undefined;
  remember(id: string, fingerprint: string, result: unknown): void;
  /** Global across rooms; held until a confirmed child-operation settlement. */
  acquireWorkspace(key: string, owner: string): boolean;
  releaseWorkspace(key: string, owner: string): void;
  acquireResources?(leases: ResourceLease[], owner: string): boolean;
  releaseResources?(keys: string[], owner: string, phase?: ResourceLease['phase']): void;
}
export interface Store {
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T;
  read(roomId: string): RoomData;
  /** Read-only observation. Only a transactional acquisition grants execution. */
  resourceBlockers?(workspaceId: string, owner: string, requests?: ResourceLease[]): string[];
  leaseInventory?(): ExecutionLease[];
  close(): void;
}
export class RoomDeletionError extends Error {
  constructor(readonly code: string, readonly roomId: string) { super(code); this.name = 'RoomDeletionError'; }
}
export type DeletionSettlementProof =
  | { deletionId: string; intentId: string; attempt: number }
  | { deletionId: string; taskId: string; workId: string; operationId?: string; sessionId?: string; attempt?: number };
export interface DeletionStore extends Store {
  readDeletion(roomId: string): SavedRoomDeletion | undefined;
  listDeletions(): SavedRoomDeletion[];
  stepDeletion(roomId: string, event: RoomDeletionEvent): SavedRoomDeletion;
  transactDeletionSettlement<T>(roomId: string, proof: DeletionSettlementProof, fn: (tx: Transaction) => T): T;
  eraseDeletionData(roomId: string, event: Extract<RoomDeletionEvent, { type: 'DATA_ERASED' }>): SavedRoomDeletion;
  finishRoomDeletion(roomId: string, event: Extract<RoomDeletionEvent, { type: 'VERIFIED' }>): SavedRoomDeletion;
  verifyDeletionDataGone(roomId: string): boolean;
  deletionLeases(roomId: string): { key: string; owner: string }[];
}
export function deletionStore(store: Store): DeletionStore {
  if (!('readDeletion' in store) || !('stepDeletion' in store)) throw new RoomDeletionError('ROOM_DELETION_UNAVAILABLE', '');
  return store as DeletionStore;
}
export const roomTaskNamespace = (roomId: string, taskId: string) => createHash('sha256').update(JSON.stringify({ roomId, taskId })).digest('hex');
export function operationLeaseOwner(roomId: string, taskId: string, operationId: string) {
  return createHash('sha256').update(JSON.stringify({ operationId, roomId, taskId })).digest('hex');
}
/** Pre-resource snapshots still quarantine unknown adapter effects across rooms. */
function unsafeWorkBarriers(rooms: [string, RoomData][], requester: string): { key: string; owner: string }[] {
  return rooms.flatMap(([roomId, room]) => Object.entries(room.tasks).flatMap(([taskId, value]) => {
    const intents = (value as { snapshot?: { context?: { intents?: { id: string; kind: string; replay: string; status: string; localOperations?: { id: string }[] }[] } } })?.snapshot?.context?.intents ?? [];
    return intents.filter(work => work.kind !== 'cancel' && work.replay === 'unsafe' && ['inflight', 'uncertain'].includes(work.status)).map(work => {
      const ownsChild = work.status === 'inflight' && work.localOperations?.some(op => operationLeaseOwner(roomId, taskId, op.id) === requester);
      return { key: unconfinedEffectsKey, owner: ownsChild ? requester : operationLeaseOwner(roomId, taskId, work.id) };
    });
  }));
}
function ownedLeaseIds(saved: SavedRoomDeletion | undefined, room: RoomData): Set<string> {
  const ids = new Set(saved?.context.tasks.flatMap(task => task.operationIds.map(id => operationLeaseOwner(saved.context.roomId, task.taskId, id))) ?? []);
  if (saved) for (const task of saved.context.allTasks) {
    const record = room.tasks[task.taskId] as { snapshot?: { context?: { intents?: { localOperations?: { id: string }[] }[] } } } | undefined;
    for (const work of record?.snapshot?.context?.intents ?? []) for (const op of work.localOperations ?? [])
      ids.add(operationLeaseOwner(saved.context.roomId, task.taskId, op.id));
  }
  return ids;
}
function assertBarrier(saved: SavedRoomDeletion | undefined, roomId: string) {
  if (saved && saved.value !== 'idle') throw new RoomDeletionError(saved.value === 'deleted' ? 'ROOM_DELETED' : 'ROOM_DELETING', roomId);
}
function assertSettlement(saved: SavedRoomDeletion | undefined, room: RoomData, roomId: string, proof: DeletionSettlementProof) {
  if (!saved || saved.value === 'deleted' || saved.context.deletionId !== proof.deletionId) throw new RoomDeletionError('STALE_DELETION', roomId);
  // Once erased, only the independent deletion job may advance. A late business
  // settlement or repeated preparation must never recreate room data or receipts.
  if (saved.context.dataErased) throw new RoomDeletionError('DELETION_DATA_ERASED', roomId);
  if ('intentId' in proof) {
    if (!saved.context.intents.some(intent => intent.id === proof.intentId && intent.kind === 'prepare'
      && intent.status === 'claimed' && intent.attempt === proof.attempt)) throw new RoomDeletionError('DELETION_INTENT_NOT_CLAIMED', roomId);
    return;
  }
  if (!saved.context.allTasks.some(task => task.taskId === proof.taskId)) throw new RoomDeletionError('DELETION_TASK_NOT_OWNED', roomId);
  const record = room.tasks[proof.taskId] as { snapshot?: { context?: { intents?: { id: string; attempt: number;
    localOperations?: { id: string; sessionId?: string }[] }[] } } } | undefined;
  const work = record?.snapshot?.context?.intents?.find(item => item.id === proof.workId);
  if (!work || proof.attempt !== undefined && work.attempt !== proof.attempt) throw new RoomDeletionError('DELETION_WORK_NOT_OWNED', roomId);
  if (proof.operationId) {
    const op = work.localOperations?.find(item => item.id === proof.operationId);
    if (!op || proof.sessionId !== undefined && op.sessionId !== proof.sessionId) throw new RoomDeletionError('DELETION_OPERATION_NOT_OWNED', roomId);
  }
}
function transitionDeletion(roomId: string, room: RoomData, saved: SavedRoomDeletion | undefined, event: RoomDeletionEvent): SavedRoomDeletion {
  const current = saved ? restoreRoomDeletion(saved) : initialRoomDeletion({ roomId });
  if (event.type === 'REQUEST' && (!saved || event.force && !saved.context.dataErased)) {
    const request = event;
    const archive = restoreRoomArchive(room.archive);
    const tasks = Object.keys(room.tasks);
    if (request.allTasks.length !== tasks.length || !tasks.every(taskId => request.allTasks.some(task => task.taskId === taskId
      && task.namespace === roomTaskNamespace(roomId, taskId)))) {
      return persistRoomDeletion({ ...current, context: { ...current.context,
        reply: { ok: false, code: 'DELETION_INVENTORY_CONFLICT', detail: '完整任务清单已变化' } } });
    }
    event = { ...event, archived: archive.value === 'archived', archiveVersion: archive.context.revision };
  }
  return persistRoomDeletion(stepRoomDeletion(current, event));
}
const empty = (): RoomData => ({ schemaVersion: 1, activeTaskId: null, tasks: {}, notices: [] });

function resourceBlockers(rows: ResourceLeaseRow[], legacy: { key: string; owner: string }[], barriers: { key: string; owner: string }[],
  workspaceId: string, owner: string, requests?: ResourceLease[]): string[] {
  if (requests?.length) return resourceLeaseBlockerOwners(rows, requests, owner, [...legacy, ...barriers]);
  // Legacy workspace claims predate typed read/write leases and remain exclusive.
  return [...new Set([
    ...barriers.filter(row => row.owner !== owner),
    ...legacy.filter(row => row.key === workspaceId && row.owner !== owner),
    ...rows.filter(row => (row.key === workspaceId || row.key === unconfinedEffectsKey) && row.owner !== owner),
  ].map(row => row.owner))];
}

/** One SQLite transaction commits snapshot, outbox, public messages and receipt together. */
export class SqliteStore implements DeletionStore {
  private readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  failNextCommit = false;
  constructor(database: string | DatabaseSync) {
    this.ownsDatabase = typeof database === 'string';
    this.db = typeof database === 'string' ? new DatabaseSync(database) : database;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS workspace_leases(key TEXT PRIMARY KEY, owner TEXT NOT NULL);');
    this.db.exec("CREATE TABLE IF NOT EXISTS resource_leases(key TEXT NOT NULL,owner TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('read','write')),phase TEXT NOT NULL CHECK(phase IN ('prepare','execute')),PRIMARY KEY(key,owner,phase));");
    this.db.exec('CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(room_id TEXT, id TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room_id,id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS room_deletions(room_id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  }
  read(roomId: string): RoomData {
    const row = this.db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId) as { data: string } | undefined;
    const data = row ? JSON.parse(row.data) as RoomData : empty();
    if (data.schemaVersion !== 1) throw new Error('Unsupported storage schema');
    return data;
  }
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    return this.transactRoom(roomId, fn);
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected commit failure'); }
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private transactRoom<T>(roomId: string, fn: (tx: Transaction) => T, proof?: DeletionSettlementProof): T {
    return this.atomic(() => {
      const room = this.read(roomId);
      const deletion = this.readDeletion(roomId);
      if (proof) assertSettlement(deletion, room, roomId, proof); else assertBarrier(deletion, roomId);
      const tx: Transaction = {
        room,
        receipt: id => {
          const row = this.db.prepare('SELECT fingerprint,result FROM receipts WHERE room_id=? AND id=?').get(roomId, id) as { fingerprint: string; result: string } | undefined;
          return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) as unknown } : undefined;
        },
        acquireWorkspace: (key, owner) => {
          if (this.unsafeWorkBarriers(owner).some(row => row.owner !== owner)) return false;
          if (this.db.prepare('SELECT 1 FROM resource_leases WHERE (key=? OR key=?) AND owner<>?').get(key, unconfinedEffectsKey, owner)) return false;
          this.db.prepare('INSERT OR IGNORE INTO workspace_leases(key,owner) VALUES(?,?)').run(key, owner);
          return (this.db.prepare('SELECT owner FROM workspace_leases WHERE key=?').get(key) as { owner: string }).owner === owner;
        },
        releaseWorkspace: (key, owner) => { this.db.prepare('DELETE FROM workspace_leases WHERE key=? AND owner=?').run(key, owner); },
        acquireResources: (leases, owner) => {
          const rows = this.db.prepare('SELECT key,owner,mode,phase FROM resource_leases').all() as unknown as ResourceLeaseRow[];
          const legacy = [...this.db.prepare('SELECT key,owner FROM workspace_leases').all() as { key: string; owner: string }[], ...this.unsafeWorkBarriers(owner)];
          if (!canAcquireResourceLeases(rows, leases, owner, legacy)) return false;
          for (const lease of leases) this.db.prepare("INSERT INTO resource_leases(key,owner,mode,phase) VALUES(?,?,?,?) ON CONFLICT(key,owner,phase) DO UPDATE SET mode=CASE WHEN resource_leases.mode='write' OR excluded.mode='write' THEN 'write' ELSE 'read' END")
            .run(lease.key, owner, lease.mode, lease.phase);
          return true;
        },
        releaseResources: (keys, owner, phase) => {
          for (const key of keys) if (phase) this.db.prepare('DELETE FROM resource_leases WHERE key=? AND owner=? AND phase=?').run(key, owner, phase);
          else this.db.prepare('DELETE FROM resource_leases WHERE key=? AND owner=?').run(key, owner);
        },
        remember: (id, fingerprint, result) => { this.db.prepare('INSERT INTO receipts(room_id,id,fingerprint,result) VALUES(?,?,?,?)').run(roomId, id, fingerprint, JSON.stringify(result)); },
      };
      const result = fn(tx);
      this.db.prepare('INSERT INTO rooms(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(roomId, JSON.stringify(room));
      return result;
    });
  }
  private unsafeWorkBarriers(owner: string) {
    return unsafeWorkBarriers((this.db.prepare('SELECT id,data FROM rooms').all() as { id: string; data: string }[]).map(row => [row.id, JSON.parse(row.data) as RoomData]), owner);
  }
  resourceBlockers(workspaceId: string, owner: string, requests?: ResourceLease[]): string[] {
    const rows = this.db.prepare('SELECT key,owner,mode,phase FROM resource_leases').all() as unknown as ResourceLeaseRow[];
    const legacy = this.db.prepare('SELECT key,owner FROM workspace_leases').all() as { key: string; owner: string }[];
    return resourceBlockers(rows, legacy, this.unsafeWorkBarriers(owner), workspaceId, owner, requests);
  }
  leaseInventory(): ExecutionLease[] {
    return [
      ...(this.db.prepare('SELECT key,owner,mode,phase FROM resource_leases').all() as unknown as ResourceLeaseRow[]).map(row => ({ ...row, kind: 'typed' as const })),
      ...(this.db.prepare('SELECT key,owner FROM workspace_leases').all() as { key: string; owner: string }[])
        .map(row => ({ ...row, mode: 'write' as const, phase: 'execute' as const, kind: 'workspace' as const })),
      ...this.unsafeWorkBarriers('').map(row => ({ ...row, mode: 'write' as const, phase: 'execute' as const, kind: 'legacyWork' as const })),
    ];
  }
  readDeletion(roomId: string): SavedRoomDeletion | undefined {
    const row = this.db.prepare('SELECT data FROM room_deletions WHERE room_id=?').get(roomId) as { data: string } | undefined;
    return row ? persistRoomDeletion(restoreRoomDeletion(JSON.parse(row.data) as SavedRoomDeletion)) : undefined;
  }
  listDeletions(): SavedRoomDeletion[] {
    return (this.db.prepare('SELECT room_id FROM room_deletions ORDER BY rowid').all() as { room_id: string }[])
      .map(row => this.readDeletion(row.room_id)!);
  }
  private saveDeletion(roomId: string, saved: SavedRoomDeletion) {
    if (saved.value !== 'idle') this.db.prepare('INSERT INTO room_deletions(room_id,data) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET data=excluded.data')
      .run(roomId, JSON.stringify(saved));
  }
  stepDeletion(roomId: string, event: RoomDeletionEvent): SavedRoomDeletion {
    if (event.type === 'DATA_ERASED') return this.eraseDeletionData(roomId, event);
    if (event.type === 'VERIFIED') return this.finishRoomDeletion(roomId, event);
    return this.atomic(() => {
      const saved = transitionDeletion(roomId, this.read(roomId), this.readDeletion(roomId), event);
      this.saveDeletion(roomId, saved); return saved;
    });
  }
  transactDeletionSettlement<T>(roomId: string, proof: DeletionSettlementProof, fn: (tx: Transaction) => T): T {
    return this.transactRoom(roomId, fn, proof);
  }
  private hasTable(table: string) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
  private removeRoomData(roomId: string) {
    this.db.prepare('DELETE FROM receipts WHERE room_id=?').run(roomId);
    this.db.prepare('DELETE FROM rooms WHERE id=?').run(roomId);
    if (this.hasTable('web_rooms')) this.db.prepare('DELETE FROM web_rooms WHERE id=?').run(roomId);
    if (this.hasTable('web_events')) this.db.prepare('DELETE FROM web_events WHERE roomId=?').run(roomId);
  }
  deletionLeases(roomId: string): { key: string; owner: string }[] {
    const owners = ownedLeaseIds(this.readDeletion(roomId), this.read(roomId));
    return (this.db.prepare('SELECT key,owner FROM workspace_leases UNION ALL SELECT key,owner FROM resource_leases').all() as { key: string; owner: string }[]).filter(row => owners.has(row.owner));
  }
  eraseDeletionData(roomId: string, event: Extract<RoomDeletionEvent, { type: 'DATA_ERASED' }>): SavedRoomDeletion {
    return this.atomic(() => {
      const saved = this.readDeletion(roomId);
      if (!saved) throw new RoomDeletionError('STALE_DELETION', roomId);
      const next = persistRoomDeletion(stepRoomDeletion(restoreRoomDeletion(saved), event));
      if (!next.context.reply.ok) throw new RoomDeletionError(next.context.reply.code, roomId);
      if (saved.context.force) for (const lease of this.deletionLeases(roomId)) {
        this.db.prepare('DELETE FROM workspace_leases WHERE key=? AND owner=?').run(lease.key, lease.owner);
        this.db.prepare('DELETE FROM resource_leases WHERE key=? AND owner=?').run(lease.key, lease.owner);
      }
      if (!saved.context.force && this.deletionLeases(roomId).length) throw new RoomDeletionError('DELETION_LEASE_UNSETTLED', roomId);
      this.removeRoomData(roomId); this.saveDeletion(roomId, next); return next;
    });
  }
  verifyDeletionDataGone(roomId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId) || this.db.prepare('SELECT 1 FROM receipts WHERE room_id=?').get(roomId)) return false;
    if (this.hasTable('web_rooms') && this.db.prepare('SELECT 1 FROM web_rooms WHERE id=?').get(roomId)) return false;
    if (this.hasTable('web_events') && this.db.prepare('SELECT 1 FROM web_events WHERE roomId=?').get(roomId)) return false;
    return this.deletionLeases(roomId).length === 0;
  }
  finishRoomDeletion(roomId: string, event: Extract<RoomDeletionEvent, { type: 'VERIFIED' }>): SavedRoomDeletion {
    return this.atomic(() => {
      const saved = this.readDeletion(roomId);
      if (!saved) throw new RoomDeletionError('STALE_DELETION', roomId);
      if (!this.verifyDeletionDataGone(roomId)) throw new RoomDeletionError('DELETION_DATA_REMAIN', roomId);
      const next = persistRoomDeletion(stepRoomDeletion(restoreRoomDeletion(saved), event));
      if (!next.context.reply.ok || next.value !== 'deleted') throw new RoomDeletionError(next.context.reply.code, roomId);
      this.removeRoomData(roomId); this.saveDeletion(roomId, next); return next;
    });
  }
  close(): void { if (this.ownsDatabase) this.db.close(); }
}

/** A second adapter for fast deterministic tests, with the same rollback contract. */
export class MemoryStore implements DeletionStore {
  private rooms = new Map<string, RoomData>();
  private leases = new Map<string, string>();
  private resources = new Map<string, ResourceLeaseRow>();
  private receipts = new Map<string, { fingerprint: string; result: unknown }>();
  private deletions = new Map<string, SavedRoomDeletion>();
  failNextCommit = false;
  read(roomId: string): RoomData { return structuredClone(this.rooms.get(roomId) ?? empty()); }
  resourceBlockers(workspaceId: string, owner: string, requests?: ResourceLease[]): string[] {
    return resourceBlockers([...this.resources.values()], [...this.leases].map(([key, owner]) => ({ key, owner })),
      unsafeWorkBarriers([...this.rooms], owner), workspaceId, owner, requests);
  }
  leaseInventory(): ExecutionLease[] {
    return [
      ...[...this.resources.values()].map(row => ({ ...row, kind: 'typed' as const })),
      ...[...this.leases].map(([key, owner]) => ({ key, owner, mode: 'write' as const, phase: 'execute' as const, kind: 'workspace' as const })),
      ...unsafeWorkBarriers([...this.rooms], '').map(row => ({ ...row, mode: 'write' as const, phase: 'execute' as const, kind: 'legacyWork' as const })),
    ];
  }
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    return this.transactRoom(roomId, fn);
  }
  private transactRoom<T>(roomId: string, fn: (tx: Transaction) => T, proof?: DeletionSettlementProof): T {
    const room = this.read(roomId);
    const deletion = this.readDeletion(roomId);
    if (proof) assertSettlement(deletion, room, roomId, proof); else assertBarrier(deletion, roomId);
    const receipts = new Map(this.receipts);
    const leases = new Map(this.leases);
    const resources = new Map([...this.resources].map(([key, value]) => [key, { ...value }]));
    const key = (id: string) => JSON.stringify([roomId, id]);
    const result = fn({ room,
      acquireWorkspace: (key, owner) => {
        if (unsafeWorkBarriers([...this.rooms], owner).some(row => row.owner !== owner)) return false;
        if ([...resources.values()].some(row => (row.key === key || row.key === unconfinedEffectsKey) && row.owner !== owner)) return false;
        if (!leases.has(key)) leases.set(key, owner); return leases.get(key) === owner;
      },
      acquireResources: (requests, owner) => {
        if (!canAcquireResourceLeases([...resources.values()], requests, owner, [...[...leases].map(([key, owner]) => ({ key, owner })), ...unsafeWorkBarriers([...this.rooms], owner)])) return false;
        for (const lease of requests) {
          const key = JSON.stringify([lease.key, owner, lease.phase]), previous = resources.get(key);
          resources.set(key, { ...lease, owner, mode: previous?.mode === 'write' ? 'write' : lease.mode });
        }
        return true;
      },
      releaseResources: (keys, owner, phase) => {
        for (const [id, row] of resources) if (keys.includes(row.key) && row.owner === owner && (!phase || row.phase === phase)) resources.delete(id);
      },
      releaseWorkspace: (key, owner) => { if (leases.get(key) === owner) leases.delete(key); }, receipt: id => structuredClone(receipts.get(key(id))), remember: (id, fingerprint, value) => { receipts.set(key(id), structuredClone({ fingerprint, result: value })); } });
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected commit failure'); }
    this.rooms.set(roomId, structuredClone(room));
    this.receipts = receipts;
    this.leases = leases;
    this.resources = resources;
    return result;
  }
  readDeletion(roomId: string) { return structuredClone(this.deletions.get(roomId)); }
  listDeletions() { return [...this.deletions.values()].map(value => structuredClone(value)); }
  private saveDeletion(roomId: string, saved: SavedRoomDeletion) {
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected commit failure'); }
    if (saved.value !== 'idle') this.deletions.set(roomId, structuredClone(saved));
  }
  stepDeletion(roomId: string, event: RoomDeletionEvent): SavedRoomDeletion {
    if (event.type === 'DATA_ERASED') return this.eraseDeletionData(roomId, event);
    if (event.type === 'VERIFIED') return this.finishRoomDeletion(roomId, event);
    const saved = transitionDeletion(roomId, this.read(roomId), this.readDeletion(roomId), event);
    this.saveDeletion(roomId, saved); return structuredClone(saved);
  }
  transactDeletionSettlement<T>(roomId: string, proof: DeletionSettlementProof, fn: (tx: Transaction) => T): T { return this.transactRoom(roomId, fn, proof); }
  deletionLeases(roomId: string) {
    const owners = ownedLeaseIds(this.readDeletion(roomId), this.read(roomId));
    return [...[...this.leases].map(([key, owner]) => ({ key, owner })), ...this.resources.values()].filter(row => owners.has(row.owner)).map(({ key, owner }) => ({ key, owner }));
  }
  private removeRoomData(roomId: string) {
    this.rooms.delete(roomId);
    for (const key of this.receipts.keys()) if ((JSON.parse(key) as string[])[0] === roomId) this.receipts.delete(key);
  }
  eraseDeletionData(roomId: string, event: Extract<RoomDeletionEvent, { type: 'DATA_ERASED' }>): SavedRoomDeletion {
    const saved = this.readDeletion(roomId);
    if (!saved) throw new RoomDeletionError('STALE_DELETION', roomId);
    const next = persistRoomDeletion(stepRoomDeletion(restoreRoomDeletion(saved), event));
    if (!next.context.reply.ok) throw new RoomDeletionError(next.context.reply.code, roomId);
    if (!saved.context.force && this.deletionLeases(roomId).length) throw new RoomDeletionError('DELETION_LEASE_UNSETTLED', roomId);
    this.saveDeletion(roomId, next);
    if (saved.context.force) {
      const owners = ownedLeaseIds(saved, this.read(roomId));
      for (const [key, owner] of this.leases) if (owners.has(owner)) this.leases.delete(key);
      for (const [key, lease] of this.resources) if (owners.has(lease.owner)) this.resources.delete(key);
    }
    this.removeRoomData(roomId); return structuredClone(next);
  }
  verifyDeletionDataGone(roomId: string) {
    return !this.rooms.has(roomId) && ![...this.receipts.keys()].some(key => (JSON.parse(key) as string[])[0] === roomId)
      && this.deletionLeases(roomId).length === 0;
  }
  finishRoomDeletion(roomId: string, event: Extract<RoomDeletionEvent, { type: 'VERIFIED' }>): SavedRoomDeletion {
    const saved = this.readDeletion(roomId);
    if (!saved) throw new RoomDeletionError('STALE_DELETION', roomId);
    if (!this.verifyDeletionDataGone(roomId)) throw new RoomDeletionError('DELETION_DATA_REMAIN', roomId);
    const next = persistRoomDeletion(stepRoomDeletion(restoreRoomDeletion(saved), event));
    if (!next.context.reply.ok || next.value !== 'deleted') throw new RoomDeletionError(next.context.reply.code, roomId);
    this.saveDeletion(roomId, next); this.removeRoomData(roomId); return structuredClone(next);
  }
  close(): void { /* No external resource. */ }
}
