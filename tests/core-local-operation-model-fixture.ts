import assert from 'node:assert/strict';
export interface CoreModelRun {
    act(): void;
    verify(): void;
}
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { taskPhase } from '../src/task.machine.js';
import { localPhysicalPending } from '../src/local-operation.js';
import type { TaskInput } from '../src/types.js';
function queuedOperation(change?: (input: TaskInput) => void) {
    const m = new LocalModel(change);
    m.request();
    return m;
}
function claimedOperation() { const m = queuedOperation(); m.claim(); return m; }
function runningOperation() { const m = claimedOperation(); m.started(); return m; }
function completedOperation() { const m = runningOperation(); m.result(); return m; }
const testCommand = { type: 'runCli', executable: 'npm', args: ['run', 'build'], execution: 'sandbox' } as const;
const workspaceRevision = 'b'.repeat(64);
function checkWork() {
    const m = new LocalModel(input => { input.goal.text = 'Run npm run build'; input.message.text = input.goal.text; });
    const owner = m.work;
    assert.equal(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'candidate', artifactIds: [] }).ok, true);
    const check = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
    assert.equal(m.send({ type: 'CLAIM', intentId: check.id }).ok, true);
    m.work = m.c.intents.find(work => work.id === check.id)!;
    return m;
}
function completeValidationCommand(m: LocalModel) {
    assert.equal(m.request({ ...testCommand, args: [...testCommand.args] }).ok, true);
    assert.equal(m.claim().ok, true);
    assert.equal(m.send({ type: 'LOCAL_STARTED', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', workspaceRevision, isolated: true }).ok, true);
    assert.equal(m.result({ result: { ok: true, code: 'succeeded', data: { exitCode: 0 } } }).ok, true);
}
function activatedSkill() {
    const m = new LocalModel();
    m.request({ type: 'loadSkill', skillId: 'skill1' });
    m.claim();
    return m;
}
const skillReceipt = () => ({ result: { ok: true, code: 'loaded', data: { skillId: 'skill1', skillVersion: 'b'.repeat(64) } } });
export function prepareReceiptReturn(): CoreModelRun {
    const m = runningOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.result();
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.op?.status;
            checks.push(() => { assert.equal(observed2, 'succeeded'); });
            const observed3 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed3, 'inflight'); });
            const observed4 = m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content;
            checks.push(() => { assert((observed4)?.includes('actual')); });
            const observed5 = m.c.intents[0]!.localCheckpoint?.pendingOperationId;
            checks.push(() => { assert.equal(observed5, undefined); });
            const observed6 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed6, 2); });
            const observed7 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed7, 'running'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareDuplicateReceipt(): CoreModelRun {
    const m = completedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.result();
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, 'LOCAL_SESSION_MISMATCH'); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareCatalogCost(): CoreModelRun {
    const m = new LocalModel();
    const checks: (() => void)[] = [];
    return { act() {
            m.request({ type: 'listSkills' });
            m.claim();
            m.result();
            const observed1 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed1, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function preparePinSkill(): CoreModelRun {
    const m = activatedSkill();
    const checks: (() => void)[] = [];
    return { act() {
            m.result(skillReceipt());
            const observed1 = m.c.intents[0]!.localSkills;
            checks.push(() => { assert.deepEqual(observed1, [{ skillId: 'skill1', skillVersion: 'b'.repeat(64) }]); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRejection(index: number): CoreModelRun {
    const rows = [
        { name: 'budget', code: 'BUDGET_EXHAUSTED', prepare: () => queuedOperation(i => { i.config.limits.ordinary = 1; }), act: (m: LocalModel) => m.claim() },
        { name: 'stopped', code: 'STOPPED', prepare: () => { const m = new LocalModel(); m.send({ type: 'STOP' }); return m; }, act: (m: LocalModel) => m.request() },
        { name: 'expired', code: 'WORK_EXPIRED', prepare: () => { const m = new LocalModel(); m.at = 1001; return m; }, act: (m: LocalModel) => m.request() },
        { name: 'stale goal', code: 'STALE_WORK', prepare: () => { const m = new LocalModel(); m.c.goalVersion++; return m; }, act: (m: LocalModel) => m.request() },
        { name: 'disabled tools', code: 'LOCAL_TOOLS_DISABLED', prepare: () => new LocalModel(i => { i.config.localTools = { enabled: false }; }), act: (m: LocalModel) => m.request() },
        { name: 'legacy authority', code: 'LOCAL_TOOLS_NOT_AUTHORIZED', prepare: () => { const m = new LocalModel(); delete (m.work.payload.capabilities as Record<string, unknown>).localTools; return m; }, act: (m: LocalModel) => m.request() },
        { name: 'interpretation work', code: 'LOCAL_TOOLS_NOT_ALLOWED', prepare: () => { const m = new LocalModel(); m.work.kind = 'interpretation'; return m; }, act: (m: LocalModel) => m.request() },
        { name: 'busy lease', code: 'WORKSPACE_BUSY', prepare: queuedOperation, act: (m: LocalModel) => m.claim(false) },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare, act, code } = row;
    const m = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = act(m);
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, code); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 1); });
            const observed3 = m.op?.sessionId;
            checks.push(() => { assert.equal(observed3, undefined); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareReservedSynthesis(index: number): CoreModelRun {
    const rows = [
        { name: 'review', code: 'REVIEW_SYNTHESIS_RESERVED', prepare: () => {
                const m = new LocalModel(i => { i.config.limits.ordinary = 2; });
                m.c.review = { id: 'r', request: 'review', targets: ['B'], completed: [], status: 'reviewing', epoch: 1, goalVersion: 1 };
                m.request();
                return m;
            } },
        { name: 'discussion', code: 'DISCUSSION_BUDGET_RESERVED', prepare: () => {
                const m = new LocalModel(i => { i.config.limits.ordinary = 2; });
                m.c.discussion = { id: 'd', request: 'discuss', targets: ['B'], results: [], skipped: [], status: 'collecting', epoch: 1, goalVersion: 1 };
                m.request();
                return m;
            } },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare, code } = row;
    const m = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.claim();
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, code); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareCheckChildCost(): CoreModelRun {
    const m = checkWork();
    m.request({ ...testCommand, args: [...testCommand.args] });
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.claim();
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareCheckCommand(): CoreModelRun {
    const m = checkWork();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.request({ type: 'runCli', executable: 'npm', args: ['test'], execution: 'sandbox' });
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, 'OK'); });
            const observed2 = m.c.intents.find(work => work.id === m.work.id)?.localOperations;
            checks.push(() => {
                assert.equal(observed2?.length, 1);
                assert.equal(observed2?.[0]?.status, 'queued');
                assert.equal(observed2?.[0]?.attempt, 0);
                assert.equal(observed2?.[0]?.startedAt, undefined);
                assert.deepEqual(observed2?.[0]?.action, { type: 'runCli', executable: 'npm', args: ['test'], execution: 'sandbox' });
                assert.equal(m.c.usage.ordinary, 1);
            });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareCheckPrerequisite(): CoreModelRun {
    const m = checkWork();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work });
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, 'OK'); });
            const observed2 = m.c.intents.find(work => work.id === m.work.id)?.requestCount;
            checks.push(() => {
                assert.equal(observed2, 1);
                assert.equal(m.c.usage.checks, 1);
                assert.equal(m.c.intents.find(work => work.id === m.work.id)?.localOperations, undefined);
            });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareCheckFinalVersion(): CoreModelRun {
    const m = checkWork();
    completeValidationCommand(m);
    assert.equal(m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work }).ok, true);
    const candidate = m.c.candidate!;
    const criteriaResults = candidate.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' }));
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ type: 'CHECK_RESULT', workId: m.work.id, fence: m.work, attempt: m.work.attempt,
                candidateRevision: candidate.revision, resultId: 'check', criteriaResults });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.outcome;
            checks.push(() => { assert.equal(observed2, 'complete'); });
            const observed3 = m.c.candidate?.text;
            checks.push(() => { assert((observed3)?.includes('WORKSPACE_VERIFICATION_REQUIRED')); });
            const observed4 = m.c.publishedDelivery;
            checks.push(() => {
                assert.equal(observed4?.revision, m.c.candidate?.revision);
                assert.equal(m.c.messages.at(-1)?.text, observed3);
                assert.deepEqual(m.c.intents.find(work => work.id === m.work.id)?.criteriaResults, criteriaResults);
                assert(!m.c.intents.some(work => work.status === 'pending'));
            });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareMissingCommand(): CoreModelRun {
    const m = new LocalModel(input => { input.goal.text = 'Run tests'; input.message.text = input.goal.text; });
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: 'candidate', artifactIds: [] });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.outcome;
            checks.push(() => { assert.equal(observed2, null); });
            const check = m.c.intents.find(work => work.kind === 'check');
            checks.push(() => {
                assert.equal(check?.status, 'pending');
                assert.deepEqual(check?.payload.verification, { status: 'unavailable' });
                assert.equal(check?.localOperations, undefined);
                assert.equal(m.c.publishedDelivery, undefined);
                assert.equal(m.c.candidate?.text, 'candidate');
            });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareQuotedCommands(): CoreModelRun {
    const text = 'Explain the following output\n```text\nrun npm test\n```\n> run npm run build\nThe example reads “then run npm run verify, twice”';
    const m = new LocalModel(input => { input.goal.text = text; input.message.text = text; });
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: 'candidate', artifactIds: [] });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const check = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending');
            const observed2 = check?.status;
            checks.push(() => { assert.equal(observed2, 'pending'); });
            const observed3 = check?.payload.verification;
            checks.push(() => { assert.equal(observed3, undefined); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStopQueued(): CoreModelRun {
    const m = queuedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'STOP' });
            m.send({ type: 'SETTLE', intentId: m.work.id });
            const observed1 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed1, 'ended'); });
            const observed2 = m.c.candidate;
            checks.push(() => { assert.equal(observed2, null); });
            const observed3 = m.request().code;
            checks.push(() => { assert.equal(observed3, 'STOPPED'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareStopPhysical(index: number): CoreModelRun {
    const rows = [
        { stage: 'claimed', prepare: claimedOperation },
        { stage: 'running', prepare: runningOperation },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare } = row;
    const m = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'STOP' });
            const cancelled = { request: m.request().code, status: m.op?.status,
                settle: m.send({ type: 'SETTLE', intentId: m.work.id }).code,
                physical: localPhysicalPending(m.c.intents[0]!), wrong: m.result({ sessionId: 'wrong' }).ok };
            checks.push(() => assert.deepEqual(cancelled, { request: 'STOPPED', status: 'cancelling',
                settle: 'LOCAL_OPERATION_PENDING', physical: true, wrong: false }));
            m.result({ result: { ok: false, code: 'cancelled', data: {} } });
            m.send({ type: 'SETTLE', intentId: m.work.id });
            const observed1 = m.c.candidate;
            checks.push(() => { assert.equal(observed1, null); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'ended'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRecoverSafe(index: number): CoreModelRun {
    const rows = [
        { stage: 'before request', prepare: () => new LocalModel() },
        { stage: 'queued', prepare: queuedOperation },
        { stage: 'succeeded', prepare: completedOperation },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare } = row;
    const m = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'RECOVER', config: localModelInput().config });
            const observed1 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed1, 'pending'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRecoverReceipt(): CoreModelRun {
    const m = completedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'RECOVER', config: localModelInput().config });
            const observed1 = m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content;
            checks.push(() => { assert((observed1)?.includes('actual')); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRecoverUncertain(index: number): CoreModelRun {
    const rows = [
        { stage: 'claimed', prepare: claimedOperation },
        { stage: 'running', prepare: runningOperation },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare } = row;
    const m = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'RECOVER', config: localModelInput().config });
            const recovered = { operation: m.op?.status, parent: m.c.intents[0]!.status, phase: taskPhase(m.snapshot),
                bypass: m.send({ type: 'RECONCILE', intentId: m.work.id, resolution: 'confirmed', detail: 'cannot bypass' }).code };
            checks.push(() => assert.deepEqual(recovered, { operation: 'uncertain', parent: 'uncertain',
                phase: 'waitingHuman', bypass: 'LOCAL_OPERATION_PENDING' }));
            const reply = m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'notStarted', detail: 'host proved no spawn' });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.op?.status;
            checks.push(() => { assert.equal(observed2, 'queued'); });
            const observed3 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed3, 'running'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareReconcileOldGoal(): CoreModelRun {
    const m = runningOperation();
    m.result({ effectsKnown: false });
    m.c.goalVersion++;
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable receipt', result: { ok: true, code: 'succeeded', data: { exitCode: 0 } } });
            const observed1 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed1, 'done'); });
            const observed2 = m.c.candidate;
            checks.push(() => { assert.equal(observed2, null); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareRecoverPermission(index: number): CoreModelRun {
    const rows = [
        { name: 'legacy payload', code: 'LOCAL_TOOLS_NOT_AUTHORIZED', prepare: () => {
                const m = new LocalModel();
                delete (m.work.payload.capabilities as Record<string, unknown>).localTools;
                return { m, config: localModelInput().config };
            } },
        { name: 'revoked bot permission', code: 'LOCAL_TOOLS_DISABLED', prepare: () => {
                const config = localModelInput().config;
                config.bots[0]!.localTools = false;
                return { m: new LocalModel(), config };
            } },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { prepare, code } = row;
    const { m, config } = prepare();
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'RECOVER', config });
            m.send({ type: 'CLAIM', intentId: m.work.id });
            m.work = m.c.intents[0]!;
            const observed1 = m.request().code;
            checks.push(() => { assert.equal(observed1, code); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareBackgroundDraft(): CoreModelRun {
    const model = new LocalModel(); const owner = model.work;
    assert(model.send({ type: 'USER_INPUT', text: '所有人讨论', reviewTargets: ['B'] }).ok);
    let coordinator = model.c.intents.at(-1)!;
    assert(model.send({ type: 'CLAIM', intentId: coordinator.id }).ok);
    coordinator = model.c.intents.find(work => work.id === coordinator.id)!;
    assert(model.send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, discussionId: coordinator.discussionId,
        fence: coordinator, decision: { action: 'review', question: '核查工程', expected: '证据', reason: '用户邀请' } }).ok);
    let member = model.c.intents.at(-1)!;
    assert(model.send({ type: 'CLAIM', intentId: member.id }).ok);
    member = model.c.intents.find(work => work.id === member.id)!; model.work = member;
    assert(model.request().ok); assert(model.claim().ok); assert(model.started().ok);
    assert(model.result({ effectsKnown: false }).ok);
    assert.equal(model.c.intents.find(work => work.id === member.id)!.status, 'uncertain');
    let accepted: boolean | undefined;
    return { act() {
        accepted = model.send({ type: 'DELIVER', workId: owner.id, fence: owner,
            text: 'must-preserve-owner-draft', artifactIds: [] }).ok;
    }, verify() {
        assert.equal(accepted, true);
        assert.equal(model.c.candidate?.text, 'must-preserve-owner-draft');
        assert.equal(model.c.outcome, null);
        assert(!model.c.intents.some(work => work.kind === 'check'));
        assert(model.c.intents.some(work => work.status === 'uncertain'));
    } };
}
export function prepareIncompatibleSettlement(index: number): CoreModelRun {
    const rows = [
        { type: 'LOCAL_RESULT', settle: (m: LocalModel) => m.result() },
        { type: 'LOCAL_RECONCILE', settle: (m: LocalModel) => m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'trusted receipt', result: { ok: true, code: 'succeeded', data: {} } }) },
    ];
    const row = rows[index];
    assert(row !== undefined);
    const { settle } = row;
    const m = runningOperation(), config = localModelInput().config;
    config.toolVersion = 'new-protocol';
    m.send({ type: 'RECOVER', config });
    const checks: (() => void)[] = [];
    return { act() {
            settle(m);
            const observed1 = m.c.reason;
            checks.push(() => { assert.equal(observed1, 'Execution version incompatible'); });
            const observed2 = taskPhase(m.snapshot);
            checks.push(() => { assert.equal(observed2, 'waitingHuman'); });
            const observed3 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed3, 'done'); });
            const observed4 = m.request().code;
            checks.push(() => { assert.equal(observed4, 'INCOMPATIBLE_EXECUTION'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareSkillHandoff(): CoreModelRun {
    const m = activatedSkill();
    m.result(skillReceipt());
    m.send({ type: 'HELP', workId: m.work.id, fence: m.work, caller: 'A', requestId: 'H', target: 'B', question: '核查', expected: '证据' });
    const checks: (() => void)[] = [];
    return { act() {
            m.send({ type: 'RECOVER', config: localModelInput().config });
            const observed1 = m.c.localSkillVersions;
            checks.push(() => { assert.deepEqual(observed1, [{ skillId: 'skill1', skillVersion: 'b'.repeat(64) }]); });
            const observed2 = m.c.intents.at(-1)!.localSkills;
            checks.push(() => { assert.deepEqual(observed2, m.c.localSkillVersions); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareOldSkillReceipt(): CoreModelRun {
    const m = activatedSkill();
    const checks: (() => void)[] = [];
    return { act() {
            m.c.goalVersion++;
            m.c.localSkillVersions = [];
            m.result(skillReceipt());
            const observed1 = m.c.localSkillVersions;
            checks.push(() => { assert.deepEqual(observed1, []); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareOwnerVerificationDenied(): CoreModelRun {
    const m = new LocalModel();
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.request({ type: 'verifyWorkspace', expectedRevision: 'b'.repeat(64) }).code;
            checks.push(() => { assert.equal(observed1, 'WORKSPACE_VALIDATION_NOT_ALLOWED'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareFinalVerificationReservation(): CoreModelRun {
    const m = checkWork();
    completeValidationCommand(m);
    assert.equal(m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work }).ok, true);
    assert.equal(m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op2', namespace: 'c'.repeat(64), requestHash: 'd'.repeat(64),
        action: { type: 'verifyWorkspace', expectedRevision: workspaceRevision }, parentAttempt: m.work.attempt, messages: [], workspaceId: 'project', fence: m.work }).ok, true);
    const claim = { type: 'LOCAL_CLAIM', intentId: m.work.id, operationId: 'op2', sessionId: 'session2', parentAttempt: m.work.attempt, fence: m.work };
    assert.equal(m.send({ ...claim, leaseAvailable: false }).code, 'WORKSPACE_BUSY');
    assert.equal(m.c.usage.ordinary, 2);
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ ...claim, leaseAvailable: true });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed2, 3); });
            const observed3 = m.c.usage.checks;
            checks.push(() => { assert.equal(observed3, 1); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareDeniedOperation(): CoreModelRun {
    const m = queuedOperation(i => { i.config.limits.ordinary = 1; });
    const checks: (() => void)[] = [];
    return { act() {
            m.claim();
            const reply = m.send({ type: 'LOCAL_REJECTED', intentId: m.work.id, operationId: 'op1', parentAttempt: m.work.attempt, result: { ok: false, code: 'BUDGET_EXHAUSTED', data: {} } });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.op?.status;
            checks.push(() => { assert.equal(observed2, 'failed'); });
            const observed3 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed3, 1); });
            const observed4 = m.c.intents[0]!.localCheckpoint?.pendingOperationId;
            checks.push(() => { assert.equal(observed4, undefined); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareUnavailableSandbox(): CoreModelRun {
    const m = claimedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.result({ result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: {} } });
            const observed1 = reply.ok;
            checks.push(() => { assert.equal(observed1, true); });
            const observed2 = m.op?.status;
            checks.push(() => { assert.equal(observed2, 'failed'); });
            const observed3 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed3, 'inflight'); });
            const observed4 = m.c.intents[0]!.localCheckpoint?.messages.at(-1)?.content;
            checks.push(() => { assert((observed4)?.includes('CLI_SANDBOX_UNAVAILABLE')); });
            const observed5 = m.result().ok;
            checks.push(() => { assert.equal(observed5, false); });
            const observed6 = m.c.usage.ordinary;
            checks.push(() => { assert.equal(observed6, 2); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareDuplicateRequest(): CoreModelRun {
    const m = queuedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.request().code;
            checks.push(() => { assert.equal(observed1, 'LOCAL_ALREADY_REQUESTED'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function preparePrematureDelivery(): CoreModelRun {
    const m = claimedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const reply = m.send({ type: 'DELIVER', text: 'premature', artifactIds: [], workId: m.work.id, fence: m.work });
            const observed1 = reply.code;
            checks.push(() => { assert.equal(observed1, 'LOCAL_OPERATION_PENDING'); });
            const observed2 = m.c.candidate;
            checks.push(() => { assert.equal(observed2, null); });
            const observed3 = m.c.intents[0]!.status;
            checks.push(() => { assert.equal(observed3, 'inflight'); });
        }, verify() { for (const check of checks)
            check(); } };
}
export function prepareForeignReceipt(): CoreModelRun {
    const m = claimedOperation();
    const checks: (() => void)[] = [];
    return { act() {
            const observed1 = m.result({ sessionId: 'alien' }).code;
            checks.push(() => { assert.equal(observed1, 'LOCAL_SESSION_MISMATCH'); });
        }, verify() { for (const check of checks)
            check(); } };
}
