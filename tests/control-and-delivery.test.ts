import { describe, expect, it } from 'vitest';
import { TeamEngine, WorkRunner, type Decision, validateConfig } from '../src/index.js';
import { Harness, configuration } from './helpers.js';

describe('human control and current-version fences', () => {
  it('[BT_C01] records a supplement before applying it at a safe boundary', () => {
    const h = new Harness(); const op = h.claim('owner');
    h.engine.submit(h.room, { id: 'M2', text: 'new source', intent: 'supplement' });
    expect(h.context().inputs[0]?.applied).toBe(false);
    h.event({ type: 'SETTLE', intentId: op.id });
    expect(h.context().inputs[0]?.applied).toBe(true);
    expect(h.engine.pending(h.room, h.task)[0]?.payload.inputs).toEqual([expect.objectContaining({ id: 'M2', applied: true })]);
  });
  it('[BT_C02] changing constraints invalidates old help and preserves old artifacts', () => {
    const h = new Harness(); h.event({ type: 'ARTIFACT', artifact: { id: 'A1', name: 'draft', content: 'old' } }); h.help();
    h.event({ type: 'USER_INPUT', text: 'budget is now 500', goal: { ...h.context().goal, constraints: ['budget <= 500'] } });
    expect(h.context().goalVersion).toBe(2); expect(h.context().artifacts[0]?.goalVersion).toBe(1);
    const r = h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'old', status: 'success', answer: 'old answer', fence: { epoch: 1, goalVersion: 1 } });
    expect(r.ok).toBe(false); expect(h.context().lateResults).toHaveLength(1);
    expect(h.context().goal.constraints).toEqual(['budget <= 500']);
  });
  it('[BT_C03] a supplement keeps artifacts and does not count as replanning', () => {
    const h = new Harness(); h.event({ type: 'ARTIFACT', artifact: { id: 'A1', name: 'draft', content: 'draft' } });
    h.event({ type: 'USER_INPUT', text: 'additional source' });
    expect(h.context().goalVersion).toBe(1); expect(h.context().artifacts).toHaveLength(1); expect(h.context().usage.replans).toBe(0);
  });
  it.each(['owner', 'assistance', 'facilitator', 'check'] as const)('[BT_C04] stops from %s without dispatching new work', kind => {
    const h = new Harness();
    if (kind === 'assistance') h.help();
    if (kind === 'facilitator') h.event({ type: 'BLOCKED', reason: 'blocked' });
    if (kind === 'check') h.event({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
    const op = h.claim(kind); h.event({ type: 'STOP' });
    expect(h.view().phase).toBe('stopping');
    expect(h.engine.pending(h.room, h.task).every(i => i.kind === 'cancel')).toBe(true);
    h.event({ type: 'SETTLE', intentId: op.id });
    expect(h.view().phase).toBe('ended'); expect(h.context().outcome).toBe('stopped');
  });
  it('[BT_C05] remains stopping while an uncancellable request is in flight', () => {
    const h = new Harness(); const op = h.claim('owner'); h.event({ type: 'STOP' });
    expect(h.view().phase).toBe('stopping');
    const cancel = h.claim('cancel'); h.event({ type: 'WORK_FAILED', intentId: cancel.id, transient: false, reason: 'cannot cancel yet' });
    expect(h.view().phase).toBe('stopping'); h.event({ type: 'SETTLE', intentId: op.id });
    expect(h.context().outcome).toBe('stopped');
  });
  it('[BT_C06] late E1 output cannot revive E2', () => {
    const h = new Harness(); h.help(); h.event({ type: 'STOP' }); h.event({ type: 'CONTINUE' });
    const pending = h.engine.pending(h.room, h.task).map(i => i.id);
    h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'late', status: 'success', answer: 'late', fence: { epoch: 1, goalVersion: 1 } });
    expect(h.context().epoch).toBe(2); expect(h.engine.pending(h.room, h.task).map(i => i.id)).toEqual(pending);
    expect(h.context().lateResults[0]?.type).toBe('HELP_RESULT');
  });
  it('[BT_C07][BT_C08] resume preserves usage and requires explicit extra quota', () => {
    const h = new Harness(configuration({ ordinary: 1 })); const op = h.claim('owner'); h.event({ type: 'SETTLE', intentId: op.id }); h.event({ type: 'STOP' });
    expect(h.event({ type: 'CONTINUE' }).code).toBe('BUDGET_EXHAUSTED');
    expect(h.event({ type: 'CONTINUE', extraOrdinary: 2 }).ok).toBe(true);
    expect(h.context().usage.ordinary).toBe(1); expect(h.context().config.limits.ordinary).toBe(3); expect(h.context().epoch).toBe(2);
  });
  it('[BT_C09] a passed check for an old goal cannot publish success', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: 'G1 candidate', artifactIds: [] }); const op = h.claim('check');
    h.event({ type: 'USER_INPUT', text: 'new constraint', goal: { ...h.context().goal, constraints: ['G2'] } });
    expect(h.event({ type: 'CHECK_RESULT', resultId: 'passedG1', passed: true, gaps: [], workId: op.id, fence: { epoch: 1, goalVersion: 1 } }).ok).toBe(false);
    expect(h.context().outcome).toBeNull(); expect(h.context().messages.filter(m => m.kind === 'final')).toEqual([]);
  });
  it('[BT_C10] delivered work does not continue while awaiting adoption', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: 'finished', artifactIds: [] }); h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'check' });
    expect(h.view().phase).toBe('ended'); expect(h.context().outcome).toBe('complete');
    h.now = 500000; h.engine.tick(h.room); expect(h.engine.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_C11] a stale dispatch claim is rejected at commit', () => {
    const h = new Harness(); h.help(); const op = h.engine.pending(h.room, h.task)[0]!;
    h.event({ type: 'STOP' }); expect(h.engine.claim(h.room, h.task, op.id)).toBeNull();
    expect(h.context().outcome).toBe('stopped');
  });
  it('[BT_C11] completion after stop settles physical work without publishing', () => {
    const h = new Harness(); const op = h.claim('owner'); h.event({ type: 'STOP' });
    h.event({ type: 'DELIVER', text: 'late result', artifactIds: [], workId: op.id, fence: { epoch: 1, goalVersion: 1 } });
    expect(h.context().outcome).toBe('stopped'); expect(h.context().messages.some(m => m.kind === 'final')).toBe(false);
  });
  it.each(['BLOCKED', 'WORK_FAILED'] as const)('late %s retires only its own old operation and unblocks new input', type => {
    const h = new Harness(); const op = h.claim('owner');
    h.event({ type: 'USER_INPUT', text: 'G2', goal: { ...h.context().goal, constraints: ['G2'] } });
    const r = type === 'BLOCKED'
      ? h.event({ type, reason: 'old blocker', workId: op.id, fence: { epoch: 1, goalVersion: 1 } })
      : h.event({ type, reason: 'old failure', intentId: op.id, transient: false, fence: { epoch: 1, goalVersion: 1 } });
    expect(r.ok).toBe(false); expect(h.context().inputs.every(i => i.applied)).toBe(true);
    expect(h.engine.pending(h.room, h.task).some(i => i.kind === 'owner' && i.goalVersion === 2)).toBe(true);
  });
});

