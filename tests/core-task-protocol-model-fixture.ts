import assert from 'node:assert/strict';
export interface CoreModelRun {
    act(): void;
    verify(): void;
}
import { restoreTask, taskPhase } from '../src/task.machine.js';
import { legacyTaskSnapshot } from './legacy-task-snapshot-fixture.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';
const nextConfig = () => ({
    ...localModelInput().config, version: 'team-v3', toolVersion: 'tools-v3',
    models: { default: 'new', services: { new: { model: 'current', baseUrl: 'https://current.example' } } },
});
const newLegacyModel = (version: 1 | 2) => new LocalModel(input => {
    input.config.version = `team-v${version}`;
    input.config.toolVersion = `tools-v${version}`;
    input.config.limits.ordinary = 44;
});
const retry = (m: LocalModel, config = nextConfig()) => m.send({
    type: 'REQUEST_HOST_RETRY', sourceWorkId: m.work.id, sourceOperationId: 'op1',
    sourceRequestHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), fence: m.c, currentConfig: config,
});
function runningLegacyCommand(version: 1 | 2 = 2) {
    const m = newLegacyModel(version);
    assert(m.request().ok);
    assert(m.claim().ok);
    assert(m.started().ok);
    m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot));
    return m;
}
function completedLegacyTask(version: 1 | 2 = 2) {
    const m = runningLegacyCommand(version);
    assert(m.result({ result: { ok: false, code: 'PERM_DENIED', data: { exitCode: 1 } } }).ok);
    assert(m.send({ type: 'STOP' }).ok);
    assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
    assert.equal(taskPhase(m.snapshot), 'ended');
    m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot, true));
    return m;
}
export function prepareActiveProtocolRecovery(): CoreModelRun {
    const m = runningLegacyCommand();
    const checks: (() => void)[] = [];
    return { act() {
            const result = m.send({ type: 'RECOVER', config: nextConfig() });
            const observed1 = result.code;
            checks.push(() => { assert.equal(observed1, 'INCOMPATIBLE_EXECUTION'); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'waitingHuman'); });
            const observed3 = m.op?.status;
            checks.push(() => { assert.equal(observed3, 'uncertain'); });
            const observed4 = m.c.config.version;
            checks.push(() => { assert.equal(observed4, 'team-v2'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareActiveProtocolReconcile(): CoreModelRun {
    const m = runningLegacyCommand();
    m.send({ type: 'RECOVER', config: nextConfig() });
    const checks: (() => void)[] = [];
    return { act() {
            const result = m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1',
                resolution: 'receipt', detail: '已核对原进程', result: { ok: true, code: 'settled', data: { stdout: '原回执' } } });
            const observed1 = result.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.op?.status;
            checks.push(() => { assert.equal(observed2, 'succeeded'); });
            const observed3 = m.c.intents[0]?.status;
            checks.push(() => { assert.equal(observed3, 'done'); });
            const observed4 = m.c.reason;
            checks.push(() => { assert.equal(observed4, 'Execution version incompatible'); });
            const observed5 = m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).code;
            checks.push(() => { assert.equal(observed5, 'INCOMPATIBLE_EXECUTION'); });
            const observed6 = m.c.intents.filter(work => work.kind === 'owner');
            checks.push(() => { assert.equal(observed6.length, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRetiredLegacyCheck(): CoreModelRun {
    const m = newLegacyModel(2);
    assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '旧候选', artifactIds: [] }).ok);
    const check = m.c.intents.find(work => work.kind === 'check')!;
    assert(m.send({ type: 'CLAIM', intentId: check.id }).ok);
    assert(m.send({ type: 'CONSUME', intentId: check.id }).ok);
    m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot));
    const checks: (() => void)[] = [];
    return { act() {
            const recovery = m.send({ type: 'RECOVER', config: nextConfig() });
            const observed1 = recovery.code;
            checks.push(() => { assert.equal(observed1, 'INCOMPATIBLE_EXECUTION'); });
            const observed2 = m.c.intents.find(work => work.id === check.id)?.status;
            checks.push(() => { assert.equal(observed2, 'done'); });
            const observed3 = m.c.usage.checks;
            checks.push(() => { assert.equal(observed3, 1); });
            assert(m.send({ type: 'STOP' }).ok);
            const observed4 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed4, 'ended'); });
            const observed5 = m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).ok;
            checks.push(() => { assert.equal(observed5, true); });
            const observed6 = m.c.publishedDelivery;
            checks.push(() => { assert.equal(observed6, undefined); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareTerminalProtocolActivation(index: number): CoreModelRun {
    const rows = [
        { route: 'continue', activate: (m: LocalModel) => m.send({ type: 'CONTINUE', currentConfig: nextConfig() }) },
        { route: 'retry', activate: retry },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { activate } = row;
    const m = completedLegacyTask();
    const previous = m.c;
    const checks: (() => void)[] = [];
    return { act() {
            const result = activate(m);
            const observed1 = result.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'running'); });
            const observed3 = m.c.epoch;
            checks.push(() => { assert.equal(observed3, previous.epoch + 1); });
            const observed4 = m.c.goalVersion;
            checks.push(() => { assert.equal(observed4, previous.goalVersion); });
            const observed5 = m.c.config;
            checks.push(() => { assert.partialDeepStrictEqual(observed5, { version: 'team-v3', toolVersion: 'tools-v3', models: nextConfig().models, limits: previous.config.limits }); });
            const observed6 = m.c.usage;
            checks.push(() => { assert.deepEqual(observed6, previous.usage); });
            const observed7 = m.c.artifacts;
            checks.push(() => { assert.deepEqual(observed7, previous.artifacts); });
            const observed8 = m.c.messages.filter(message => message.kind === 'final');
            checks.push(() => { assert.deepEqual(observed8, previous.messages.filter(message => message.kind === 'final')); });
            const observed9 = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending');
            checks.push(() => {
                assert.partialDeepStrictEqual(observed9, { epoch: m.c.epoch,
                    model: { serviceId: 'new' } });
            });
            const observed10 = m.c.intents.filter(work => work.kind === 'owner' && work.epoch === previous.epoch && work.status === 'pending');
            checks.push(() => { assert.deepEqual(observed10, []); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareLegacyPublication(): CoreModelRun {
    const m = completedLegacyTask(1);
    const checks: (() => void)[] = [];
    return { act() {
            const result = m.send({ type: 'CONTINUE', currentConfig: nextConfig() });
            const observed1 = result.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.publishedDelivery?.artifactIds;
            checks.push(() => { assert.deepEqual(observed2, ['legacy-artifact']); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareLegacyCheckRejection(): CoreModelRun {
    const m = completedLegacyTask();
    const originalPublication = m.c.publishedDelivery;
    assert(m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).ok);
    const owner = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
    assert(m.send({ type: 'CLAIM', intentId: owner.id }).ok);
    assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '本轮候选', artifactIds: [] }).ok);
    const checks: (() => void)[] = [];
    return { act() {
            const result = m.send({ type: 'CHECK_RESULT', workId: 'legacy-check', fence: { epoch: 1, goalVersion: 1 },
                passed: true, gaps: [], candidateRevision: 'legacy-candidate', resultId: 'late-legacy-result' });
            const observed1 = result.ok;
            checks.push(() => { assert.equal(observed1, false); });
            const observed2 = m.c.outcome;
            checks.push(() => { assert.equal(observed2, null); });
            const observed3 = m.c.publishedDelivery;
            checks.push(() => { assert.deepEqual(observed3, originalPublication); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRevokedRetry(): CoreModelRun {
    const m = completedLegacyTask();
    const config = { ...nextConfig(), localTools: { enabled: false } };
    const checks: (() => void)[] = [];
    return { act() {
            const result = retry(m, config);
            const observed1 = result.code;
            checks.push(() => { assert.equal(observed1, 'LOCAL_TOOLS_DISABLED'); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'ended'); });
            const observed3 = m.c.config.version;
            checks.push(() => { assert.equal(observed3, 'team-v2'); });
            const observed4 = m.c.hostRetryRequests;
            checks.push(() => { assert.equal(observed4, undefined); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareUnrelatedProtocol(): CoreModelRun {
    const m = completedLegacyTask();
    const checks: (() => void)[] = [];
    return { act() {
            const result = m.send({ type: 'CONTINUE', currentConfig: { ...nextConfig(), version: 'unrelated' } });
            const observed1 = result.code;
            checks.push(() => { assert.equal(observed1, 'INCOMPATIBLE_EXECUTION'); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'ended'); });
            const observed3 = m.c.config.version;
            checks.push(() => { assert.equal(observed3, 'team-v2'); });
        }, verify() { for (const check of checks)
            check(); } };
}
