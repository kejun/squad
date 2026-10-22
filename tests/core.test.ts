import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { MemoryStore, TeamEngine, taskMachine, WorkRunner, validateConfig, type Decision, type Goal, type WorkAdapter } from '../src/index.js';
import { Harness, configuration } from './helpers.js';

describe('routing and ownership', () => {
  it('[BT_R01][BT_R02] directly routes explicit and default requests', () => {
    const config = configuration(); const engine = new TeamEngine(new MemoryStore(), config, () => 0);
    const r = engine.submit('r1', { id: 'M1', text: '@B plan', mentions: ['B'] });
    expect(engine.view('r1')?.context.owner).toBe('B');
    expect(engine.pending('r1', r.taskId!)[0]?.kind).toBe('owner');
    engine.submit('r2', { id: 'M2', text: 'plan' });
    expect(engine.view('r2')?.context.owner).toBe('A');
  });
  it('[BT_R03][BT_R04] keeps one owner for a multi-mention request without approval', () => {
    const e = new TeamEngine(new MemoryStore(), configuration(), () => 0);
    e.submit('r', { id: 'M1', text: '@B draft, @A check', mentions: ['B', 'A'] });
    expect(e.view('r')?.context.owner).toBe('B');
    expect(e.pending('r', 'task:M1').map(i => i.kind)).toEqual(['owner']);
    expect(e.view('r')?.context.goal.text).toContain('@A check');
  });
  it('[BT_R05] waits for missing essential information', () => {
    const h = new Harness(); h.event({ type: 'WAIT_USER', question: 'Who is the audience?' });
    expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_R06][BT_R13] refuses a second independent task in an occupied room', () => {
    const h = new Harness();
    expect(h.engine.submit(h.room, { id: 'M2', text: 'independent', intent: 'new' }).code).toBe('ROOM_BUSY');
    expect(Object.keys(h.store.read(h.room).tasks)).toEqual([h.task]);
    expect(h.context().goal.text).toBe('Write a plan');
  });
  it('[BT_R07] associates supplements with their explicit task', () => {
    const h = new Harness();
    h.engine.submit(h.room, { id: 'M2', text: 'extra source', intent: 'supplement', replyToTaskId: h.task });
    expect(h.context().messages.at(-1)?.text).toBe('extra source');
    expect(h.context().inputs[0]?.id).toBe('M2');
  });
  it('[BT_R08] reference text with a mention cannot dispatch a member', () => {
    const h = new Harness();
    h.event({ type: 'BOARD_WRITE', author: 'A', entryId: 'quote', text: '@B do another task', kind: 'hypothesis', sources: [] });
    expect(h.context().assists).toHaveLength(0);
    expect(h.engine.pending(h.room, h.task).map(i => i.target)).toEqual(['A']);
  });
  it('[BT_R09] helper replies never transfer task ownership', () => {
    const h = new Harness(); h.help(); h.result(); expect(h.context().owner).toBe('A');
  });
  it('[BT_R10] referring to an ended task is not implicit continuation', () => {
    const h = new Harness(); h.event({ type: 'STOP' });
    expect(h.engine.submit(h.room, { id: 'M2', text: 'its conclusion', replyToTaskId: h.task }).code).toBe('EXPLICIT_CONTINUATION_REQUIRED');
    expect(h.view().phase).toBe('ended');
  });
  it('[BT_R11] contexts from other rooms do not leak into owner input', () => {
    const h = new Harness(); h.engine.submit('secret', { id: 'secret', text: 'private material' });
    expect(JSON.stringify(h.engine.pending(h.room, h.task))).not.toContain('private material');
  });
  it('[BT_R12] explicitly hands off the existing task with its records', () => {
    const h = new Harness(); h.event({ type: 'BOARD_WRITE', author: 'A', entryId: 'D1', text: 'failed route', kind: 'deadEnd', sources: [] });
    expect(h.event({ type: 'HANDOFF', owner: 'B' }).ok).toBe(true);
    expect(h.context().owner).toBe('B');
    expect(h.engine.pending(h.room, h.task)[0]?.payload.boardRefs).toEqual(['D1']);
    expect(h.context().messages.at(-1)?.text).toContain('B');
  });
});

