import assert from 'node:assert/strict';
import { writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, type TaskEvent } from '../../src/index.js';
import { Harness } from '../helpers.js';
import { delivery } from '../artifact-fixture.js';

export type TransactionOperation = 'report' | 'lease';
export type TransactionBoundary = 'beforeCommit' | 'afterCommit';

/** Fixture-only instrumentation. Production storage has no crash hook or changed transaction code. */
export function runTransactionCrashChild(file: string, operation: TransactionOperation, boundary: TransactionBoundary, splitReceipt: boolean) {
  let armed = false, split = false;
  const writes: string[] = [];
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalExec = DatabaseSync.prototype.exec;
  const rows = (db: DatabaseSync) => ({
    rooms: originalPrepare.call(db, 'SELECT id,data FROM rooms ORDER BY id').all(),
    receipts: originalPrepare.call(db, 'SELECT room_id,id,fingerprint,result FROM receipts ORDER BY room_id,id').all(),
    leases: originalPrepare.call(db, 'SELECT key,owner FROM workspace_leases ORDER BY key').all(),
  });
  const barrier = (db: DatabaseSync) => {
    const proof = { pid: process.pid, operation, boundary, writes, splitReceipt: split,
      sqlite: { version: originalPrepare.call(db, 'SELECT sqlite_version() AS version').get(), journalMode: originalPrepare.call(db, 'PRAGMA journal_mode').get(), synchronous: originalPrepare.call(db, 'PRAGMA synchronous').get() }, records: rows(db) };
    writeFileSync(join(file, '..', 'barrier.json'), JSON.stringify(proof, null, 2));
    writeSync(1, `${JSON.stringify({ barrier: boundary, pid: process.pid })}\n`);
    // The owning parent SIGKILLs this process. No exception, close or ROLLBACK can run.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error('Barrier unexpectedly resumed');
  };
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    const db = this;
    statement.run = new Proxy(statement.run, { apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (!armed) return result;
      if (/^INSERT INTO receipts/.test(sql)) {
        writes.push('receipt');
        if (splitReceipt) {
          // Negative control: force a cross-record partial commit inside this isolated child.
          originalExec.call(db, 'COMMIT'); originalExec.call(db, 'BEGIN IMMEDIATE'); split = true;
        }
      }
      if (/^INSERT OR IGNORE INTO workspace_leases/.test(sql)) writes.push('workspaceLease');
      if (/^INSERT INTO rooms/.test(sql)) {
        writes.push('snapshot');
        if (boundary === 'beforeCommit') barrier(db);
      }
      return result;
    } });
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql: string) {
    originalExec.call(this, sql);
    if (armed && sql === 'COMMIT' && boundary === 'afterCommit') barrier(this);
  };

  const store = new SqliteStore(file);
  const h = new Harness(undefined, store);
  const work = h.claim('owner');
  let event: TaskEvent;
  let operationId: string | undefined;
  if (operation === 'report') event = delivery(h, work, 'atomic-result');
  else {
    const local = h.engine.requestLocal(h.room, h.task, work.id, work.attempt,
      { type: 'runCli', executable: 'node', args: ['isolated-effect.mjs'] }, [], 'atomicity-workspace');
    operationId = local.id;
    event = { type: 'LOCAL_CLAIM', id: 'atomic-local-claim', at: 0, intentId: work.id,
      operationId, parentAttempt: work.attempt, sessionId: 'atomic-session', leaseAvailable: true, fence: work };
  }
  const probe = new DatabaseSync(file, { readOnly: true });
  const prepared = { operation, boundary, baseline: rows(probe), room: h.room, task: h.task, workId: work.id, operationId, event };
  probe.close();
  writeFileSync(join(file, '..', 'prepared.json'), JSON.stringify(prepared, null, 2));
  armed = true;
  assert(h.engine.send(h.room, h.task, event).ok);
  throw new Error('Crash point was not reached');
}