describe('budget and delivery', () => {
  it('[BT_F01] owner, helper and facilitator share the ordinary budget', () => {
    const h = new Harness(configuration({ ordinary: 2 })); const a = h.claim('owner');
    h.event({ type: 'HELP', caller: 'A', requestId: 'H1', target: 'B', question: 'check', expected: 'source', workId: a.id, fence: { epoch: 1, goalVersion: 1 } });
    const b = h.claim('assistance'); h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'R1', status: 'success', answer: 'answer', workId: b.id, fence: { epoch: 1, goalVersion: 1 } });
    const pending = h.engine.pending(h.room, h.task)[0]!;
    expect(h.engine.claim(h.room, h.task, pending.id)).toBeNull(); expect(h.context().usage.ordinary).toBe(2); expect(h.view().phase).toBe('ended');
  });
  it('[BT_F02] assistance and replan limits are enforced', () => {
    const h = new Harness(configuration({ assists: 1 })); h.help(); h.result();
    expect(h.help('H2').code).toBe('ASSISTANCE_LIMIT');
    const g = new Harness(configuration({ replans: 0 })); g.event({ type: 'BLOCKED', reason: 'blocked' });
    expect(g.event({ type: 'COORDINATE', decision: { action: 'replan', plan: 'new path', reason: 'test' } }).code).toContain('REPLAN_LIMIT');
  });
  it('[BT_F03] reserved check capacity cannot be spent on ordinary work', () => {
    const h = new Harness(configuration({ ordinary: 1, checks: 1 })); const op = h.claim('owner');
    h.event({ type: 'DELIVER', text: 'finished', artifactIds: [], workId: op.id, fence: { epoch: 1, goalVersion: 1 } });
    expect(h.claim('check')).toBeDefined(); expect(h.context().usage).toMatchObject({ ordinary: 1, checks: 1 });
  });
  it('[BT_F04] exhausted checking quota terminates without another explanation model', () => {
    const h = new Harness(configuration({ ordinary: 0, checks: 0 }));
    h.event({ type: 'DELIVER', text: 'partial', artifactIds: [] });
    expect(h.engine.claim(h.room, h.task, h.engine.pending(h.room, h.task)[0]!.id)).toBeNull();
    expect(h.view().phase).toBe('ended'); expect(h.context().outcome).toBe('partial'); expect(h.context().usage.checks).toBe(0);
  });
  it('[BT_F05] missing and infinite limits are invalid', () => {
    const c = configuration(); (c.limits as unknown as Record<string, unknown>).ordinary = undefined;
    expect(() => validateConfig(c)).toThrow('Missing finite limit');
    c.limits.ordinary = Infinity; expect(() => validateConfig(c)).toThrow();
  });
  it('[BT_F07] text claiming files exist cannot satisfy missing artifacts', () => {
    const h = new Harness(); h.event({ type: 'USER_INPUT', text: 'two files', goal: { ...h.context().goal, requiredArtifacts: 2 } });
    h.event({ type: 'DELIVER', text: 'files are done', artifactIds: ['missing1', 'missing2'] });
    h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'check' });
    expect(h.view().phase).toBe('coordinating'); expect(h.context().outcome).toBeNull();
  });
  it('[BT_F08] a semantic gap triggers bounded correction', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: 'draft', artifactIds: [] });
    h.event({ type: 'CHECK_RESULT', passed: false, gaps: ['Missing user constraint'], resultId: 'check' });
    expect(h.view().phase).toBe('coordinating'); expect(h.context().reason).toContain('Missing user constraint');
  });
  it('[BT_F09] an unsettled helper cannot be bypassed by a delivery', () => {
    const h = new Harness(); h.help(); expect(h.event({ type: 'DELIVER', text: 'premature', artifactIds: [] }).ok).toBe(false);
    expect(h.context().outcome).toBeNull(); expect(h.view().phase).toBe('waitingAssistance');
  });
  it('[BT_F10] marks partial and failed results truthfully', () => {
    const h = new Harness(configuration({ ordinary: 0 })); h.event({ type: 'DELIVER', text: 'partial', artifactIds: [] });
    h.event({ type: 'CHECK_RESULT', passed: false, gaps: ['missing evidence'], resultId: 'check' });
    expect(h.context().outcome).toBe('partial');
    const g = new Harness(configuration({ ordinary: 0 })); const pending = g.engine.pending(g.room, g.task)[0]!;
    g.engine.claim(g.room, g.task, pending.id); expect(g.context().outcome).toBe('failed');
  });
  it('[BT_F11] an invalid current judgment waits safely, never passes completion', () => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'blocked' });
    expect(h.event({ type: 'COORDINATE', decision: { action: 'unsupported', reason: 'bad output' } as unknown as Decision }).ok).toBe(false);
    expect(h.view().phase).toBe('waitingHuman'); expect(h.context().outcome).toBeNull();
  });
});

