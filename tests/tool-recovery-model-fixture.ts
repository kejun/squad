import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { LocalModel } from './local-model-fixture.js';
import { MapQueueModel } from './map-queue-fixture.js';
import type { Intent } from '../src/types.js';

const requestId = (work: Intent, number: number) => `request:${work.id}:${work.attempt}:web_fetch:${number}`;
export function consumeWeb(m: LocalModel, number: number) {
  const work = m.c.intents.find(item => item.id === m.work.id)!;
  const id = requestId(work, number);
  const consumption = { type: 'CONSUME' as const, id, intentId: work.id, capability: 'web_fetch' as const, fence: work, attempt: work.attempt };
  assert(m.send(consumption).ok);
  return id;
}
export function recordFailure(m: LocalModel, id: string) {
  const work = m.c.intents.find(item => item.id === m.work.id)!;
  return m.send({ type: 'RECORD_TOOL_FAILURE', intentId: work.id, requestId: id, tool: 'web_fetch',
    code: 'WEB_TOOL_UNSUPPORTED_RESOURCE', fence: work, attempt: work.attempt });
}
export function recoveryModel() {
  const m = new LocalModel();
  assert(m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work, attempt: m.work.attempt }).ok);
  return m;
}
export function modelRecoveryAllowed() {
  const m = recoveryModel(), first = consumeWeb(m, 1), usage = structuredClone(m.c.usage);
  assert(recordFailure(m, first).ok, 'A known failed web call must allow a bounded alternative decision');
  assert.deepEqual(m.c.usage, usage, 'Saving feedback must not charge or refund execution');
  assert.deepEqual(m.c.intents[0]!.toolRecovery?.failures, [{ requestId: first, tool: 'web_fetch', code: 'WEB_TOOL_UNSUPPORTED_RESOURCE', attempt: 1 }]);
  assert(m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work, attempt: m.work.attempt }).ok);
  assert.equal(m.c.usage.ordinary, usage.ordinary + 1);
  assert.equal(m.c.usage.retries, 0);
  return m;
}
export function modelRecoveryBound() {
  const m = recoveryModel();
  assert(recordFailure(m, consumeWeb(m, 1)).ok);
  assert(recordFailure(m, consumeWeb(m, 2)).ok);
  const third = consumeWeb(m, 3);
  assert.equal(recordFailure(m, third).code, 'TOOL_RECOVERY_EXHAUSTED');
  assert.equal(m.c.intents[0]!.toolRecovery?.failures.length, 2);
  return m;
}
export function preparedRecoveryFeedback() {
  const m = recoveryModel(), first = consumeWeb(m, 1);
  assert(recordFailure(m, first).ok);
  return { m, first };
}
export function modelRecoveryRestart({ m, first } = preparedRecoveryFeedback()) {
  m.snapshot = restoreTask(JSON.parse(JSON.stringify(persistTask(m.snapshot))));
  assert.equal(recordFailure(m, first).code, 'DUPLICATE_TOOL_FAILURE');
  assert.equal(m.c.intents[0]!.toolRecovery?.failures.length, 1);
  assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
  const pending = m.c.intents.find(work => work.id === m.work.id)!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  m.work = m.c.intents.find(work => work.id === pending.id)!;
  const next = consumeWeb(m, 1);
  assert(recordFailure(m, next).ok);
  assert.equal(m.c.intents[0]!.toolRecovery?.failures.length, 2);
  return m;
}
const boundaryCodes: Record<string, string> = {
  '已停止': 'STOPPED', '旧目标': 'STALE_FENCE', '旧尝试': 'STALE_ATTEMPT', '截止时间已到': 'WORK_EXPIRED',
  '网页权限撤销': 'WEB_TOOLS_DISABLED', '普通额度耗尽': 'BUDGET_EXHAUSTED',
  '本地物理效果不明': 'WORK_NOT_INFLIGHT', '独立检查角色': 'TOOL_RECOVERY_NOT_ALLOWED',
};
export function modelRecoveryBoundary(boundary: string) {
  const m = recoveryModel(), id = consumeWeb(m, 1), work = structuredClone(m.work);
  if (boundary === '已停止') assert(m.send({ type: 'STOP' }).ok);
  if (boundary === '旧目标') m.c.goalVersion++;
  if (boundary === '旧尝试') m.c.intents[0]!.attempt++;
  if (boundary === '截止时间已到') m.at = m.c.intents[0]!.deadline!;
  if (boundary === '网页权限撤销') m.c.config.webTools = { enabled: false };
  if (boundary === '普通额度耗尽') m.c.config.limits.ordinary = m.c.usage.ordinary;
  if (boundary === '本地物理效果不明') {
    assert(m.request().ok); assert(m.claim().ok); assert(m.result({ effectsKnown: false }).ok);
  }
  if (boundary === '独立检查角色') m.c.intents[0]!.kind = 'check';
  const before = structuredClone(m.c.usage);
  const reply = m.send({ type: 'RECORD_TOOL_FAILURE', intentId: work.id, requestId: id, tool: 'web_fetch',
    code: 'WEB_TOOL_UNSUPPORTED_RESOURCE', fence: work, attempt: work.attempt });
  assert.equal(reply.code, boundaryCodes[boundary], boundary);
  assert.equal(m.c.intents[0]!.toolRecovery, undefined);
  assert.deepEqual(m.c.usage, before);
  return m;
}
export function preparedRecoveryReservation() {
  const m = new MapQueueModel(), work = m.start();
  const id = requestId(work, 1);
  const consumption = { type: 'CONSUME' as const, id, intentId: work.id, capability: 'web_fetch' as const, fence: work, attempt: work.attempt };
  assert(m.send(consumption).ok);
  const current = m.context;
  const pending = current.intents.filter(item => item.discussionId === current.discussion!.id && item.status === 'pending' && item.id !== work.id).length;
  const queued = m.queue.filter(part => part.status === 'queued').length;
  current.config.limits.ordinary = current.usage.ordinary + 1 + pending + queued + 1;
  return { m, work, id };
}
export function modelRecoveryReservation({ m, work, id } = preparedRecoveryReservation()) {
  const current = m.context;
  const before = structuredClone(current.usage);
  const reply = m.send({ type: 'RECORD_TOOL_FAILURE', intentId: work.id, requestId: id, tool: 'web_fetch',
    code: 'WEB_TOOL_UNSUPPORTED_RESOURCE', fence: work, attempt: work.attempt });
  assert.equal(reply.code, 'DISCUSSION_BUDGET_RESERVED');
  assert.deepEqual(m.context.usage, before);
  assert.equal(m.context.intents.find(item => item.id === work.id)!.toolRecovery, undefined);
  return m;
}
export function toolRecoveryModelGate() {
  modelRecoveryAllowed(); modelRecoveryBound(); modelRecoveryRestart(); modelRecoveryReservation();
  for (const boundary of Object.keys(boundaryCodes)) modelRecoveryBoundary(boundary);
  return { paths: 12, persistence: 'each public event' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(toolRecoveryModelGate()));
