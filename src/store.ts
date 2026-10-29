import { DatabaseSync } from 'node:sqlite';

export interface RoomData {
  schemaVersion: 1; activeTaskId: string | null;
  tasks: Record<string, unknown>; notices: { id: string; text: string }[];
}
export interface Transaction {
  room: RoomData;
  receipt(id: string): { fingerprint: string; result: unknown } | undefined;
  remember(id: string, fingerprint: string, result: unknown): void;
  /** Global across rooms; held until a confirmed child-operation settlement. */
  acquireWorkspace(key: string, owner: string): boolean;
  releaseWorkspace(key: string, owner: string): void;
}
export interface Store {
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T;
  read(roomId: string): RoomData;
  close(): void;
}
const empty = (): RoomData => ({ schemaVersion: 1, activeTaskId: null, tasks: {}, notices: [] });

/** One SQLite transaction commits snapshot, outbox, public messages and receipt together. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  failNextCommit = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS workspace_leases(key TEXT PRIMARY KEY, owner TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(room_id TEXT, id TEXT, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room_id,id));');
  }
  read(roomId: string): RoomData {
    const row = this.db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId) as { data: string } | undefined;
    const data = row ? JSON.parse(row.data) as RoomData : empty();
    if (data.schemaVersion !== 1) throw new Error('Unsupported storage schema');
    return data;
  }
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const room = this.read(roomId);
      const tx: Transaction = {
        room,
        receipt: id => {
          const row = this.db.prepare('SELECT fingerprint,result FROM receipts WHERE room_id=? AND id=?').get(roomId, id) as { fingerprint: string; result: string } | undefined;
          return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result) as unknown } : undefined;
        },
        acquireWorkspace: (key, owner) => {
          this.db.prepare('INSERT OR IGNORE INTO workspace_leases(key,owner) VALUES(?,?)').run(key, owner);
          return (this.db.prepare('SELECT owner FROM workspace_leases WHERE key=?').get(key) as { owner: string }).owner === owner;
        },
        releaseWorkspace: (key, owner) => { this.db.prepare('DELETE FROM workspace_leases WHERE key=? AND owner=?').run(key, owner); },
        remember: (id, fingerprint, result) => { this.db.prepare('INSERT INTO receipts(room_id,id,fingerprint,result) VALUES(?,?,?,?)').run(roomId, id, fingerprint, JSON.stringify(result)); },
      };
      const result = fn(tx);
      this.db.prepare('INSERT INTO rooms(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(roomId, JSON.stringify(room));
      if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected commit failure'); }
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

/** A second adapter for fast deterministic tests, with the same rollback contract. */
export class MemoryStore implements Store {
  private rooms = new Map<string, RoomData>();
  private leases = new Map<string, string>();
  private receipts = new Map<string, { fingerprint: string; result: unknown }>();
  failNextCommit = false;
  read(roomId: string): RoomData { return structuredClone(this.rooms.get(roomId) ?? empty()); }
  transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    const room = this.read(roomId);
    const receipts = new Map(this.receipts);
    const leases = new Map(this.leases);
    const key = (id: string) => JSON.stringify([roomId, id]);
    const result = fn({ room,
      acquireWorkspace: (key, owner) => { if (!leases.has(key)) leases.set(key, owner); return leases.get(key) === owner; },
      releaseWorkspace: (key, owner) => { if (leases.get(key) === owner) leases.delete(key); }, receipt: id => structuredClone(receipts.get(key(id))), remember: (id, fingerprint, value) => { receipts.set(key(id), structuredClone({ fingerprint, result: value })); } });
    if (this.failNextCommit) { this.failNextCommit = false; throw new Error('Injected commit failure'); }
    this.rooms.set(roomId, structuredClone(room));
    this.receipts = receipts;
    this.leases = leases;
    return result;
  }
  close(): void { /* No external resource. */ }
}