describe('configuration and driver', () => {
  it('[BT_U05] new configuration enables a new member without changing history', () => {
    const c = configuration(); c.bots.push({ id: 'C', name: 'C', instructions: 'check', tools: [] });
    const h = new Harness(c); h.engine.submit('other', { id: 'C1', text: 'check', mentions: ['C'] });
    expect(h.engine.view('other')?.context.owner).toBe('C');
  });
  it('[BT_U06] incompatible versions block restoration', () => {
    const h = new Harness(); const current = configuration(); current.version = 'v2';
    const e = new TeamEngine(h.store, current, () => h.now); e.recover(h.room);
    expect(e.view(h.room, h.task)?.phase).toBe('waitingHuman'); expect(e.pending(h.room, h.task)).toEqual([]);
  });
  it('[BT_U07] removed permissions cannot be supplied by an old snapshot', () => {
    const h = new Harness(); h.event({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} });
    const current = configuration(); current.bots[0]!.tools = [];
    const e = new TeamEngine(h.store, current, () => 0); e.recover(h.room);
    expect(e.view(h.room, h.task)?.phase).toBe('waitingHuman'); expect(e.pending(h.room, h.task)).toEqual([]);
    expect(e.send(h.room, h.task, { id: 'retrytool', at: 0, type: 'TOOL', tool: 'read', replay: 'safe', payload: {} }).ok).toBe(false);
  });
  it('[BT_U08] old identities survive configuration removal', () => {
    const h = new Harness(); h.help(); h.result();
    const c = configuration(); c.bots = c.bots.filter(b => b.id !== 'B');
    const e = new TeamEngine(h.store, c, () => 0); e.recover(h.room);
    expect(e.timeline(h.room).some(m => m.author === 'B')).toBe(true);
  });
  it('[BT_E01] runs the full collaboration using a real XState-backed driver', async () => {
    const h = new Harness(); let ownerCalls = 0; const kinds: string[] = [];
    const runner = new WorkRunner(h.engine, { async execute(work) {
      kinds.push(work.kind);
      if (work.kind === 'owner') return ++ownerCalls === 1
        ? { type: 'help', requestId: 'H1', target: 'B', question: 'official recovery boundary', expected: 'official evidence' }
        : { type: 'deliver', text: 'Final plan with evidence', artifactIds: [] };
      if (work.kind === 'assistance') return { type: 'answer', text: 'Recovery supported; external writes need idempotency' };
      return { type: 'check', passed: true, gaps: [] };
    } }, () => h.now);
    for (let n = 0; n < 10 && await runner.runOne(h.room, h.task); n++) { /* bounded host loop */ }
    expect(h.context().outcome).toBe('complete'); expect(kinds).toEqual(['owner', 'assistance', 'owner', 'check']);
    expect(h.context().messages.map(m => m.kind)).toEqual(['user', 'help', 'answer', 'final']);
  });
  it('invalid worker output cannot strand an unconsumed helper', async () => {
    const h = new Harness(); h.help();
    const runner = new WorkRunner(h.engine, { async execute() { return { type: 'deliver', text: 'invalid helper result', artifactIds: [] }; } }, () => 0);
    await runner.runOne(h.room, h.task);
    expect(h.context().assists[0]?.status).toBe('failed'); expect(h.view().phase).toBe('running');
  });
  it('a human adoption after delivery records a decision without restarting work', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: 'finished', artifactIds: [] }); h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'C1' });
    h.engine.submit(h.room, { id: 'adopt', text: 'adopt option two', intent: 'decision' });
    expect(h.view().phase).toBe('ended'); expect(h.context().board.at(-1)?.author).toBe('user');
    expect(Object.keys(h.store.read(h.room).tasks)).toHaveLength(1);
  });
  it('malformed check booleans cannot turn a failed judgment into success', async () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
    const runner = new WorkRunner(h.engine, { async execute() { return { type: 'check', passed: 'false', gaps: [] } as never; } }, () => 0);
    await runner.runOne(h.room, h.task); expect(h.context().outcome).toBeNull(); expect(h.view().phase).toBe('waitingHuman');
  });
  it('malformed decision values are rejected without crashing storage', () => {
    const h = new Harness(); h.event({ type: 'BLOCKED', reason: 'blocked' });
    const result = h.event({ type: 'COORDINATE', decision: { action: 'askUser', question: 99, reason: 'bad payload' } as never });
    expect(result.ok).toBe(false); expect(h.view().phase).toBe('waitingHuman');
    expect(h.engine.submit('new', { id: 'new', text: 'still healthy' }).ok).toBe(true);
  });
  it('[BT_F01] nested provider requests must use the same persistent budget', async () => {
    const h = new Harness(configuration({ ordinary: 2 })); let emitted = 0;
    const runner = new WorkRunner(h.engine, { async execute(_work, _signal, scope) {
      emitted++; scope.authorizeAdditionalRequest('second'); emitted++;
      scope.authorizeAdditionalRequest('third'); emitted++;
      return { type: 'answer', text: 'should never reach' };
    } }, () => 0);
    await runner.runOne(h.room, h.task);
    expect(emitted).toBe(2); expect(h.context().usage.ordinary).toBe(2); expect(h.view().phase).toBe('waitingHuman');
  });
  it('[BT_U07] a queued helper loses revoked tools before dispatch', () => {
    const h = new Harness(); h.event({ type: 'HELP', requestId: 'H1', caller: 'A', target: 'B', question: 'read source', expected: 'evidence', requiredTools: ['read'] });
    const config = configuration(); config.bots[1]!.tools = [];
    const e = new TeamEngine(h.store, config, () => 0); e.recover(h.room);
    expect(e.view(h.room, h.task)?.phase).toBe('waitingHuman'); expect(e.pending(h.room, h.task)).toEqual([]);
  });
  it('a persistent stop aborts the active adapter and waits for acknowledgement', async () => {
    const h = new Harness();
    const runner = new WorkRunner(h.engine, { execute(_work, signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } }, () => 0);
    const running = runner.runOne(h.room, h.task); h.event({ type: 'STOP' });
    await runner.runOne(h.room, h.task); await running;
    expect(h.context().outcome).toBe('stopped');
  });
});
