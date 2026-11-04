import { describe, it, expect } from 'vitest';
import { LocalModel, localModelInput, discussionUncertainModel } from './local-model-fixture.js';
import { taskPhase } from '../src/task.machine.js';
import { localPhysicalPending } from '../src/local-operation.js';
import type { TaskInput } from '../src/types.js';

function queuedOperation(change?: (input: TaskInput) => void) {
  const m = new LocalModel(change); m.request(); return m;
}
function claimedOperation() { const m = queuedOperation(); m.claim(); return m; }
function runningOperation() { const m = claimedOperation(); m.started(); return m; }
function completedOperation() { const m = runningOperation(); m.result(); return m; }
function checkWork() {
  const m = new LocalModel(); m.c.intents[0]!.status = 'done';
  m.send({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
  const check = m.c.intents.at(-1)!; m.send({ type: 'CLAIM', intentId: check.id });
  m.work = m.c.intents.at(-1)!; return m;
}
function activatedSkill() {
  const m = new LocalModel(); m.request({ type: 'loadSkill', skillId: 'skill1' }); m.claim(); return m;
}
const skillReceipt = () => ({ result: { ok: true, code: 'loaded', data: { skillId: 'skill1', skillVersion: 'b'.repeat(64) } } });

describe('persisted local operations in the real taskMachine', () => {
  it('[BT_L02] [BT_L19] returns the child receipt to the same parent without another budget charge', () => {
    const m = runningOperation();

    const reply = m.result();

    expect(reply.ok).toBe(true);
    expect(m.op?.status).toBe('succeeded');
    expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined();
    expect(m.c.usage.ordinary).toBe(2);
    expect(taskPhase(m.snapshot)).toBe('running');
  });

  it('[BT_L19] refuses a repeated local receipt without charging again', () => {
    const m = completedOperation();
    const reply = m.result();
    expect(reply.code).toBe('LOCAL_SESSION_MISMATCH');
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L02] does not charge ordinary quota for catalog metadata', () => {
    const m = new LocalModel();
    m.request({ type: 'listSkills' }); m.claim(); m.result();
    expect(m.c.usage.ordinary).toBe(1);
  });

  it('[BT_L21] binds a loaded skill to the version in its receipt', () => {
    const m = activatedSkill();
    m.result(skillReceipt());
    expect(m.c.intents[0]!.localSkills).toEqual([{ skillId: 'skill1', skillVersion: 'b'.repeat(64) }]);
  });

  it.each([
    { name: 'budget', code: 'BUDGET_EXHAUSTED', prepare: () => queuedOperation(i => { i.config.limits.ordinary = 1; }), act: (m: LocalModel) => m.claim() },
    { name: 'stopped', code: 'STOPPED', prepare: () => { const m = new LocalModel(); m.send({ type: 'STOP' }); return m; }, act: (m: LocalModel) => m.request() },
    { name: 'expired', code: 'WORK_EXPIRED', prepare: () => { const m = new LocalModel(); m.at = 1001; return m; }, act: (m: LocalModel) => m.request() },
    { name: 'stale goal', code: 'STALE_WORK', prepare: () => { const m = new LocalModel(); m.c.goalVersion++; return m; }, act: (m: LocalModel) => m.request() },
    { name: 'disabled tools', code: 'LOCAL_TOOLS_DISABLED', prepare: () => new LocalModel(i => { i.config.localTools = { enabled: false }; }), act: (m: LocalModel) => m.request() },
    { name: 'legacy authority', code: 'LOCAL_TOOLS_NOT_AUTHORIZED', prepare: () => { const m = new LocalModel(); delete (m.work.payload.capabilities as Record<string, unknown>).localTools; return m; }, act: (m: LocalModel) => m.request() },
    { name: 'interpretation work', code: 'LOCAL_TOOLS_NOT_ALLOWED', prepare: () => { const m = new LocalModel(); m.work.kind = 'interpretation'; return m; }, act: (m: LocalModel) => m.request() },
    { name: 'busy lease', code: 'WORKSPACE_BUSY', prepare: queuedOperation, act: (m: LocalModel) => m.claim(false) },
  ])('[BT_L03] rejects $name without a session or extra charge', ({ prepare, act, code }) => {
    const m = prepare();
    const reply = act(m);
    expect(reply.code).toBe(code);
    expect(m.c.usage.ordinary).toBe(1);
    expect(m.op?.sessionId).toBeUndefined();
  });

  it.each([
    { name: 'review', code: 'REVIEW_SYNTHESIS_RESERVED', prepare: () => {
      const m = new LocalModel(i => { i.config.limits.ordinary = 2; });
      m.c.review = { id: 'r', request: 'review', targets: ['B'], completed: [], status: 'reviewing', epoch: 1, goalVersion: 1 };
      m.request(); return m;
    } },
    { name: 'discussion', code: 'DISCUSSION_BUDGET_RESERVED', prepare: () => {
      const m = new LocalModel(i => { i.config.limits.ordinary = 2; });
      m.c.discussion = { id: 'd', request: 'discuss', targets: ['B'], results: [], skipped: [], status: 'collecting', epoch: 1, goalVersion: 1 };
      m.request(); return m;
    } },
  ])('[BT_L03] preserves reserved $name synthesis quota', ({ prepare, code }) => {
    const m = prepare();
    const reply = m.claim();
    expect(reply.code).toBe(code);
    expect(m.c.usage.ordinary).toBe(1);
  });

  it('[BT_L03] charges ordinary quota for a local child of final checking', () => {
    const m = checkWork(); m.request();
    const reply = m.claim();
    expect(reply.ok).toBe(true);
    expect(m.c.usage.checks).toBe(1);
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L05] stops queued local work without waiting for a physical process', () => {
    const m = queuedOperation();
    m.send({ type: 'STOP' });
    m.send({ type: 'SETTLE', intentId: m.work.id });
    expect(taskPhase(m.snapshot)).toBe('ended');
    expect(m.c.candidate).toBeNull();
    expect(m.request().code).toBe('STOPPED');
  });

  it.each([
    { stage: 'claimed', prepare: claimedOperation },
    { stage: 'running', prepare: runningOperation },
  ])('[BT_L05] [BT_L22] holds $stage physical work until a matching cancellation receipt', ({ prepare }) => {
    const m = prepare();
    m.send({ type: 'STOP' });
    expect(m.request().code).toBe('STOPPED');
    expect(m.op?.status).toBe('cancelling');
    expect(m.send({ type: 'SETTLE', intentId: m.work.id }).code).toBe('LOCAL_OPERATION_PENDING');
    expect(localPhysicalPending(m.c.intents[0]!)).toBe(true);
    expect(m.result({ sessionId: 'wrong' }).ok).toBe(false);

    m.result({ result: { ok: false, code: 'cancelled', data: {} } });
    m.send({ type: 'SETTLE', intentId: m.work.id });

    expect(m.c.candidate).toBeNull();
    expect(taskPhase(m.snapshot)).toBe('ended');
  });

  it.each([
    { stage: 'before request', prepare: () => new LocalModel() },
    { stage: 'queued', prepare: queuedOperation },
    { stage: 'succeeded', prepare: completedOperation },
  ])('[BT_L06] [BT_L20] requeues safe parent work after a crash at $stage', ({ prepare }) => {
    const m = prepare();
    m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.c.intents[0]!.status).toBe('pending');
  });

  it('[BT_L06] retains a saved receipt across recovery', () => {
    const m = completedOperation();
    m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
  });

  it.each([
    { stage: 'claimed', prepare: claimedOperation },
    { stage: 'running', prepare: runningOperation },
  ])('[BT_L06] [BT_L20] requires trustworthy reconciliation after a crash at $stage', ({ prepare }) => {
    const m = prepare();
    m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.op?.status).toBe('uncertain');
    expect(m.c.intents[0]!.status).toBe('uncertain');
    expect(taskPhase(m.snapshot)).toBe('waitingHuman');
    expect(m.send({ type: 'RECONCILE', intentId: m.work.id, resolution: 'confirmed', detail: 'cannot bypass' }).code).toBe('LOCAL_OPERATION_PENDING');

    const reply = m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'host proved no spawn' });

    expect(reply.ok).toBe(true);
    expect(m.op?.status).toBe('queued');
    expect(taskPhase(m.snapshot)).toBe('running');
  });

  it('[BT_L06] [BT_L14] settles an old-goal receipt without producing a current candidate', () => {
    const m = runningOperation(); m.result({ effectsKnown: false }); m.c.goalVersion++;
    m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable receipt', result: { ok: true, code: 'succeeded', data: { exitCode: 0 } } });
    expect(m.c.intents[0]!.status).toBe('done');
    expect(m.c.candidate).toBeNull();
  });

  it.each([
    { name: 'legacy payload', code: 'LOCAL_TOOLS_NOT_AUTHORIZED', prepare: () => {
      const m = new LocalModel(); delete (m.work.payload.capabilities as Record<string, unknown>).localTools;
      return { m, config: localModelInput().config };
    } },
    { name: 'revoked bot permission', code: 'LOCAL_TOOLS_DISABLED', prepare: () => {
      const config = localModelInput().config; config.bots[0]!.localTools = false;
      return { m: new LocalModel(), config };
    } },
  ])('[BT_L12] refuses local work after recovering $name', ({ prepare, code }) => {
    const { m, config } = prepare();
    m.send({ type: 'RECOVER', config }); m.send({ type: 'CLAIM', intentId: m.work.id }); m.work = m.c.intents[0]!;
    expect(m.request().code).toBe(code);
  });

  it('[BT_L16] preserves the live owner draft while background effects are uncertain', discussionUncertainModel);

  it.each([
    { type: 'LOCAL_RESULT', settle: (m: LocalModel) => m.result() },
    { type: 'LOCAL_RECONCILE', settle: (m: LocalModel) => m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'trusted receipt', result: { ok: true, code: 'succeeded', data: {} } }) },
  ])('[BT_L12] keeps incompatible work paused after $type settles its effects', ({ settle }) => {
    const m = runningOperation(), config = localModelInput().config;
    config.toolVersion = 'new-protocol'; m.send({ type: 'RECOVER', config });

    settle(m);

    expect(m.c.reason).toBe('Execution version incompatible');
    expect(taskPhase(m.snapshot)).toBe('waitingHuman');
    expect(m.c.intents[0]!.status).toBe('done');
    expect(m.request().code).toBe('INCOMPATIBLE_EXECUTION');
  });

  it('[BT_L18] carries an activated skill version through handoff and recovery', () => {
    const m = activatedSkill(); m.result(skillReceipt());
    m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' });

    m.send({ type: 'RECOVER', config: localModelInput().config });

    expect(m.c.localSkillVersions).toEqual([{ skillId: 'skill1', skillVersion: 'b'.repeat(64) }]);
    expect(m.c.intents.at(-1)!.localSkills).toEqual(m.c.localSkillVersions);
  });

  it('[BT_L18] refuses to activate a skill version from an old goal receipt', () => {
    const m = activatedSkill(); m.c.goalVersion++; m.c.localSkillVersions = [];
    m.result(skillReceipt());
    expect(m.c.localSkillVersions).toEqual([]);
  });

  it('[BT_L17] refuses host version verification from owner work', () => {
    const m = new LocalModel();
    expect(m.request({ type: 'verifyWorkspace', expectedRevision: 'b'.repeat(64) }).code).toBe('WORKSPACE_VALIDATION_NOT_ALLOWED');
  });

  it('[BT_L17] reserves a workspace and ordinary quota for final version verification', () => {
    const m = checkWork(); m.request({ type: 'verifyWorkspace', expectedRevision: 'b'.repeat(64) });
    expect(m.claim(false).code).toBe('WORKSPACE_BUSY');
    expect(m.c.usage.ordinary).toBe(1);

    const reply = m.claim();

    expect(reply.ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(2);
    expect(m.c.usage.checks).toBe(1);
    expect(m.result().ok).toBe(true);
  });

  it('[BT_L03] settles a denied queued operation without an I/O budget charge', () => {
    const m = queuedOperation(i => { i.config.limits.ordinary = 1; }); m.claim();
    const reply = m.send({ type: 'LOCAL_REJECTED', intentId: m.work.id, operationId: 'op1', parentAttempt: m.work.attempt, result: { ok: false, code: 'BUDGET_EXHAUSTED', data: {} } });
    expect(reply.ok).toBe(true);
    expect(m.op?.status).toBe('failed');
    expect(m.c.usage.ordinary).toBe(1);
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined();
  });

  it('[BT_L19] [BT_L22] records sandbox unavailability without authorizing another command', () => {
    const m = claimedOperation();
    const reply = m.result({ result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: {} } });
    expect(reply.ok).toBe(true);
    expect(m.op?.status).toBe('failed');
    expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('CLI_SANDBOX_UNAVAILABLE');
    expect(m.result().ok).toBe(false);
    expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_L03] refuses a second local operation while the first is queued', () => {
    const m = queuedOperation();
    expect(m.request().code).toBe('LOCAL_ALREADY_REQUESTED');
  });

  it('[BT_L03] refuses delivery while a local operation is pending', () => {
    const m = claimedOperation();
    const reply = m.send({ type: 'DELIVER', text: 'premature', artifactIds: [], workId: m.work.id, fence: m.work });
    expect(reply.code).toBe('LOCAL_OPERATION_PENDING');
    expect(m.c.candidate).toBeNull();
    expect(m.c.intents[0]!.status).toBe('inflight');
  });

  it('[BT_L03] refuses a receipt from another session', () => {
    const m = claimedOperation();
    expect(m.result({ sessionId: 'alien' }).code).toBe('LOCAL_SESSION_MISMATCH');
  });
});