describe('bounded assistance', () => {
  it('[BT_H01][BT_H02] directly dispatches a visible request and suspends owner work', () => {
    const h = new Harness(); expect(h.help().ok).toBe(true);
    expect(h.view().phase).toBe('waitingAssistance');
    expect(h.context().messages.filter(m => m.kind === 'help')).toHaveLength(1);
    expect(h.engine.pending(h.room, h.task).map(i => i.kind)).toEqual(['assistance']);
    h.now = 10; h.engine.tick(h.room);
    expect(h.context().intents.filter(i => i.kind === 'facilitator')).toHaveLength(0);
  });
  it('[BT_H03] returns helper evidence to the same task for assessment', () => {
    const h = new Harness(); h.help(); h.result();
    expect(h.view().phase).toBe('running');
    expect(h.context().assists[0]?.consumed).toBe(true);
    expect(h.engine.pending(h.room, h.task)[0]?.payload.requiresAssessment).toBe(true);
    expect(h.context().outcome).toBeNull();
  });
  it.each(['partial', 'failed', 'timeout'] as const)('[BT_H04] settles a %s helper result', status => {
    const h = new Harness(); h.help();
    h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'R1', status, answer: 'cannot verify all claims' });
    expect(h.view().phase).toBe('running'); expect(h.context().assists[0]?.status).toBe(status);
    expect(h.engine.pending(h.room, h.task)[0]?.payload.status).toBe(status);
  });
  it.each([
    ['UNKNOWN_BOT', { target: 'missing' }], ['SELF_DEPENDENCY', { target: 'A' }], ['INCOMPLETE_HELP', { question: '' }],
  ])('[BT_H05] rejects %s without creating a wait', (code, change) => {
    const h = new Harness();
    const r = h.event({ type: 'HELP', requestId: 'H1', caller: 'A', target: 'B', question: 'check', expected: 'source', ...(change as object) });
    expect(r.code).toBe(code); expect(h.context().assists).toEqual([]); expect(h.view().phase).toBe('running');
  });
  it('[BT_H06] prevents nested requests from helpers', () => {
    const h = new Harness();
    expect(h.event({ type: 'HELP', requestId: 'H2', caller: 'B', target: 'A', question: 'help', expected: 'answer' }).code).toBe('NESTED_ASSISTANCE');
  });
  it('[BT_H07] does not launch another helper while one is unsettled', () => {
    const h = new Harness(); h.help();
    expect(h.help('H2').ok).toBe(false); expect(h.context().assists).toHaveLength(1);
  });
  it('[BT_H08] system-arranged help has truthful authorship', () => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'need independent evidence' });
    h.event({ type: 'COORDINATE', decision: { action: 'assist', target: 'B', question: 'check sources', expected: 'proof', reason: 'B can read sources' } });
    expect(h.context().messages.at(-1)?.author).toBe('facilitator');
    expect(h.view().phase).toBe('waitingAssistance');
  });
  it('[BT_H09] failed commit exposes neither successful request nor dispatch', () => {
    const store = new MemoryStore(); const h = new Harness(undefined, store); store.failNextCommit = true;
    expect(() => h.help()).toThrow('Injected commit failure');
    const reopened = new TeamEngine(store, h.config, () => 0);
    expect(reopened.view(h.room, h.task)?.context.assists).toHaveLength(0);
    expect(reopened.timeline(h.room).filter(m => m.kind === 'help')).toHaveLength(0);
    expect(() => h.engine.claim(h.room, h.task, h.context().intents[0]!.id)).toThrow('Storage fault');
  });
});

