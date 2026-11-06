import assert from 'node:assert/strict';
export interface CoreModelRun {
    act(): void;
    verify(): void;
}
import { initialTask, persistTask, restoreTask, stepTask, taskPhase } from '../src/task.machine.js';
import type { TaskEvent } from '../src/types.js';
import type { EventBody } from './helpers.js';
import { localModelInput } from './local-model-fixture.js';
function model(ordinary = 10) {
    const config = localModelInput().config;
    config.limits.ordinary = ordinary;
    config.inputAnalysis = { enabled: false };
    let snapshot = initialTask({ taskId: 'skill-search', owner: 'A', config, at: 0,
        message: { id: 'M', taskId: 'skill-search', author: 'user', kind: 'user', text: '搜索技能', at: 0 },
        goal: { text: '搜索技能', constraints: [], criteria: ['保留来源'], requiredArtifacts: 0 } });
    const work = snapshot.context.intents[0]!;
    let sequence = 0;
    const send = (body: EventBody) => {
        snapshot = stepTask(snapshot, { ...body, id: `search-model:${++sequence}`, at: sequence } as TaskEvent);
        snapshot = restoreTask(structuredClone(persistTask(snapshot)));
        return snapshot.context.reply;
    };
    assert.equal(send({ type: 'CLAIM', intentId: work.id }).ok, true);
    // The initial model request consumes the reservation already made by CLAIM.
    assert.equal(send({ type: 'CONSUME', intentId: work.id, fence: work }).ok, true);
    return { config, work, send, get snapshot() { return snapshot; }, get c() { return snapshot.context; },
        search: () => send({ type: 'CONSUME', intentId: work.id, fence: work }) };
}
export function prepareSearchDelivery(): CoreModelRun {
    const m = model();
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.search().ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 2); });
            const observed3 = m.c.candidate;
            checks.push(() => { assert.equal(observed3, null); });
            const observed4 = m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work }).ok;
            checks.push(() => { assert.equal(observed4, true); });
            const observed5 = m.send({ type: 'DELIVER', text: '搜索资料', artifactIds: [], workId: m.work.id, fence: m.work }).ok;
            checks.push(() => { assert.equal(observed5, true); });
            const observed6 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed6, 'checking'); });
            const observed7 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed7, 3); });
            const observed8 = m.c.intents.find(w => w.id === m.work.id)?.status;
            checks.push(() => { assert.equal(observed8, 'done'); });
            const observed9 = m.c.intents.filter(w => w.kind === 'check' && w.status === 'pending');
            checks.push(() => { assert.equal(observed9.length, 1); });
            const observed10 = m.c.intents.some(w => w.kind === 'tool');
            checks.push(() => { assert.equal(observed10, false); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareInvalidSearch(): CoreModelRun {
    const m = model();
    assert(m.search().ok);
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: 'Invalid skill search result', transient: false, fence: m.work }).ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'waitingHuman'); });
            const observed3 = m.c.candidate;
            checks.push(() => { assert.equal(observed3, null); });
            const observed4 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed4, 2); });
            const observed5 = m.c.usage.retries;
            checks.push(() => { assert.equal(observed5, 0); });
            const observed6 = m.c.intents.find(w => w.id === m.work.id)?.status;
            checks.push(() => { assert.equal(observed6, 'done'); });
            const observed7 = m.c.intents.some(w => w.kind === 'check');
            checks.push(() => { assert.equal(observed7, false); });
            const observed8 = m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: 'duplicate', transient: false, fence: m.work }).ok;
            checks.push(() => { assert.equal(observed8, false); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareSearchBudget(): CoreModelRun {
    const m = model(1);
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.search().code;
            checks.push(() => { assert.equal(observed1, 'BUDGET_EXHAUSTED'); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 1); });
            const observed3 = m.c.intents.find(w => w.id === m.work.id)?.requestCount;
            checks.push(() => { assert.equal(observed3, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStoppedSearch(): CoreModelRun {
    const m = model();
    assert(m.search().ok);
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'STOP' });
            const observed1 = m.search().ok;
            checks.push(() => { assert.equal(observed1, false); });
            const observed2 = m.c.intents.some(w => w.kind === 'cancel' && w.status === 'pending');
            checks.push(() => { assert.equal(observed2, true); });
            m.send({ type: 'DELIVER', text: '迟到资料', artifactIds: [], workId: m.work.id, fence: m.work });
            const observed3 = m.c.candidate;
            checks.push(() => { assert.equal(observed3, null); });
            const observed4 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed4, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStaleSearch(): CoreModelRun {
    const m = model();
    assert(m.search().ok);
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.send({ type: 'DELIVER', text: '过期资料', artifactIds: [], workId: m.work.id,
                fence: { epoch: m.work.epoch, goalVersion: m.work.goalVersion - 1 } }).code;
            checks.push(() => { assert.equal(observed1, 'STALE_FENCE'); });
            const observed2 = m.c.candidate;
            checks.push(() => { assert.equal(observed2, null); });
            const observed3 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed3, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRecoveredSearch(): CoreModelRun {
    const m = model();
    assert(m.search().ok);
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.send({ type: 'RECOVER', config: m.config }).ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.intents.filter(w => w.kind === 'owner');
            checks.push(() => { assert.equal(observed2.length, 1); });
            const observed3 = m.c.intents.find(w => w.id === m.work.id)?.status;
            checks.push(() => { assert.equal(observed3, 'pending'); });
            const observed4 = m.search().code;
            checks.push(() => { assert.equal(observed4, 'WORK_NOT_INFLIGHT'); });
            const observed5 = m.send({ type: 'CLAIM', intentId: m.work.id }).ok;
            checks.push(() => { assert.equal(observed5, true); });
            const observed6 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed6, 3); });
            const observed7 = m.c.intents.find(w => w.id === m.work.id)?.attempt;
            checks.push(() => { assert.equal(observed7, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
