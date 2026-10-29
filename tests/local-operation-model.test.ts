import { describe, it, expect } from 'vitest';
import { initialTask, stepTask, persistTask, restoreTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import { localPhysicalPending, type LocalAction } from '../src/local-operation.js';
import type { Intent, TaskEvent, TaskInput } from '../src/types.js';

const input = (): TaskInput => ({ taskId: 'local-model', owner: 'A', at: 0,
  message: { id: 'M', taskId: 'local-model', author: 'user', kind: 'user', text: '实现并验证', at: 0 },
  goal: { text: '实现并验证', constraints: [], criteria: ['测试通过'], requiredArtifacts: 0 },
  config: { version: 'v1', toolVersion: 'v1', defaultBot: 'A', inputAnalysis: { enabled: false },
    bots: [{ id: 'A', name: '方案师', instructions: '', tools: ['read'] }, { id: 'B', name: '核查员', instructions: '', tools: ['read'] }],
    limits: { ordinary: 30, checks: 5, assists: 5, replans: 5, retries: 3, workTimeoutMs: 1000, progressIntervalMs: 1000, repeatThreshold: 3 } } });
class Model {
  snapshot: TaskSnapshot; seq = 0; at = 1; work: Intent;
  constructor(change?: (i: TaskInput) => void) {
    const i = input(); change?.(i); this.snapshot = initialTask(i); this.work = this.snapshot.context.intents[0]!;
    this.send({ type: 'CLAIM', intentId: this.work.id }); this.work = this.snapshot.context.intents[0]!;
  }
  send(body: Record<string, unknown>) {
    this.snapshot = stepTask(this.snapshot, { id: `e${++this.seq}`, at: this.at, ...body } as TaskEvent);
    // Every model step must survive the real persisted-snapshot round trip.
    this.snapshot = restoreTask(structuredClone(persistTask(this.snapshot)));
    return this.snapshot.context.reply;
  }
  request(action: LocalAction = { type: 'runCli', executable: 'node', args: ['script.js'] }) {
    return this.send({ type: 'LOCAL_REQUEST', intentId: this.work.id, operationId: 'op1', requestHash: 'a'.repeat(64), action,
      parentAttempt: this.work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], workspaceId: 'project', fence: this.work });
  }
  claim(leaseAvailable = true) { return this.send({ type: 'LOCAL_CLAIM', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', parentAttempt: this.work.attempt, leaseAvailable, fence: this.work }); }
  started() { return this.send({ type: 'LOCAL_STARTED', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', workspaceRevision: 'revision1', isolated: false }); }
  result(extra: Record<string, unknown> = {}) { return this.send({ type: 'LOCAL_RESULT', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', result: { ok: true, code: 'succeeded', data: { stdout: 'actual' } }, settled: true, effectsKnown: true, ...extra }); }
  get c() { return this.snapshot.context; }
  get op() { return this.c.intents[0]!.localOperations?.[0]; }
}

describe('persisted local operations in the real taskMachine', () => {
  it('[BT_L02] saves/claims/runs/settles a child without replacing its parent', () => {
    const m = new Model(); expect(m.request().ok).toBe(true); expect(m.op?.status).toBe('queued'); expect(m.c.usage.ordinary).toBe(1);
    expect(m.claim().ok).toBe(true); expect(m.c.usage.ordinary).toBe(2); expect(m.started().ok).toBe(true);
    expect(m.result().ok).toBe(true); expect(m.op?.status).toBe('succeeded'); expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
    expect(m.c.intents[0]!.localCheckpoint?.pendingOperationId).toBeUndefined(); expect(taskPhase(m.snapshot)).toBe('running');
    expect(m.result().code).toBe('LOCAL_SESSION_MISMATCH'); expect(m.c.usage.ordinary).toBe(2);
  });
  it('[BT_L02] metadata is free and loaded skills are version-bound', () => {
    const m = new Model(); m.request({ type: 'listSkills' }); m.claim(); m.result(); expect(m.c.usage.ordinary).toBe(1);
    const n = new Model(); n.request({ type: 'loadSkill', skillId: 's1' }); n.claim();
    n.result({ result: { ok: true, code: 'loaded', data: { skillId: 's1', skillVersion: 'sha1' } } });
    expect(n.c.intents[0]!.localSkills).toEqual([{ skillId: 's1', skillVersion: 'sha1' }]);
  });
  it('[BT_L03] preserves ordinary budget, identities, phase and current authority', () => {
    for (const constraint of ['budget', 'stopped', 'expired', 'stale', 'disabled', 'legacy', 'interpretation', 'lease']) {
      const m = new Model(i => { if (constraint === 'budget') i.config.limits.ordinary = 1; if (constraint === 'disabled') i.config.localTools = { enabled: false }; });
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
      const m = new Model(i => { i.config.limits.ordinary = 2; });
      if (kind === 'review') m.c.review = { id: 'r', request: 'review', targets: ['B'], completed: [], status: 'reviewing', epoch: 1, goalVersion: 1 };
      else m.c.discussion = { id: 'd', request: 'discuss', targets: ['B'], results: [], skipped: [], status: 'collecting', epoch: 1, goalVersion: 1 };
      m.request(); expect(m.claim().code).toBe(kind === 'review' ? 'REVIEW_SYNTHESIS_RESERVED' : 'DISCUSSION_BUDGET_RESERVED');
    }
    const m = new Model(); m.result(); m.c.intents[0]!.status = 'done';
    m.send({ type: 'DELIVER', text: 'candidate', artifactIds: [] }); const check = m.c.intents.at(-1)!;
    m.send({ type: 'CLAIM', intentId: check.id }); m.work = m.c.intents.at(-1)!;
    expect(m.request().ok).toBe(true); expect(m.claim().ok).toBe(true); expect(m.c.usage.checks).toBe(1); expect(m.c.usage.ordinary).toBe(2);
  });
  it('[BT_L05] all stop and late-result orders retain the physical lock until settlement', () => {
    for (const stage of ['queued', 'claimed', 'running']) {
      const m = new Model(); m.request(); if (stage !== 'queued') m.claim(); if (stage === 'running') m.started();
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
      const m = new Model(); if (stage !== 'before') m.request(); if (['claimed', 'running', 'succeeded'].includes(stage)) m.claim();
      if (['running', 'succeeded'].includes(stage)) m.started(); if (stage === 'succeeded') m.result();
      m.send({ type: 'RECOVER', config: input().config });
      if (['claimed', 'running'].includes(stage)) {
        expect(m.op?.status).toBe('uncertain'); expect(m.c.intents[0]!.status).toBe('uncertain'); expect(taskPhase(m.snapshot)).toBe('waitingHuman');
        expect(m.send({ type: 'RECONCILE', intentId: m.work.id, resolution: 'confirmed', detail: 'cannot bypass' }).code).toBe('LOCAL_OPERATION_PENDING');
        expect(m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'host proved no spawn' }).ok).toBe(true);
        expect(m.op?.status).toBe('queued');
      } else {
        expect(m.c.intents[0]!.status).toBe('pending');
        if (stage === 'succeeded') expect(m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content).toContain('actual');
      }
    }
  });
  it('[BT_L06] unknown effects hold the lock, trustworthy receipts settle only the old operation', () => {
    const m = new Model(); m.request(); m.claim(); m.started(); m.result({ effectsKnown: false });
    expect(m.op?.status).toBe('uncertain'); m.c.goalVersion++;
    m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable receipt', result: { ok: true, code: 'succeeded', data: { exitCode: 0 } } });
    expect(m.c.intents[0]!.status).toBe('done'); expect(m.c.candidate).toBeNull();
  });
  it('[BT_L12] recovery revokes permissions without granting legacy payloads', () => {
    for (const legacy of [true, false]) {
      const m = new Model(); if (legacy) delete (m.c.intents[0]!.payload.capabilities as Record<string, unknown>).localTools;
      const config = input().config; if (!legacy) config.bots[0]!.localTools = false;
      m.send({ type: 'RECOVER', config }); m.send({ type: 'CLAIM', intentId: m.work.id }); m.work = m.c.intents[0]!;
      expect(m.request().code).toBe(legacy ? 'LOCAL_TOOLS_NOT_AUTHORIZED' : 'LOCAL_TOOLS_DISABLED');
    }
  });
  it('[BT_L03] rejects conflicts, invalid action shapes, mismatched sessions and unfinished delivery', () => {
    const m = new Model(); m.request(); expect(m.request().code).toBe('LOCAL_ALREADY_REQUESTED'); m.claim();
    expect(m.send({ type: 'DELIVER', text: 'premature', artifactIds: [], workId: m.work.id, fence: m.work }).code).toBe('LOCAL_OPERATION_PENDING');
    expect(m.c.candidate).toBeNull(); expect(m.c.intents[0]!.status).toBe('inflight');
    expect(m.result({ sessionId: 'alien' }).code).toBe('LOCAL_SESSION_MISMATCH');
  });
});
