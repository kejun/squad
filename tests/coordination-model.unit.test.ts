import { describe, expect, it } from 'vitest';
import { debugInput } from '../src/task-debug.js';
import { initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { Decision, Intent, TaskContext, TaskEvent, TaskInput } from '../src/types.js';

type EventBody = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> & { id?: string; at?: number } : never : never;
class Model {
  snapshot: TaskSnapshot;
  private sequence = 0;
  constructor(input = debugInput()) { this.snapshot = initialTask(input); }
  get context() { return this.snapshot.context; }
  send(body: EventBody) {
    this.sequence++;
    this.snapshot = stepTask(this.snapshot, { id: `model:${this.sequence}`, at: this.sequence, ...body } as TaskEvent);
    return this.context.reply;
  }
  work(kind: Intent['kind'], status: Intent['status'] = 'pending') {
    const work = this.context.intents.find(item => item.kind === kind && item.status === status);
    if (!work) throw new Error(`No ${status} ${kind}`);
    return work;
  }
  claim(kind: Intent['kind']) {
    const work = this.work(kind);
    this.send({ type: 'CLAIM', intentId: work.id });
    return this.context.intents.find(item => item.id === work.id)!;
  }
  restoreContext(update: (context: TaskContext) => void) {
    const saved = structuredClone(persistTask(this.snapshot)) as { context: TaskContext };
    update(saved.context);
    this.snapshot = restoreTask(saved);
  }
}
function coordinating(owner = 'A', limits: Partial<TaskInput['config']['limits']> = {}) {
  const input = debugInput();
  Object.assign(input.config.limits, limits);
  const model = new Model(input);
  if (owner !== 'A') model.send({ type: 'HANDOFF', owner });
  model.send({ type: 'BLOCKED', reason: '需要核查资料来源' });
  return model;
}
const selfAssist = (owner: string) => ({ action: 'assist' as const, target: owner, question: '核查资料', expected: '明确来源', reason: '需要帮助' });
const workFence = (work: Intent) => ({ epoch: work.epoch, goalVersion: work.goalVersion });
function beginRequest(model: Model) {
  const work = model.claim('facilitator');
  model.send({ type: 'CONSUME', intentId: work.id, fence: workFence(work) });
  return work;
}

describe('coordination identity, repair and durable waiting reasons in the real XState model', () => {
  it('[BT_M24] saves the actual owner after handoff while the default member and coordinator identity stay distinct', () => {
    const model = coordinating('B');

    expect(model.context.owner).toBe('B');
    expect(model.context.config.defaultBot).toBe('A');
    expect(model.work('facilitator').target).toBe('facilitator');
    expect(model.work('facilitator').payload.owner).toBe('B');
  });

  it('[BT_M23] also pins the owner on the independent discussion facilitator without changing the main work', () => {
    const model = new Model();
    const owner = model.claim('owner');

    model.send({ type: 'USER_INPUT', text: '请空闲成员参与讨论', reviewTargets: ['B'] });

    expect(model.snapshot.value).toBe('running');
    expect(model.work('facilitator').payload.owner).toBe('A');
    expect(model.work('facilitator').discussionId).toBe(model.context.discussion?.id);
    expect(model.context.intents.find(work => work.id === owner.id)?.status).toBe('inflight');
  });

  it('[BT_M28] fills an old pending coordinator owner as part of the real claim snapshot', () => {
    const model = coordinating('B');
    const work = model.work('facilitator');
    model.restoreContext(context => { delete context.intents.find(item => item.id === work.id)!.payload.owner; });

    model.send({ type: 'CLAIM', intentId: work.id });

    const saved = persistTask(model.snapshot) as { context: TaskContext };
    expect(saved.context.intents.find(item => item.id === work.id)?.payload.owner).toBe('B');
    expect(model.work('facilitator', 'inflight').attempt).toBe(1);
  });

  it('[BT_M28] fills an old coordinator after safe recovery and reclaims without resetting the owner identity', () => {
    const model = coordinating('B');
    const work = model.claim('facilitator');
    model.restoreContext(context => { delete context.intents.find(item => item.id === work.id)!.payload.owner; });

    model.send({ type: 'RECOVER', config: debugInput().config });
    const recovered = model.work('facilitator');
    model.send({ type: 'CLAIM', intentId: recovered.id });

    expect(model.work('facilitator', 'inflight').payload.owner).toBe('B');
    expect(model.work('facilitator', 'inflight').attempt).toBe(2);
    expect(model.context.owner).toBe('B');
  });

  it('[BT_M28] preserves an existing owner value instead of silently replacing persisted work metadata', () => {
    const model = coordinating('B');
    const work = model.work('facilitator');
    model.restoreContext(context => { context.intents.find(item => item.id === work.id)!.payload.owner = 'A'; });

    model.send({ type: 'CLAIM', intentId: work.id });

    expect(model.work('facilitator', 'inflight').payload.owner).toBe('A');
    expect(model.context.owner).toBe('B');
  });

  it('[BT_M26] persists the self-dependency explanation and notice after a later accepted command replaces the reply', () => {
    const model = coordinating();
    const work = model.claim('facilitator');

    const rejected = model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: selfAssist('A') });
    const reason = model.context.reason;
    const notice = model.context.messages.at(-1);
    model.send({ type: 'ACTIVITY', text: '等待处理' });

    expect(rejected.code).toBe('SELF_DEPENDENCY');
    expect(model.snapshot.value).toBe('waitingHuman');
    expect(reason).toContain('当前负责人本人');
    expect(reason).toContain('SELF_DEPENDENCY');
    expect(reason).toContain('请');
    expect(notice).toMatchObject({ author: 'facilitator', kind: 'notice', text: reason });
    expect(model.context.reply.code).toBe('OK');
    expect(model.context.reason).toBe(reason);
    expect(model.context.messages.at(-1)).toEqual(notice);
    expect(model.context.assists).toEqual([]);
  });

  it('[BT_M26] explains an invalid current decision without removing its domain rejection code', () => {
    const model = coordinating();
    const work = model.claim('facilitator');

    model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'assist', target: 'missing', question: '核查', expected: '来源', reason: '需要帮助' } });

    expect(model.snapshot.value).toBe('waitingHuman');
    expect(model.context.reply.code).toBe('UNKNOWN_BOT');
    expect(model.context.reason).toContain('成员不存在');
    expect(model.context.reason).toContain('UNKNOWN_BOT');
    expect(model.context.messages.at(-1)?.text).toBe(model.context.reason);
  });

  it.each([
    [selfAssist('A'), 'SELF_DEPENDENCY'],
    [{ action: 'unsupported', reason: '非法决策' } as unknown as Decision, 'INVALID_DECISION'],
  ] as const)('[BT_M27] rejects %j outside coordination without overwriting the actual human question', (decision, code) => {
    const model = new Model();
    model.send({ type: 'WAIT_USER', question: '请确认预算上限？' });
    const messages = structuredClone(model.context.messages);

    model.send({ type: 'COORDINATE', decision });

    expect(model.snapshot.value).toBe('waitingHuman');
    expect(model.context.reply.code).toBe(code);
    expect(model.context.reason).toBe('请确认预算上限？');
    expect(model.context.messages).toEqual(messages);
  });

  it('[BT_M26] explains a malformed current decision only on the coordinating fallback', () => {
    const model = coordinating();
    const work = model.claim('facilitator');

    model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'unsupported', reason: '非法决策' } as unknown as Decision });

    expect(model.snapshot.value).toBe('waitingHuman');
    expect(model.context.reply.code).toBe('INVALID_DECISION');
    expect(model.context.reason).toContain('决策不符合要求');
    expect(model.context.reason).toContain('INVALID_DECISION');
    expect(model.context.messages.at(-1)?.text).toBe(model.context.reason);
  });

  it('[BT_M27] keeps the actual human question when a stale coordinator returns a malformed decision', () => {
    const model = new Model();
    model.send({ type: 'WAIT_USER', question: '请确认预算上限？' });
    const messages = structuredClone(model.context.messages);

    model.send({ type: 'COORDINATE', fence: { epoch: 1, goalVersion: 0 }, decision: selfAssist('A') });

    expect(model.context.reply.code).toBe('STALE_FENCE');
    expect(model.context.reason).toBe('请确认预算上限？');
    expect(model.context.messages).toEqual(messages);
  });

  it('[BT_M23] authorizes invalid-decision repair and one additional request before applying a valid continue decision', () => {
    const model = coordinating('B');
    const work = beginRequest(model);

    model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
    model.send({ type: 'CONSUME', intentId: work.id, fence: workFence(work) });
    model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'continue', reason: '负责人继续核查现有材料' } });

    expect(model.snapshot.value).toBe('running');
    expect(model.context.usage.retries).toBe(1);
    expect(model.context.usage.ordinary).toBe(2);
    expect(model.context.assists).toEqual([]);
    expect(model.work('owner').target).toBe('B');
    expect(model.context.intents.find(item => item.id === work.id)?.outputRepair).toEqual({ count: 1, issue: 'invalid_decision' });
  });

  it.each([
    [{ retries: 0 }, 'OUTPUT_REPAIR_EXHAUSTED'],
    [{ ordinary: 1 }, 'BUDGET_EXHAUSTED'],
  ] as const)('[BT_M25] saves an actionable coordinator failure when repair hits %j', (limits, code) => {
    const model = coordinating('A', limits);
    const work = beginRequest(model);

    const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
    model.send({ type: 'WORK_FAILED', intentId: work.id, reason: `模型输出格式不合规，无法继续重新生成 (${rejected.code})`, transient: false, fence: workFence(work) });

    expect(rejected.code).toBe(code);
    expect(model.snapshot.value).toBe('waitingHuman');
    expect(model.context.reason).toContain('协调工作未能完成');
    expect(model.context.reason).toContain(code);
    expect(model.context.reason).toContain('请重试或补充处理方式');
    expect(model.context.messages.at(-1)).toMatchObject({ author: 'facilitator', kind: 'notice', text: model.context.reason });
    expect(model.context.usage.ordinary).toBe(1);
    expect(model.context.usage.retries).toBe(0);
    expect(model.context.assists).toEqual([]);
  });

  it('[BT_M23] blocks an additional request after stop even if a repair was saved before it', () => {
    const model = coordinating();
    const work = beginRequest(model);
    model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
    model.send({ type: 'STOP' });

    const rejected = model.send({ type: 'CONSUME', intentId: work.id, fence: workFence(work) });

    expect(rejected.code).toBe('STOPPED');
    expect(model.context.usage.ordinary).toBe(1);
    expect(model.context.usage.retries).toBe(1);
    expect(model.context.stopped).toBe(true);
    expect(model.context.assists).toEqual([]);
  });

  it('[BT_M23] blocks repair under an old target version after a direct user decision', () => {
    const model = coordinating();
    const work = beginRequest(model);
    model.send({ type: 'HUMAN_DECISION', text: '优先处理新的范围' });

    const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });

    expect(rejected.code).toBe('STALE_FENCE');
    expect(model.context.goalVersion).toBe(2);
    expect(model.context.usage.retries).toBe(0);
    expect(model.context.usage.ordinary).toBe(1);
  });

  it('[BT_M23] blocks repair at the original deadline without reserving another request', () => {
    const model = coordinating();
    const work = beginRequest(model);

    const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', at: work.deadline!, fence: workFence(work) });

    expect(rejected.code).toBe('WORK_EXPIRED');
    expect(model.context.usage.retries).toBe(0);
    expect(model.context.usage.ordinary).toBe(1);
  });

  it('[BT_M23] keeps background discussion failure in its own lane without requesting a main-task retry', () => {
    const model = new Model();
    const owner = model.claim('owner');
    model.send({ type: 'USER_INPUT', text: '请空闲成员参与讨论', reviewTargets: ['B'] });
    const work = model.claim('facilitator');

    model.send({ type: 'WORK_FAILED', intentId: work.id, reason: 'OUTPUT_REPAIR_EXHAUSTED', transient: false, fence: workFence(work) });

    expect(model.snapshot.value).toBe('running');
    expect(model.context.discussion?.status).toBe('ready');
    expect(model.context.reason).not.toContain('协调工作未能完成');
    expect(model.context.messages.at(-1)?.text).toContain('等待 A 当前工作结算');
    expect(model.context.intents.find(item => item.id === owner.id)?.status).toBe('inflight');
  });
});
