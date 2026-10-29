import assert from 'node:assert/strict';
import { initialTask, stepTask, persistTask, restoreTask, type TaskSnapshot } from '../src/task.machine.js';
import type { LocalAction } from '../src/local-operation.js';
import type { Intent, TaskEvent, TaskInput } from '../src/types.js';

export const localModelInput = (): TaskInput => ({ taskId: 'local-model', owner: 'A', at: 0,
  message: { id: 'M', taskId: 'local-model', author: 'user', kind: 'user', text: '实现并验证', at: 0 },
  goal: { text: '实现并验证', constraints: [], criteria: ['测试通过'], requiredArtifacts: 0 },
  config: { version: 'v1', toolVersion: 'v1', defaultBot: 'A', inputAnalysis: { enabled: false },
    bots: [{ id: 'A', name: '方案师', instructions: '', tools: ['read'] }, { id: 'B', name: '核查员', instructions: '', tools: ['read'] }],
    limits: { ordinary: 30, checks: 5, assists: 5, replans: 5, retries: 3, workTimeoutMs: 1000, progressIntervalMs: 1000, repeatThreshold: 3 } } });
export class LocalModel {
  snapshot: TaskSnapshot; seq = 0; at = 1; work: Intent;
  constructor(change?: (i: TaskInput) => void) {
    const i = localModelInput(); change?.(i); this.snapshot = initialTask(i); this.work = this.snapshot.context.intents[0]!;
    this.send({ type: 'CLAIM', intentId: this.work.id }); this.work = this.snapshot.context.intents[0]!;
  }
  send(body: Record<string, unknown>) {
    this.snapshot = stepTask(this.snapshot, { id: `e${++this.seq}`, at: this.at, ...body } as TaskEvent);
    // Every model step must survive the real persisted-snapshot round trip.
    this.snapshot = restoreTask(structuredClone(persistTask(this.snapshot)));
    return this.snapshot.context.reply;
  }
  request(action: LocalAction = { type: 'runCli', executable: 'node', args: ['script.js'] }) {
    return this.send({ type: 'LOCAL_REQUEST', intentId: this.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action,
      parentAttempt: this.work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], workspaceId: 'project', fence: this.work });
  }
  claim(leaseAvailable = true) { return this.send({ type: 'LOCAL_CLAIM', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', parentAttempt: this.work.attempt, leaseAvailable, fence: this.work }); }
  started() { return this.send({ type: 'LOCAL_STARTED', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', workspaceRevision: 'revision1', isolated: false }); }
  result(extra: Record<string, unknown> = {}) { return this.send({ type: 'LOCAL_RESULT', intentId: this.work.id, operationId: 'op1', sessionId: 'session1', result: { ok: true, code: 'succeeded', data: { stdout: 'actual' } }, settled: true, effectsKnown: true, ...extra }); }
  get c() { return this.snapshot.context; }
  get op() { return this.c.intents[0]!.localOperations?.[0]; }
}


export function discussionUncertainModel() {
  const m = new LocalModel(); const owner = m.work;
  assert(m.send({ type: 'USER_INPUT', text: '所有人讨论', reviewTargets: ['B'] }).ok);
  let coordinator = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: coordinator.id }).ok); coordinator = m.c.intents.find(w => w.id === coordinator.id)!;
  assert(m.send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, discussionId: coordinator.discussionId, fence: coordinator,
    decision: { action: 'review', question: '核查工程', expected: '证据', reason: '用户邀请' } }).ok);
  let member = m.c.intents.at(-1)!; assert(m.send({ type: 'CLAIM', intentId: member.id }).ok); member = m.c.intents.find(w => w.id === member.id)!;
  m.work = member; assert(m.request().ok); assert(m.claim().ok); assert(m.started().ok); assert(m.result({ effectsKnown: false }).ok);
  assert.equal(m.c.intents.find(w => w.id === member.id)!.status, 'uncertain');
  assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'must-preserve-owner-draft', artifactIds: [] }).ok);
  assert.equal(m.c.candidate?.text, 'must-preserve-owner-draft'); assert(!m.c.intents.some(w => w.kind === 'check'));
  assert.equal(m.c.outcome, null); return m;
}