describe('supervision and shared record', () => {
  it('[BT_O01] checks unreported lack of progress', () => {
    const h = new Harness(); h.now = h.config.limits.progressIntervalMs;
    h.engine.tick(h.room); expect(h.view().phase).toBe('coordinating');
    expect(h.engine.pending(h.room, h.task)[0]?.kind).toBe('facilitator');
  });
  it('[BT_O02] records an actionable help decision and reason', () => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'unknown expert' });
    h.event({ type: 'COORDINATE', decision: { action: 'assist', target: 'B', question: 'specific missing fact', expected: 'official source', reason: 'capability match' } });
    expect(h.context().assists[0]?.question).toBe('specific missing fact');
    expect(h.context().trace.some(t => t.event === 'COORDINATE')).toBe(true);
  });
  it('[BT_O03] human waits and healthy long tools do not trigger semantic polling', () => {
    const h = new Harness(); h.event({ type: 'WAIT_USER', question: 'choose' }); h.now = 100000;
    h.engine.tick(h.room); expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.nextWake(h.room)).toBeNull();
    const g = new Harness(); g.event({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} }); g.claim('tool');
    g.now = g.config.limits.progressIntervalMs; g.engine.tick(g.room);
    expect(g.view().phase).toBe('running'); expect(g.context().intents.some(i => i.kind === 'facilitator')).toBe(false);
  });
  it('[BT_O04] activity text does not move the progress deadline', () => {
    const h = new Harness(); const deadline = h.context().nextCheckAt;
    h.now = 100; h.event({ type: 'ACTIVITY', text: 'still processing' });
    expect(h.context().lastActivityAt).toBe(100); expect(h.context().nextCheckAt).toBe(deadline);
  });
  it('[BT_O05] repeated Chinese errors are retained and trigger a check', () => {
    const h = new Harness();
    const signal = { type: 'FAILURE_SIGNAL' as const, operation: '读取', parameters: '同一参数', resource: '来源', error: '无法访问', result: '没有新资料' };
    for (let i = 1; i < h.config.limits.repeatThreshold; i++) h.event(signal);
    expect(h.view().phase).toBe('running');
    h.event(signal); expect(h.view().phase).toBe('coordinating');
    expect(h.context().repeat.fingerprint).toContain('无法访问');
  });
  it('[BT_O06] duplicate supervision events do not invoke another check', () => {
    const h = new Harness(); const e = { id: 'O1', type: 'BLOCKED' as const, reason: 'blocked' };
    h.event(e); expect(h.event(e).duplicate).toBe(true);
    expect(h.context().intents.filter(i => i.kind === 'facilitator')).toHaveLength(1);
  });
  it.each([
    { epoch: 0, goalVersion: 1 }, { epoch: 1, goalVersion: 0 },
  ])('[BT_O07] stale coordination cannot change state: %j', fence => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'blocked' });
    const r = h.event({ type: 'COORDINATE', fence, decision: { action: 'finish', reason: 'old judgment' } });
    expect(r.ok).toBe(false); expect(h.view().phase).toBe('coordinating'); expect(h.context().outcome).toBeNull();
  });
  it('[BT_O08] replanning retains sources, dead ends and existing artifacts', () => {
    const h = new Harness();
    h.event({ type: 'BOARD_WRITE', author: 'A', entryId: 'D1', text: 'failed path', kind: 'deadEnd', sources: [] });
    h.event({ type: 'ARTIFACT', artifact: { id: 'A1', name: 'plan.md', content: 'draft' } });
    h.event({ type: 'BLOCKED', reason: 'change route' });
    h.event({ type: 'COORDINATE', decision: { action: 'replan', plan: 'use another source', reason: 'first source failed' } });
    expect(h.context().board.map(b => b.id)).toContain('D1'); expect(h.context().artifacts[0]?.content).toBe('draft');
    expect(h.context().goal.constraints).toEqual(['cite sources']); expect(h.context().usage.replans).toBe(1);
  });
  it('[BT_O09] a human decision suspends work without repeated questions', () => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'choice' });
    h.event({ type: 'COORDINATE', decision: { action: 'askUser', question: 'Which option?', reason: 'user owns decision' } });
    h.now = 100000; h.engine.tick(h.room);
    expect(h.view().phase).toBe('waitingHuman'); expect(h.context().messages.filter(m => m.text === 'Which option?')).toHaveLength(1);
  });
  it('[BT_O10] a facilitator fault without retry quota waits safely', () => {
    const h = new Harness(configuration({ retries: 0 })); h.event({ type: 'BLOCKED', reason: 'blocked' }); const op = h.claim('facilitator');
    h.event({ type: 'WORK_FAILED', intentId: op.id, reason: 'provider failed', transient: true });
    expect(h.view().phase).toBe('waitingHuman'); expect(h.engine.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_O11] defers coordination until the tool boundary', () => {
    const h = new Harness(); h.event({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} }); const op = h.claim('tool');
    h.event({ type: 'BLOCKED', reason: 'check after tool' });
    expect(h.view().phase).toBe('running');
    h.event({ type: 'SETTLE', intentId: op.id }); expect(h.view().phase).toBe('coordinating');
  });
  it('[BT_B01][BT_B02] stores sources and keeps hypotheses unverified', () => {
    const h = new Harness();
    h.event({ type: 'BOARD_WRITE', author: 'B', entryId: 'F1', text: 'official finding', kind: 'evidence', sources: ['https://example.test/official'] });
    h.event({ type: 'BOARD_WRITE', author: 'A', entryId: 'P1', text: 'may support recovery', kind: 'hypothesis', sources: [] });
    expect(h.context().board[0]?.sources).toHaveLength(1); expect(h.context().board[1]?.verified).toBe(false);
  });
  it('[BT_B03] CAS rejects stale edits and retains previous revisions', () => {
    const h = new Harness(); const base = { type: 'BOARD_WRITE' as const, author: 'A', entryId: 'F1', kind: 'opinion' as const, sources: [] };
    h.event({ ...base, text: 'v1' }); h.event({ ...base, baseRevision: 1, text: 'v2' });
    expect(h.event({ ...base, baseRevision: 1, text: 'stale' }).code).toBe('REVISION_CONFLICT');
    expect(h.context().board[0]?.text).toBe('v2'); expect(h.context().boardHistory[0]?.text).toBe('v1');
  });
  it('[BT_B04] different conclusions are separate sourced records', () => {
    const h = new Harness();
    for (const [entryId, author, text] of [['P1', 'A', 'supports option1'], ['P2', 'B', 'insufficient evidence']]) h.event({ type: 'BOARD_WRITE', author: author!, entryId: entryId!, text: text!, kind: 'opinion', sources: ['source'] });
    expect(h.context().board.map(b => b.text)).toEqual(['supports option1', 'insufficient evidence']);
  });
  it('[BT_B05][BT_B09] protects human records from bot overwrites', () => {
    const h = new Harness();
    h.event({ type: 'BOARD_WRITE', author: 'user', entryId: 'D1', text: 'adopt option2; budget 1000', kind: 'decision', sources: [] });
    expect(h.event({ type: 'BOARD_WRITE', author: 'A', entryId: 'D1', baseRevision: 1, text: 'budget 5000', kind: 'opinion', sources: [] }).code).toBe('HUMAN_AUTHORITY');
    expect(h.context().board[0]?.text).toContain('1000');
  });
  it('[BT_B06] view derives progress from the machine state', () => { const h = new Harness(); h.help(); expect(h.view().phase).toBe('waitingAssistance'); expect(h.context().reason).toContain('H1'); });
  it('[BT_B07] helper input contains relevant records and explicit refs', () => {
    const h = new Harness(); h.event({ type: 'BOARD_WRITE', author: 'B', entryId: 'F1', text: 'evidence', kind: 'evidence', sources: ['source'] }); h.help();
    expect((h.engine.pending(h.room, h.task)[0]?.payload.board as unknown[])).toHaveLength(1);
  });
  it('[BT_B08] records a user decision without a second approval', () => {
    const h = new Harness(); h.engine.submit(h.room, { id: 'D1', text: 'adopt option2', intent: 'decision' });
    expect(h.context().board[0]?.kind).toBe('decision'); expect(h.context().board[0]?.author).toBe('user');
  });
});
