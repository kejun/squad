import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MemoryStore, SqliteStore, TeamEngine } from '../src/index.js';
import { configuration, Harness } from './helpers.js';

const dirs: string[] = []; const stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function sqlite() { const d = mkdtempSync(join(tmpdir(), 'bot-team-')); dirs.push(d); const p = join(d, 'state.sqlite'); const s = new SqliteStore(p); stores.push(s); return { path: p, store: s }; }

describe('durable transaction contracts', () => {
  it.each(['memory', 'sqlite'])('[BT_D01] %s deduplicates requests and rejects changed payload identities', kind => {
    const store = kind === 'memory' ? new MemoryStore() : sqlite().store;
    const e = new TeamEngine(store, configuration(), () => 0);
    const input = { id: 'M1', text: 'plan' }; e.submit('r', input);
    expect(e.submit('r', input).duplicate).toBe(true);
    expect(e.submit('r', { ...input, text: 'different' }).code).toBe('REQUEST_ID_CONFLICT');
    expect(Object.keys(store.read('r').tasks)).toHaveLength(1); expect(e.timeline('r')).toHaveLength(1);
  });
  it.each(['afterHelp', 'afterClaim', 'afterResult'])('[BT_D02][BT_D03][BT_D04] reconstructs from an exited process at %s', point => {
    const db = sqlite(); db.store.close(); stores.splice(stores.indexOf(db.store), 1);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/crash.ts', db.path, point], { cwd: process.cwd(), timeout: 10000, encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(23);
    const s = new SqliteStore(db.path); stores.push(s); const e = new TeamEngine(s, configuration(), () => 0); e.recover('r');
    const c = e.view('r', 'task:M1')!.context;
    expect(c.assists).toHaveLength(1); expect(e.timeline('r').filter(m => m.kind === 'help')).toHaveLength(1);
    if (point === 'afterResult') { expect(c.consumedResults).toEqual(['R1']); expect(e.pending('r', 'task:M1')[0]?.kind).toBe('owner'); }
    else expect(e.pending('r', 'task:M1')[0]?.kind).toBe('assistance');
  });
  it('[BT_D05] same result with another delivery identity still only advances once', () => {
    const h = new Harness(); h.help(); h.result(); const before = h.context().intents.filter(i => i.kind === 'owner').length;
    expect(h.result().code).toBe('DUPLICATE_RESULT');
    expect(h.context().intents.filter(i => i.kind === 'owner')).toHaveLength(before);
    expect(h.context().messages.filter(m => m.kind === 'answer')).toHaveLength(1);
  });
  it.each(['memory', 'sqlite'])('[BT_D06] %s rolls back consumed result and parent change together', kind => {
    const s = kind === 'memory' ? new MemoryStore() : sqlite().store;
    const h = new Harness(undefined, s); h.help(); h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'R1', answer: 'evidence', status: 'success' });
    s.failNextCommit = true; expect(() => h.engine.flushResults(h.room, h.task)).toThrow('Injected commit failure');
    const e = new TeamEngine(s, h.config, () => 0);
    expect(e.view(h.room, h.task)?.context.results[0]?.consumed).toBe(false);
    expect(e.view(h.room, h.task)?.phase).toBe('waitingAssistance');
    e.flushResults(h.room, h.task); e.flushResults(h.room, h.task);
    expect(e.view(h.room, h.task)?.context.consumedResults).toEqual(['R1']);
  });
  it('[BT_D07] a new client/engine reads current work without resubmitting', () => {
    const h = new Harness(); h.help(); const e = new TeamEngine(h.store, h.config, () => 0);
    expect(e.view(h.room)?.phase).toBe('waitingAssistance'); expect(e.timeline(h.room)).toHaveLength(2);
  });
  it('[BT_D08] restores deadlines and preserves human waits', () => {
    const h = new Harness(); h.event({ type: 'WAIT_USER', question: 'choose' }); h.reopen();
    expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.nextWake(h.room)).toBeNull();
    const g = new Harness(); const wake = g.engine.nextWake(g.room); g.reopen(); expect(g.engine.nextWake(g.room)).toBe(wake);
  });
  it('[BT_D09] uncertain external operations require reconciliation rather than replay', () => {
    const h = new Harness(); h.event({ type: 'TOOL', tool: 'writeArtifact', replay: 'unsafe', payload: {} }); const work = h.claim('tool');
    h.reopen(); expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.pending(h.room, h.task)).toEqual([]);
    expect(h.event({ type: 'CONTINUE' }).code).toBe('UNRESOLVED_WORK');
    expect(h.event({ type: 'RECONCILE', intentId: work.id, resolution: 'confirmed', detail: 'External receipt confirms completed' }).ok).toBe(true);
    expect(h.event({ type: 'CONTINUE' }).ok).toBe(true);
  });
  it('[BT_D10] storage failure opens a fail-closed circuit', () => {
    const s = new MemoryStore(); const h = new Harness(undefined, s); s.failNextCommit = true;
    expect(() => h.claim('owner')).toThrow(); expect(() => h.engine.submit('r2', { id: 'M2', text: 'new' })).toThrow('Storage fault');
    expect(h.context().usage.ordinary).toBe(0);
  });
  it('[BT_D11] a durable stop survives reopening', () => {
    const h = new Harness(); h.help(); h.event({ type: 'STOP' }); h.reopen();
    expect(h.context().outcome).toBe('stopped'); expect(h.engine.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_D12] safe interrupted work keeps its logical identity and charges new attempts', () => {
    const h = new Harness(); const first = h.claim('owner'); h.reopen();
    const second = h.claim('owner'); expect(second.id).toBe(first.id); expect(second.attempt).toBe(2);
    expect(h.context().usage.ordinary).toBe(2);
  });
  it('[BT_D13] transient safe reads retry once but permission errors do not loop', () => {
    const h = new Harness(); h.event({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} }); const op = h.claim('tool');
    h.event({ type: 'WORK_FAILED', intentId: op.id, transient: true, reason: 'network' });
    expect(h.view().phase).toBe('running'); expect(h.context().usage.retries).toBe(1);
    h.claim('tool'); h.event({ type: 'WORK_FAILED', intentId: op.id, transient: false, reason: 'permission denied' });
    expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_E02] passive supervision recovers staged helper results exactly once', () => {
    const h = new Harness(); h.now = 60000; h.engine.tick(h.room);
    h.event({ type: 'COORDINATE', decision: { action: 'assist', target: 'B', question: 'verify', expected: 'source', reason: 'blocked path' } });
    h.reopen(); const requestId = h.context().assists[0]!.id;
    h.event({ type: 'RECORD_RESULT', requestId, resultId: 'R1', answer: 'official source', status: 'success' }); h.reopen();
    expect(h.context().consumedResults).toEqual(['R1']); expect(h.context().messages.filter(m => m.author === 'facilitator')).toHaveLength(1);
  });
});
