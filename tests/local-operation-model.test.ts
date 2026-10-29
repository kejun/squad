import { LocalModel, localModelInput, discussionUncertainModel } from './local-model-fixture.js';
import { describe, it, expect } from 'vitest';
import { initialTask, stepTask, persistTask, restoreTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import { localPhysicalPending, type LocalAction } from '../src/local-operation.js';
import type { Intent, TaskEvent, TaskInput } from '../src/types.js';


describe('persisted local operations in the real taskMachine', () => {
  it('[BT_L02] saves/claims/runs/settles a child without replacing its parent', () => {
    const m = new LocalModel(); expect(m.request().ok).toBe(true); expect(m.op?.status).toBe('queued'); expect(m.op?.namespace).toBe('c'.repeat(64)); expect(m.c.usage.ordinary).toBe(1);
    expect(m.claim().ok).toBe(true); expect(m.c.usage.ordinary).toBe(2); expect(m.started().ok).toBe(true);
    expect(m.result().ok).toBe(true); expect(m.op?.status).toBe('succeeded'); expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined(); expect(taskPhase(m.snapshot)).toBe('running');
    expect(m.result().code).toBe('LOCAL_SESSION_MISMATCH'); expect(m.c.usage.ordinary).toBe(2);
  });
  it('[BT_L02] metadata is free and loaded skills are version-bound', () => {
    const m = new LocalModel(); m.request({ type: 'listSkills' }); m.claim(); m.result(); expect(m.c.usage.ordinary).toBe(1);
    const n = new LocalModel(); n.request({ type: 'loadSkill', skillId: 's1' }); n.claim();
    n.result({ result: { ok: true, code: 'loaded', data: { skillId: 's1', skillVersion: 'sha1' } } });
    expect(n.c.intents[0]!.localSkills).toEqual([{ skillId: 's1', skillVersion: 'sha1' }]);
  });
  it('[BT_L03] preserves ordinary budget, identities, phase and current authority', () => {
    for (const constraint of ['budget', 'stopped', 'expired', 'stale', 'disabled', 'legacy', 'interpretation', 'lease']) {
      const m = new LocalModel(i => { if (constraint === 'budget') i.config.limits.ordinary = 1; if (constraint === 'disabled') i.config.localTools = { enabled: false }; });
      if (constraint === 'stopped') m.send({ type: 'STOP' });
      if (constraint === 'expired') m.at = 1001;
      if (constraint === 'stale') m.snapshot.context.goalVersion++;
      if (constraint === 'legacy') delete (m.c.intents[0]!.payload.capabilities as Record<string, unknown>).localTools;
      if (constraint === 'interpretation') m.c.intents[0]!.kind = 'interpretation';
      const saved = m.request(); const result = saved.ok ? m.claim(constraint !== 'lease') : saved;
      const codes: Record<string, string> = { budget: 'BUDGET_EXHAUSTED', stopped: 'STOPPED', expired: 'WORK_EXPIRED', stale: 'STALE_WORK', disabled: 'LOCAL_TOOLS_DISABLED', legacy: 'LOCAL_TOOLS_NOT_AUTHORIZED', interpretation: 'LOCAL_TOOLS_NOT_ALLOWED', lease: 'WORKSPACE_BUSY' };
      expect(result.code, constraint).toBe(codes[constraint]); expect(m.c.usage.ordinary).toBe(1); expect(m.op?.sessionId).toBeUndefined();
    }
  });
  it('[BT_L03] keeps review/discussion synthesis reservations even for check children', () => {
    for (const kind of ['review', 'discussion']) {
      const m = new LocalModel(i => { i.config.limits.ordinary = 2; });
      if (kind === 'review') m.c.review = { id: 'r', request: 'review', targets: ['B'], completed: [], status: 'reviewing', epoch: 1, goalVersion: 1 };
      else m.c.discussion = { id: 'd', request: 'discuss', targets: ['B'], results: [], skipped: [], status: 'collecting', epoch: 1, goalVersion: 1 };
      m.request(); expect(m.claim().code).toBe(kind === 'review' ? 'REVIEW_SYNTHESIS_RESERVED' : 'DISCUSSION_BUDGET_RESERVED');
    }
    const m = new LocalModel(); m.result(); m.c.intents[0]!.status = 'done';
    m.send({ type: 'DELIVER', text: 'candidate', artifactIds: [] }); const check = m.c.intents.at(-1)!;
    m.send({ type: 'CLAIM', intentId: check.id }); m.work = m.c.intents.at(-1)!;
    expect(m.request().ok).toBe(true); expect(m.claim().ok).toBe(true); expect(m.c.usage.checks).toBe(1); expect(m.c.usage.ordinary).toBe(2);
  });
  it('[BT_L05] all stop and late-result orders retain the physical lock until settlement', () => {
    for (const stage of ['queued', 'claimed', 'running']) {
      const m = new LocalModel(); m.request(); if (stage !== 'queued') m.claim(); if (stage === 'running') m.started();
      m.send({ type: 'STOP' }); expect(m.request().code).toBe('STOPPED');
      if (stage !== 'queued') {
        expect(m.op?.status).toBe('cancelling'); expect(m.send({ type: 'SETTLE', intentId: m.work.id }).code).toBe('LOCAL_OPERATION_PENDING');
        expect(localPhysicalPending(m.c.intents[0]!)).toBe(true); expect(m.result({ sessionId: 'wrong' }).ok).toBe(false);
        m.result({ result: { ok: false, code: 'cancelled', data: {} } });
      }
      m.send({ type: 'SETTLE', intentId: m.work.id }); expect(m.c.candidate).toBeNull(); expect(taskPhase(m.snapshot)).toBe('ended');
    }
  });
  it('[BT_L06] crash windows never replay a claimed write and keep saved receipts', () => {
    for (const stage of ['before', 'queued', 'claimed', 'running', 'succeeded']) {
      const m = new LocalModel(); if (stage !== 'before') m.request(); if (['claimed', 'running', 'succeeded'].includes(stage)) m.claim();
      if (['running', 'succeeded'].includes(stage)) m.started(); if (stage === 'succeeded') m.result();
      m.send({ type: 'RECOVER', config: localModelInput().config });
      if (['claimed', 'running'].includes(stage)) {
        expect(m.op?.status).toBe('uncertain'); expect(m.c.intents[0]!.status).toBe('uncertain'); expect(taskPhase(m.snapshot)).toBe('waitingHuman');
        expect(m.send({ type: 'RECONCILE', intentId: m.work.id, resolution: 'confirmed', detail: 'cannot bypass' }).code).toBe('LOCAL_OPERATION_PENDING');
        expect(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'host proved no spawn' }).ok).toBe(true);
        expect(m.op?.status).toBe('queued'); expect(taskPhase(m.snapshot)).toBe('running');
      } else {
        expect(m.c.intents[0]!.status).toBe('pending');
        if (stage === 'succeeded') expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
      }
    }
  });
  it('[BT_L06] [BT_L14] unknown effects hold the lock, trustworthy receipts settle only the old operation', () => {
    const m = new LocalModel(); m.request(); m.claim(); m.started(); m.result({ effectsKnown: false });
    expect(m.op?.status).toBe('uncertain'); m.c.goalVersion++;
    m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable receipt', result: { ok: true, code: 'succeeded', data: { exitCode: 0 } } });
    expect(m.c.intents[0]!.status).toBe('done'); expect(m.c.candidate).toBeNull();
  });
  it('[BT_L12] recovery revokes permissions without granting legacy payloads', () => {
    for (const legacy of [true, false]) {
      const m = new LocalModel(); if (legacy) delete (m.c.intents[0]!.payload.capabilities as Record<string, unknown>).localTools;
      const config = localModelInput().config; if (!legacy) config.bots[0]!.localTools = false;
      m.send({ type: 'RECOVER', config }); m.send({ type: 'CLAIM', intentId: m.work.id }); m.work = m.c.intents[0]!;
      expect(m.request().code).toBe(legacy ? 'LOCAL_TOOLS_NOT_AUTHORIZED' : 'LOCAL_TOOLS_DISABLED');
    }
  });
  it('[BT_L16] an uncertain background operation cannot discard the live owner draft', discussionUncertainModel);
  it('[BT_L12] a trusted receipt settles effects but cannot resume an incompatible execution', () => {
    for (const resultType of ['LOCAL_RESULT', 'LOCAL_RECONCILE']) {
      const m = new LocalModel(); m.request(); m.claim(); m.started();
      const config = localModelInput().config; config.toolVersion = 'new-protocol'; m.send({ type: 'RECOVER', config });
      expect(m.c.reason).toBe('Execution version incompatible');
      if (resultType === 'LOCAL_RESULT') m.result();
      else m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'trusted receipt', result: { ok: true, code: 'succeeded', data: {} } });
      expect(m.c.reason).toBe('Execution version incompatible'); expect(taskPhase(m.snapshot)).toBe('waitingHuman');
      expect(m.c.intents[0]!.status).toBe('done');
      expect(m.request().code).toBe('INCOMPATIBLE_EXECUTION');
    }
  });
  it('[BT_L18] pins activated versions across member handoffs and snapshot recovery', () => {
    const m = new LocalModel(); m.request({ type: 'loadSkill', skillId: 'skill1' }); m.claim();
    m.result({ result: { ok: true, code: 'loaded', data: { skillId: 'skill1', skillVersion: 'b'.repeat(64) } } });
    expect(m.c.localSkillVersions).toEqual([{ skillId: 'skill1', skillVersion: 'b'.repeat(64) }]);
    expect(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' }).ok).toBe(true);
    m.send({ type: 'RECOVER', config: localModelInput().config });
    expect(m.c.intents.at(-1)!.localSkills).toEqual(m.c.localSkillVersions);
    const old = new LocalModel(); old.request({ type: 'loadSkill', skillId: 'skill1' }); old.claim(); old.c.goalVersion++; old.c.localSkillVersions = [];
    old.result({ result: { ok: true, code: 'loaded', data: { skillId: 'skill1', skillVersion: 'b'.repeat(64) } } });
    expect(old.c.localSkillVersions).toEqual([]);
  });
  it('[BT_L17] only check work can claim host version verification and it reserves the workspace', () => {
    const owner = new LocalModel(); expect(owner.request({ type: 'verifyWorkspace', expectedRevision: 'b'.repeat(64) }).code).toBe('WORKSPACE_VALIDATION_NOT_ALLOWED');
    const m = new LocalModel(); m.c.intents[0]!.status = 'done'; m.send({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
    const check = m.c.intents.at(-1)!; m.send({ type: 'CLAIM', intentId: check.id }); m.work = m.c.intents.at(-1)!;
    expect(m.request({ type: 'verifyWorkspace', expectedRevision: 'b'.repeat(64) }).ok).toBe(true);
    expect(m.claim(false).code).toBe('WORKSPACE_BUSY'); expect(m.c.usage.ordinary).toBe(1);
    expect(m.claim().ok).toBe(true); expect(m.c.usage.ordinary).toBe(2); expect(m.c.usage.checks).toBe(1);
    expect(m.result().ok).toBe(true);
  });
  it('[BT_L03] settles a denied queued operation without any I/O or budget charge', () => {
    const m = new LocalModel(i => { i.config.limits.ordinary = 1; }); m.request(); expect(m.claim().code).toBe('BUDGET_EXHAUSTED');
    expect(m.send({ type: 'LOCAL_REJECTED', intentId: m.work.id, operationId: 'op1', parentAttempt: m.work.attempt, result: { ok: false, code: 'BUDGET_EXHAUSTED', data: {} } }).ok).toBe(true);
    expect(m.op?.status).toBe('failed'); expect(m.c.usage.ordinary).toBe(1); expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined();
  });
  it('[BT_L03] rejects conflicts, invalid action shapes, mismatched sessions and unfinished delivery', () => {
    const m = new LocalModel(); m.request(); expect(m.request().code).toBe('LOCAL_ALREADY_REQUESTED'); m.claim();
    expect(m.send({ type: 'DELIVER', text: 'premature', artifactIds: [], workId: m.work.id, fence: m.work }).code).toBe('LOCAL_OPERATION_PENDING');
    expect(m.c.candidate).toBeNull(); expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.result({ sessionId: 'alien' }).code).toBe('LOCAL_SESSION_MISMATCH');
  });
});
