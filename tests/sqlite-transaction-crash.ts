import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore, TeamEngine, type TaskEvent } from '../src/index.js';
import { configuration } from './helpers.js';
import { FULL_REPORT } from './artifact-fixture.js';
import type { TransactionBoundary, TransactionOperation } from './fixtures/sqlite-transaction-child.js';

interface Records { rooms: { id: string; data: string }[]; receipts: { room_id: string; id: string; fingerprint: string; result: string }[]; leases: { key: string; owner: string }[] }
interface Prepared { operation: TransactionOperation; boundary: TransactionBoundary; baseline: Records; room: string; task: string; workId: string; operationId?: string; event: TaskEvent }
interface Barrier { pid: number; operation: TransactionOperation; boundary: TransactionBoundary; writes: string[]; splitReceipt: boolean; records: Records }
export const crashWriterArguments = ['--experimental-transform-types', '--loader', './tests/fixtures/typescript-loader.mjs', 'tests/fixtures/crash.ts'];
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
function records(file: string): Records {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const value = {
      rooms: db.prepare('SELECT id,data FROM rooms ORDER BY id').all() as unknown as Records['rooms'],
      receipts: db.prepare('SELECT room_id,id,fingerprint,result FROM receipts ORDER BY room_id,id').all() as unknown as Records['receipts'],
      leases: db.prepare('SELECT key,owner FROM workspace_leases ORDER BY key').all() as unknown as Records['leases'],
    };
    // SQLite uses null-prototype rows; compare their serialized values to child evidence.
    return JSON.parse(JSON.stringify(value)) as Records;
  } finally { db.close(); }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function processGone(pid: number) { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; } }

/** Real process/SQLite acceptance fixture shared by direct Gherkin and the standalone evidence runner. */
export class SqliteTransactionCrash {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-sqlite-crash-'));
  readonly file = join(this.directory, 'state.sqlite');
  private child?: ChildProcess;
  private prepared?: Prepared;
  private barrier?: Barrier;
  private beforeKill?: Records;
  private reopened?: Records;
  private result: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private clean = false;
  constructor(readonly operation: TransactionOperation, readonly boundary: TransactionBoundary, readonly evidence: string, readonly splitReceipt = false) { mkdirSync(evidence, { recursive: true }); }

