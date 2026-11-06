import assert from 'node:assert/strict';
export interface CoreModelRun {
    act(): void;
    verify(): void;
}
import { debugInput } from '../src/task-debug.js';
import { initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { Decision, Intent, TaskContext, TaskEvent, TaskInput } from '../src/types.js';
type EventBody = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> & {
    id?: string;
    at?: number;
} : never : never;
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
        if (!work)
            throw new Error(`No ${status} ${kind}`);
        return work;
    }
    claim(kind: Intent['kind']) {
        const work = this.work(kind);
        this.send({ type: 'CLAIM', intentId: work.id });
        return this.context.intents.find(item => item.id === work.id)!;
    }
    restoreContext(update: (context: TaskContext) => void) {
        const saved = structuredClone(persistTask(this.snapshot)) as {
            context: TaskContext;
        };
        update(saved.context);
        this.snapshot = restoreTask(saved);
    }
}
function coordinating(owner = 'A', limits: Partial<TaskInput['config']['limits']> = {}) {
    const input = debugInput();
    Object.assign(input.config.limits, limits);
    const model = new Model(input);
    if (owner !== 'A')
        model.send({ type: 'HANDOFF', owner });
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
export function prepareOwnerHandoff(): CoreModelRun {
    const model = coordinating('B');
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = model.context.owner;
            checks.push(() => { assert.equal(observed1, 'B'); });
            const observed2 = model.context.config.defaultBot;
            checks.push(() => { assert.equal(observed2, 'A'); });
            const observed3 = model.work('facilitator').target;
            checks.push(() => { assert.equal(observed3, 'facilitator'); });
            const observed4 = model.work('facilitator').payload.owner;
            checks.push(() => { assert.equal(observed4, 'B'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareBackgroundOwner(): CoreModelRun {
    const model = new Model();
    const owner = model.claim('owner');
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'USER_INPUT', text: '请空闲成员参与讨论', reviewTargets: ['B'] });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'running'); });
            const observed2 = model.work('facilitator').payload.owner;
            checks.push(() => { assert.equal(observed2, 'A'); });
            const observed3 = model.work('facilitator').discussionId;
            checks.push(() => { assert.equal(observed3, model.context.discussion?.id); });
            const observed4 = model.context.intents.find(work => work.id === owner.id)?.status;
            checks.push(() => { assert.equal(observed4, 'inflight'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareLegacyPendingOwner(): CoreModelRun {
    const model = coordinating('B');
    const work = model.work('facilitator');
    model.restoreContext(context => { delete context.intents.find(item => item.id === work.id)!.payload.owner; });
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'CLAIM', intentId: work.id });
            const saved = persistTask(model.snapshot) as {
                context: TaskContext;
            };
            const observed1 = saved.context.intents.find(item => item.id === work.id)?.payload.owner;
            checks.push(() => { assert.equal(observed1, 'B'); });
            const observed2 = model.work('facilitator', 'inflight').attempt;
            checks.push(() => { assert.equal(observed2, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareLegacyRecoveredOwner(): CoreModelRun {
    const model = coordinating('B');
    const work = model.claim('facilitator');
    model.restoreContext(context => { delete context.intents.find(item => item.id === work.id)!.payload.owner; });
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'RECOVER', config: debugInput().config });
            const recovered = model.work('facilitator');
            model.send({ type: 'CLAIM', intentId: recovered.id });
            const observed1 = model.work('facilitator', 'inflight').payload.owner;
            checks.push(() => { assert.equal(observed1, 'B'); });
            const observed2 = model.work('facilitator', 'inflight').attempt;
            checks.push(() => { assert.equal(observed2, 2); });
            const observed3 = model.context.owner;
            checks.push(() => { assert.equal(observed3, 'B'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function preparePreservedOwner(): CoreModelRun {
    const model = coordinating('B');
    const work = model.work('facilitator');
    model.restoreContext(context => { context.intents.find(item => item.id === work.id)!.payload.owner = 'A'; });
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'CLAIM', intentId: work.id });
            const observed1 = model.work('facilitator', 'inflight').payload.owner;
            checks.push(() => { assert.equal(observed1, 'A'); });
            const observed2 = model.context.owner;
            checks.push(() => { assert.equal(observed2, 'B'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareSelfAssistNotice(): CoreModelRun {
    const model = coordinating();
    const work = model.claim('facilitator');
    const checks: (() => void)[] = [];
    return { act() {
            const rejected = model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: selfAssist('A') });
            const reason = model.context.reason;
            const notice = model.context.messages.at(-1);
            model.send({ type: 'ACTIVITY', text: '等待处理' });
            const observed1 = rejected.code;
            checks.push(() => { assert.equal(observed1, 'SELF_DEPENDENCY'); });
            const observed2 = model.snapshot.value;
            checks.push(() => { assert.equal(observed2, 'waitingHuman'); });
            const observed3 = reason;
            checks.push(() => { assert((observed3)?.includes('当前负责人本人')); });
            const observed4 = reason;
            checks.push(() => { assert((observed4)?.includes('SELF_DEPENDENCY')); });
            const observed5 = reason;
            checks.push(() => { assert((observed5)?.includes('请')); });
            const observed6 = notice;
            checks.push(() => { assert.partialDeepStrictEqual(observed6, { author: 'facilitator', kind: 'notice', text: reason }); });
            const observed7 = model.context.reply.code;
            checks.push(() => { assert.equal(observed7, 'OK'); });
            const observed8 = model.context.reason;
            checks.push(() => { assert.equal(observed8, reason); });
            const observed9 = model.context.messages.at(-1);
            checks.push(() => { assert.deepEqual(observed9, notice); });
            const observed10 = model.context.assists;
            checks.push(() => { assert.deepEqual(observed10, []); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareUnknownBotNotice(): CoreModelRun {
    const model = coordinating();
    const work = model.claim('facilitator');
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'assist', target: 'missing', question: '核查', expected: '来源', reason: '需要帮助' } });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'waitingHuman'); });
            const observed2 = model.context.reply.code;
            checks.push(() => { assert.equal(observed2, 'UNKNOWN_BOT'); });
            const observed3 = model.context.reason;
            checks.push(() => { assert((observed3)?.includes('成员不存在')); });
            const observed4 = model.context.reason;
            checks.push(() => { assert((observed4)?.includes('UNKNOWN_BOT')); });
            const observed5 = model.context.messages.at(-1)?.text;
            checks.push(() => { assert.equal(observed5, model.context.reason); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareUnrelatedCoordination(index: number): CoreModelRun {
    const rows = [
        [selfAssist('A'), 'SELF_DEPENDENCY'],
        [{ action: 'unsupported', reason: '非法决策' } as unknown as Decision, 'INVALID_DECISION'],
    ] as const;
    const row = rows[index];
    assert(row !== undefined);
    const [decision, code] = row;
    const model = new Model();
    model.send({ type: 'WAIT_USER', question: '请确认预算上限？' });
    const messages = structuredClone(model.context.messages);
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'COORDINATE', decision });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'waitingHuman'); });
            const observed2 = model.context.reply.code;
            checks.push(() => { assert.equal(observed2, code); });
            const observed3 = model.context.reason;
            checks.push(() => { assert.equal(observed3, '请确认预算上限？'); });
            const observed4 = model.context.messages;
            checks.push(() => { assert.deepEqual(observed4, messages); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareInvalidDecisionNotice(): CoreModelRun {
    const model = coordinating();
    const work = model.claim('facilitator');
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'unsupported', reason: '非法决策' } as unknown as Decision });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'waitingHuman'); });
            const observed2 = model.context.reply.code;
            checks.push(() => { assert.equal(observed2, 'INVALID_DECISION'); });
            const observed3 = model.context.reason;
            checks.push(() => { assert((observed3)?.includes('决策不符合要求')); });
            const observed4 = model.context.reason;
            checks.push(() => { assert((observed4)?.includes('INVALID_DECISION')); });
            const observed5 = model.context.messages.at(-1)?.text;
            checks.push(() => { assert.equal(observed5, model.context.reason); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStaleCoordination(): CoreModelRun {
    const model = new Model();
    model.send({ type: 'WAIT_USER', question: '请确认预算上限？' });
    const messages = structuredClone(model.context.messages);
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'COORDINATE', fence: { epoch: 1, goalVersion: 0 }, decision: selfAssist('A') });
            const observed1 = model.context.reply.code;
            checks.push(() => { assert.equal(observed1, 'STALE_FENCE'); });
            const observed2 = model.context.reason;
            checks.push(() => { assert.equal(observed2, '请确认预算上限？'); });
            const observed3 = model.context.messages;
            checks.push(() => { assert.deepEqual(observed3, messages); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRepairContinue(): CoreModelRun {
    const model = coordinating('B');
    const work = beginRequest(model);
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
            model.send({ type: 'CONSUME', intentId: work.id, fence: workFence(work) });
            model.send({ type: 'COORDINATE', workId: work.id, fence: workFence(work), decision: { action: 'continue', reason: '负责人继续核查现有材料' } });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'running'); });
            const observed2 = model.context.usage.retries;
            checks.push(() => { assert.equal(observed2, 1); });
            const observed3 = model.context.usage.ordinary;
            checks.push(() => { assert.equal(observed3, 2); });
            const observed4 = model.context.assists;
            checks.push(() => { assert.deepEqual(observed4, []); });
            const observed5 = model.work('owner').target;
            checks.push(() => { assert.equal(observed5, 'B'); });
            const observed6 = model.context.intents.find(item => item.id === work.id)?.outputRepair;
            checks.push(() => { assert.deepEqual(observed6, { count: 1, issue: 'invalid_decision' }); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRepairLimit(index: number): CoreModelRun {
    const rows = [
        [{ retries: 0 }, 'OUTPUT_REPAIR_EXHAUSTED'],
        [{ ordinary: 1 }, 'BUDGET_EXHAUSTED'],
    ] as const;
    const row = rows[index];
    assert(row !== undefined);
    const [limits, code] = row;
    const model = coordinating('A', limits);
    const work = beginRequest(model);
    const checks: (() => void)[] = [];
    return { act() {
            const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
            model.send({ type: 'WORK_FAILED', intentId: work.id, reason: `模型输出格式不合规，无法继续重新生成 (${rejected.code})`, transient: false, fence: workFence(work) });
            const observed1 = rejected.code;
            checks.push(() => { assert.equal(observed1, code); });
            const observed2 = model.snapshot.value;
            checks.push(() => { assert.equal(observed2, 'waitingHuman'); });
            const observed3 = model.context.reason;
            checks.push(() => { assert((observed3)?.includes('协调工作未能完成')); });
            const observed4 = model.context.reason;
            checks.push(() => { assert((observed4)?.includes(code)); });
            const observed5 = model.context.reason;
            checks.push(() => { assert((observed5)?.includes('请重试或补充处理方式')); });
            const observed6 = model.context.messages.at(-1);
            checks.push(() => { assert.partialDeepStrictEqual(observed6, { author: 'facilitator', kind: 'notice', text: model.context.reason }); });
            const observed7 = model.context.usage.ordinary;
            checks.push(() => { assert.equal(observed7, 1); });
            const observed8 = model.context.usage.retries;
            checks.push(() => { assert.equal(observed8, 0); });
            const observed9 = model.context.assists;
            checks.push(() => { assert.deepEqual(observed9, []); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStoppedRepair(): CoreModelRun {
    const model = coordinating();
    const work = beginRequest(model);
    model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
    model.send({ type: 'STOP' });
    const checks: (() => void)[] = [];
    return { act() {
            const rejected = model.send({ type: 'CONSUME', intentId: work.id, fence: workFence(work) });
            const observed1 = rejected.code;
            checks.push(() => { assert.equal(observed1, 'STOPPED'); });
            const observed2 = model.context.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 1); });
            const observed3 = model.context.usage.retries;
            checks.push(() => { assert.equal(observed3, 1); });
            const observed4 = model.context.stopped;
            checks.push(() => { assert.equal(observed4, true); });
            const observed5 = model.context.assists;
            checks.push(() => { assert.deepEqual(observed5, []); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareChangedGoalRepair(): CoreModelRun {
    const model = coordinating();
    const work = beginRequest(model);
    model.send({ type: 'HUMAN_DECISION', text: '优先处理新的范围' });
    const checks: (() => void)[] = [];
    return { act() {
            const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', fence: workFence(work) });
            const observed1 = rejected.code;
            checks.push(() => { assert.equal(observed1, 'STALE_FENCE'); });
            const observed2 = model.context.goalVersion;
            checks.push(() => { assert.equal(observed2, 2); });
            const observed3 = model.context.usage.retries;
            checks.push(() => { assert.equal(observed3, 0); });
            const observed4 = model.context.usage.ordinary;
            checks.push(() => { assert.equal(observed4, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareExpiredRepair(): CoreModelRun {
    const model = coordinating();
    const work = beginRequest(model);
    const checks: (() => void)[] = [];
    return { act() {
            const rejected = model.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_decision', at: work.deadline!, fence: workFence(work) });
            const observed1 = rejected.code;
            checks.push(() => { assert.equal(observed1, 'WORK_EXPIRED'); });
            const observed2 = model.context.usage.retries;
            checks.push(() => { assert.equal(observed2, 0); });
            const observed3 = model.context.usage.ordinary;
            checks.push(() => { assert.equal(observed3, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareBackgroundFailure(): CoreModelRun {
    const model = new Model();
    const owner = model.claim('owner');
    model.send({ type: 'USER_INPUT', text: '请空闲成员参与讨论', reviewTargets: ['B'] });
    const work = model.claim('facilitator');
    const checks: (() => void)[] = [];
    return { act() {
            model.send({ type: 'WORK_FAILED', intentId: work.id, reason: 'OUTPUT_REPAIR_EXHAUSTED', transient: false, fence: workFence(work) });
            const observed1 = model.snapshot.value;
            checks.push(() => { assert.equal(observed1, 'running'); });
            const observed2 = model.context.discussion?.status;
            checks.push(() => { assert.equal(observed2, 'ready'); });
            const observed3 = model.context.reason;
            checks.push(() => { assert(!(observed3)?.includes('协调工作未能完成')); });
            const observed4 = model.context.messages.at(-1)?.text;
            checks.push(() => { assert((observed4)?.includes('等待 A 当前工作结算')); });
            const observed5 = model.context.intents.find(item => item.id === owner.id)?.status;
            checks.push(() => { assert.equal(observed5, 'inflight'); });
        }, verify() { for (const check of checks)
            check(); } };
}