  async crash() {
    const suffix = this.splitReceipt ? ':splitReceipt' : '';
    const child = spawn(process.execPath, [...crashWriterArguments, this.file, `transaction:${this.operation}:${this.boundary}${suffix}`],
      { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stdout = '', stderr = '';
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })));
    const deadline = setTimeout(() => signalGroup(child, 'SIGKILL'), 10_000);
    try {
      await new Promise<void>((resolveBarrier, reject) => {
        child.once('error', reject);
        child.stderr!.on('data', chunk => { stderr += String(chunk); });
        child.stdout!.on('data', chunk => { stdout += String(chunk); if (stdout.includes(`"barrier":"${this.boundary}"`)) resolveBarrier(); });
        child.once('close', (code, signal) => reject(new Error(`SQLite crash child exited before barrier (${code}/${signal}): ${stderr}`)));
      });
      this.prepared = readJson<Prepared>(join(this.directory, 'prepared.json'));
      this.barrier = readJson<Barrier>(join(this.directory, 'barrier.json'));
      assert.equal(this.barrier.pid, child.pid, 'Barrier must belong to the owned writer');
      assert.deepEqual(this.barrier.writes, this.operation === 'lease' ? ['workspaceLease', 'receipt', 'snapshot'] : ['receipt', 'snapshot']);
      this.beforeKill = records(this.file);
      signalGroup(child, 'SIGKILL');
      this.result = await closed;
      assert.equal(this.result.signal, 'SIGKILL', 'Actual writer must be lost without cleanup or ROLLBACK');
      this.reopened = records(this.file);
    } finally {
      clearTimeout(deadline); signalGroup(child, 'SIGKILL'); await closed;
      writeFileSync(join(this.evidence, 'child.stdout.log'), stdout); writeFileSync(join(this.evidence, 'child.stderr.log'), stderr);
      this.save();
    }
  }

  verifyBoundary(expected: '全部不可见' | '完整保留') {
    const p = this.prepared!, b = this.barrier!;
    assert.equal(expected, this.boundary === 'beforeCommit' ? '全部不可见' : '完整保留');
    const expectedRows = this.boundary === 'beforeCommit' ? p.baseline : b.records;
    assert.deepEqual(this.reopened!.rooms, expectedRows.rooms, 'ATOMICITY_SNAPSHOT: no partial candidate, report, message or claim snapshot');
    assert.deepEqual(this.reopened!.receipts, expectedRows.receipts, 'ATOMICITY_RECEIPT: no partially committed request receipt');
    assert.deepEqual(this.reopened!.leases, expectedRows.leases, 'ATOMICITY_LEASE: workspace lease and claim must commit together');
    assert.deepEqual(this.beforeKill, expectedRows, 'Concurrent observer sees the same complete committed boundary');
    assert.equal(b.records.receipts.filter(row => row.id === p.event.id).length, 1, 'Receipt was actually written before the crash');
    if (this.operation === 'lease') assert.equal(b.records.leases.length, 1, 'Workspace lease was actually written before the crash');
  }

  verifyReplay() {
    const p = this.prepared!, store = new SqliteStore(this.file);
    try {
      const e = new TeamEngine(store, configuration(), () => 0);
      const first = e.send(p.room, p.task, p.event);
      assert(first.ok, `Same request must be safe after crash: ${first.code}`);
      assert.equal(first.duplicate === true, this.boundary === 'afterCommit', 'Only committed requests have receipts');
      const committed = store.read(p.room), firstRows = records(this.file);
      const second = e.send(p.room, p.task, p.event);
      assert(second.ok && second.duplicate, 'Second delivery must return the original receipt');
      assert.deepEqual(store.read(p.room), committed, 'Duplicate must not advance the task or dispatch new work');
      assert.deepEqual(records(this.file), firstRows, 'Duplicate must not create another receipt or lease');
      const c = e.view(p.room, p.task)!.context;
      if (this.operation === 'report') {
        assert.equal(e.view(p.room, p.task)!.phase, 'checking');
        assert.equal(c.artifacts.length, 1); assert.equal(c.artifacts[0]!.content, FULL_REPORT);
        assert.equal(c.candidate!.text, FULL_REPORT);
        assert.equal(e.pending(p.room, p.task).filter(work => work.kind === 'check').length, 1, 'Only one check may be dispatched');
        assert.equal(c.messages.filter(message => message.kind === 'final').length, 0, 'Unverified candidate is not a published success');
      } else {
        const work = c.intents.find(item => item.id === p.workId)!;
        assert.equal(work.localOperations!.filter(item => item.id === p.operationId).length, 1);
        assert.equal(work.localOperations![0]!.status, 'claimed');
        assert.equal(work.localOperations![0]!.sessionId, 'atomic-session');
        const competitor = store.transact('other-room', tx => tx.acquireWorkspace('atomicity-workspace', 'other-owner'));
        assert.equal(competitor, false, 'Committed claim excludes another workspace owner');
      }
      writeFileSync(join(this.evidence, 'replayed.json'), JSON.stringify({ records: records(this.file), phase: e.view(p.room, p.task)!.phase, context: c }, null, 2));
    } finally { store.close(); }
  }

  cleanup() {
    if (this.child) signalGroup(this.child, 'SIGKILL');
    assert(!this.child?.pid || processGone(this.child.pid) && processGone(-this.child.pid), 'Owned writer and process group must be gone before fixture cleanup');
    rmSync(this.directory, { recursive: true, force: true });
    this.clean = !existsSync(this.directory); this.save();
    assert(this.clean, 'Temporary SQLite files must be removed');
  }
  private save() {
    writeFileSync(join(this.evidence, 'case.json'), JSON.stringify({ temporaryDirectory: this.directory, operation: this.operation, boundary: this.boundary, splitReceipt: this.splitReceipt,
      prepared: this.prepared, barrier: this.barrier, beforeKill: this.beforeKill, reopened: this.reopened,
      writerExit: this.result, cleanup: { writerGone: !this.child?.pid || processGone(this.child.pid), processGroupGone: !this.child?.pid || processGone(-this.child.pid), temporaryDatabaseRemoved: this.clean } }, null, 2));
  }
}

export function crashEvidenceDirectory(name: string) { return resolve('reports', 'verify-sqlite-crash', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`, name); }

export async function verifyAtomicityNegativeControl(operation: TransactionOperation, evidence: string) {
  const altered = new SqliteTransactionCrash(operation, 'beforeCommit', evidence, true);
  try {
    await altered.crash();
    let failure: unknown;
    assert.throws(() => altered.verifyBoundary('全部不可见'), error => { failure = error; return error instanceof assert.AssertionError && /ATOMICITY_RECEIPT/.test(error.message); }, 'Split receipt must fail the concrete partial-commit assertion');
    assert(failure instanceof assert.AssertionError);
    writeFileSync(join(evidence, 'negative-control.json'), JSON.stringify({ status: 'detected', mutation: 'receipt independently committed before snapshot', assertion: 'ATOMICITY_RECEIPT',
      error: { code: failure.code, message: failure.message, stack: failure.stack, expected: failure.expected, actual: failure.actual } }, null, 2));
  } finally { altered.cleanup(); }
}
