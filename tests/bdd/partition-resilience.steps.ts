import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import type { Intent } from '../../src/types.js';
import { sharedToolKnowledge } from '../../src/task/tool-knowledge.js';
import { commonFailureGate, invalidMethodGate, newMethodGate, ResilientPartitionModel,
  retryBoundaryGate, uncertainPartitionGate, typedResourcePreparation, typedResourceIdentityGate, alternateMemberPreparation } from '../partition-resilience-model-fixture.js';
import { conservativeResourceEngineAcceptance, independentResourceEngineAcceptance, resourceLeaseStoreAcceptance, resourceRecoveryEngineAcceptance } from '../local-resource-policy-acceptance.js';
import { evidencePartitionPreparation, reportUnverifiedSuccess, assertUnverifiedPartition, unverifiedPartitionGate, reasoningPartitionPreparation } from '../partition-evidence-model-fixture.js';
import { partitionEvidenceEngineAcceptance, partitionSavedSourceEngineAcceptance, partitionGapRecoveryEngineAcceptance, reasoningPartitionEngineAcceptance } from '../partition-evidence-acceptance.js';
import { isolatedPolicyGate, conservativePolicyGate, readonlyVerificationPolicyGate } from '../local-resource-policy-model-fixture.js';
import { canAcquireResourceLeases, localExecutionLeases, resolveLocalResourcePolicy, type ResourceLeaseRow } from '../../src/local-resource-policy.js';
import { heldLocalResourceLeases } from '../../src/local-operation.js';
import { partitionEngineRecoveryAcceptance, successfulClaimReplayAcceptance, temporaryClaimRecoveryAcceptance, prepareSuccessfulClaimFixture, prepareTemporaryClaimFixture } from '../partition-resilience-acceptance.js';
import { recoverySourcePreparation, submitRecoverySource, assertRecoverySourceRejected } from '../map-recovery-source-model-fixture.js';
import { recoverySourceEngineAcceptance } from '../map-recovery-source-acceptance.js';
import { verifyMapRecoveryWrongSourceIntegration } from '../map-recovery-acceptance.js';
import { webRecoveryPreparation, submitWebRecovery, webRecoveryCheck, rejectedWebRecoveryGate,
  changedFrozenWebRecoveryGate, stoppedWebRecoveryGate } from '../map-recovery-web-model-fixture.js';
import { webPartitionRecoveryAcceptance } from '../map-recovery-web-acceptance.js';
import { partitionWebAuthenticationModelGate } from '../partition-web-auth-model-fixture.js';
import { partitionWebAuthenticationAcceptance } from '../partition-web-auth-acceptance.js';

interface State {
  model?: ResilientPartitionModel; initial?: Intent[]; successful?: Intent; originalResults?: unknown;
  methods?: ReturnType<typeof sharedToolKnowledge>; usage?: unknown; assignments?: number;
  boundary?: string; claim?: Awaited<ReturnType<typeof temporaryClaimRecoveryAcceptance>>;
  successReplay?: ReturnType<typeof successfulClaimReplayAcceptance>; retry?: Intent;
  temporaryFixture?: Awaited<ReturnType<typeof prepareTemporaryClaimFixture>>;
  successfulFixture?: ReturnType<typeof prepareSuccessfulClaimFixture>;
  typed?: ReturnType<typeof typedResourcePreparation>;
  resourceKind?: string;
  resourceCopies?: ReturnType<typeof isolatedPolicyGate>;
  conservative?: ReturnType<typeof conservativePolicyGate>;
  executionBoundary?: string;
  readonlyPolicies?: ReturnType<typeof readonlyVerificationPolicyGate>;
  evidence?: ReturnType<typeof evidencePartitionPreparation>;
  evidenceKind?: string;
  evidenceHistory?: unknown;
  evidenceReceipt?: ReturnType<ResilientPartitionModel['acquire']>;
  reasoning?: ReturnType<typeof reasoningPartitionPreparation>;
  recoverySource?: ReturnType<typeof recoverySourcePreparation>;
  recoverySourceKind?: string;
  webRecovery?: ReturnType<typeof webRecoveryPreparation>;
}
const states = new WeakMap<SpecWorld, State>();
After(function (this: SpecWorld) {
  states.get(this)?.temporaryFixture?.close(); states.get(this)?.successfulFixture?.close(); states.delete(this);
});
const state = (world: SpecWorld) => { let current = states.get(world); if (!current) { current = {}; states.set(world, current); } return current; };
const model = (world: SpecWorld) => { const current = state(world).model; assert(current); return current; };
function prepare(world: SpecWorld, unrelated = false) {
  const value = new ResilientPartitionModel(() => {}, unrelated), current = state(world);
  current.model = value; current.initial = value.pending('assistance').map(work => value.start(work)); return current;
}
function failTwo(world: SpecWorld, unrelated = false) {
  const current = state(world), value = model(world), first = current.initial![0]!;
  value.fail(first);
  value.fail(unrelated ? current.initial![1]! : value.start(value.pending('assistance').find(work => work.target === first.target)!));
}

Given('八个分片由四名成员并行读取同类来源', function (this: SpecWorld) { prepare(this); });
Given('已有多个分片的可信回执表明相同读取前提不可用', function (this: SpecWorld) { failTwo(this); });
When('最快失败成员先于其他成员再次空闲', function (this: SpecWorld) {
  const value = model(this); assert(value.send({ type: 'ACTIVITY', text: '重新核对可派发分片' }).ok);
});
Then('系统应限制继续使用该故障前提派发后续分片', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.pending('assistance').length, 0);
  assert.equal(value.context.discussion!.mapReduce!.scheduling!.blockedPrerequisites.length, 1);
});
Then('应保留已在验证替代方法的工作和未失败成果', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.queue.filter(part => part.status === 'running').length, 3);
  assert.equal(value.context.discussion!.results.filter(result => result.status === 'failed').length, 2);
});

Given('分片队列包含两个不共用读取前提的来源组', function (this: SpecWorld) { prepare(this, true); });
Given('第一来源组的可信回执表明共同前提失败', function (this: SpecWorld) { failTwo(this, true); });
When('系统重新选择可执行的分片', function (this: SpecWorld) {
  const value = model(this), pending = value.pending('assistance').find(work => value.url(work).includes('other.example.com'));
  assert(pending); const work = value.start(pending); value.acquire(work, value.url(work), '其他来源的完整正文', false);
  assert(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, attempt: work.attempt,
    fence: work, status: 'success', text: '其他来源的完整正文', artifacts: [{ name: 'unaffected.md', content: '其他来源的完整正文与出处' }] }).ok);
});
Then('第二来源组应仍能执行并保存自己的结果', function (this: SpecWorld) {
  const value = model(this); assert(value.queue.some(part => part.status === 'succeeded'));
  assert(value.context.artifacts.some(artifact => artifact.name === 'unaffected.md'));
});
Then('第一来源组的故障和未完成分片应保持可追溯', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.context.discussion!.results.filter(result => result.status === 'failed').length, 2);
  assert.equal(value.context.discussion!.mapReduce!.scheduling!.blockedPrerequisites[0]!.partitionIds.length, 2);
});

Given('同任务成员保存了一份受到{string}约束的读取方法', function (this: SpecWorld, boundary: string) { state(this).model = invalidMethodGate(boundary); });
When('系统为后续分片推荐可用方法', function (this: SpecWorld) {
  const value = model(this), peer = value.context.intents.find(work => work.target === 'E' && work.kind === 'assistance')!;
  state(this).methods = sharedToolKnowledge(value.context, peer);
});
Then('该方法不得被当作已验证成功经验或触发旧失败补做', function (this: SpecWorld) {
  assert.equal(state(this).methods!.filter(item => 'validation' in item).length, 0); assert.equal(model(this).context.usage.retries, 0);
});

Given('一个分片已成功而两个同类来源分片已失败', function (this: SpecWorld) {
  const current = commonFailureGate(), target = state(this); target.model = current.model; target.initial = current.initial;
  const successful = current.initial.find(work => work.target === 'D')!; target.successful = successful;
  current.model.acquire(successful, current.model.url(successful), '已经取得的独立正文', false);
  assert(current.model.send({ type: 'DISCUSSION_RESULT', discussionId: successful.discussionId!, workId: successful.id,
    attempt: successful.attempt, fence: successful, status: 'success', text: '已经取得的独立正文' }).ok);
  target.originalResults = structuredClone(current.model.context.discussion!.results);
});
Given('剩余期限和额度允许补齐这些失败', function (this: SpecWorld) {
  const value = model(this); assert(value.queue.every(part => part.deadline > value.sequence));
  assert(value.context.usage.ordinary + 10 < value.context.config.limits.ordinary);
});
When('其他成员取得经宿主验证且适用的新正文读取方法', function (this: SpecWorld) {
  const current = state(this); model(this).acquire(current.initial!.find(work => work.target === 'C')!);
});
Then('系统应重新评估并只安排仍需补齐的适用分片', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.context.usage.retries, 2);
  assert.equal(value.queue.filter(part => part.attempt === 2 || part.status === 'queued' && part.reason === 'VERIFIED_METHOD_AVAILABLE').length, 2);
});
Then('已成功分片不得重跑且旧失败历史应保持不变', function (this: SpecWorld) {
  const current = state(this), value = model(this);
  assert.equal(value.queue.find(part => part.workId === current.successful!.id)!.status, 'succeeded');
  assert.deepEqual(value.context.discussion!.results, current.originalResults);
});
Then('每个补做结果仍须绑定该分片自己的资源与执行凭证', function (this: SpecWorld) {
  const value = model(this), pending = value.pending('assistance').find(work => work.payload.partitionAttempt === 2)!;
  assert(pending); const work = value.start(pending), receipt = value.acquire(work, value.url(work), '补做分片独立正文', false);
  assert.equal(receipt.workId, work.id); assert.deepEqual(receipt.resource, { kind: 'url', url: value.url(work) });
  assert(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: '补做分片独立正文' }).ok);
  assert.equal(value.queue.find(part => part.workId === work.id)!.status, 'succeeded');
  partitionEngineRecoveryAcceptance();
});

Given('已失败分片在新方法出现前受到{string}约束', function (this: SpecWorld, boundary: string) {
  state(this).model = boundary === '原执行效果尚未核对' ? uncertainPartitionGate() : retryBoundaryGate(boundary);
});
When('系统重新评估是否补做', function (this: SpecWorld) {
  const value = model(this); assert(value.send({ type: 'RECOVER', config: value.context.config }).ok);
});
Then('不得突破该边界启动执行或把原失败改为成功', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.queue.filter(part => part.attempt > 1).length, 0);
  assert.equal(value.context.usage.retries, 0);
});
Then('未补齐原因应保留供后续协调处理', function (this: SpecWorld) {
  const value = model(this); assert(value.queue.some(part => ['failed', 'uncertain', 'cancelled'].includes(part.status)));
});

Given('一个失败分片已因适用新方法安排补做', function (this: SpecWorld) {
  const result = newMethodGate(), current = state(this); current.model = result.model;
  current.usage = structuredClone(result.model.context.usage); current.assignments = result.model.context.discussion!.mapReduce!.assignments.length;
});
When('同一方法被重复观察并重复恢复服务', function (this: SpecWorld) {
  const value = model(this); assert(value.send({ type: 'RECOVER', config: value.context.config }).ok);
  assert(value.send({ type: 'RECOVER', config: value.context.config }).ok);
});
Then('应只保留一次该方法引起的补做与计费', function (this: SpecWorld) {
  const current = state(this); assert.deepEqual(model(this).context.usage, current.usage);
  assert.equal(model(this).context.discussion!.mapReduce!.assignments.length, current.assignments);
});
Then('原尝试的迟到结果不得覆盖补做结果', function (this: SpecWorld) {
  const value = model(this), old = value.context.discussion!.results.find(result => result.status === 'failed')!;
  const work = value.context.intents.find(item => item.id === old.workId)!;
  assert.equal(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: '旧结果不得覆盖' }).ok, false);
});

Given('一个工作在成员忙碌时被可信领取检查临时拒绝', async function (this: SpecWorld) { state(this).temporaryFixture = await prepareTemporaryClaimFixture(); });
When('成员释放并在服务恢复后再次领取该工作', function (this: SpecWorld) { state(this).claim = state(this).temporaryFixture!.releaseAndRecover(); });
Then('该工作应能取得一次合法执行许可', function (this: SpecWorld) { assert.equal(state(this).claim!.attempt, 1); assert.equal(state(this).claim!.execution, 'running'); });
Then('临时拒绝不得永久占用后续领取的幂等身份', function (this: SpecWorld) { assert.equal(state(this).claim!.persistence, 'SQLite reopened twice'); });
Given('一个分片已通过可信领取并取得执行许可', function (this: SpecWorld) { state(this).successfulFixture = prepareSuccessfulClaimFixture(); });
When('相同成功领取请求被重复提交', function (this: SpecWorld) { state(this).successReplay = state(this).successfulFixture!.replay(); });
Then('不得增加该分片的执行尝试或再次计费', function (this: SpecWorld) { assert(state(this).successReplay!.duplicate.duplicate); assert.equal(state(this).successReplay!.current.attempt, 1); });
Then('同一成员不得同时执行冲突工作', function (this: SpecWorld) { assert.equal(state(this).successReplay!.current.status, 'inflight'); });

Given('一个分片正在等待真实冲突资源的租约', function (this: SpecWorld) {
  const current = prepare(this), value = model(this), work = current.initial![0]!;
  const action = { type: 'runCli' as const, executable: 'node', args: ['read.mjs', value.url(work)] };
  assert(value.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'waiting-lease', namespace: 'c'.repeat(64),
    requestHash: 'a'.repeat(64), action, parentAttempt: work.attempt, messages: [], workspaceId: 'shared', fence: work }).ok);
  assert.equal(value.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'waiting-lease', sessionId: 'lease-session',
    parentAttempt: work.attempt, leaseAvailable: false, fence: work }).code, 'WORKSPACE_BUSY');
});
When('系统检查成员和共同读取前提', function (this: SpecWorld) { assert(model(this).send({ type: 'ACTIVITY', text: '核对租约等待' }).ok); });
Then('应保留该分片的等待身份与实际资源隔离', function (this: SpecWorld) {
  const work = model(this).context.intents.find(item => item.localOperations?.some(op => op.id === 'waiting-lease'))!;
  assert.equal(work.status, 'inflight'); assert.equal(work.localOperations!.find(op => op.id === 'waiting-lease')!.status, 'queued');
});
Then('不得把排队等待当作已执行失败来计数或分享成功方法', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.context.discussion!.mapReduce!.scheduling?.blockedPrerequisites.length ?? 0, 0);
  assert.equal(value.context.discussion!.results.length, 0);
});

Given('一份已验证方法已经用于安排分片补做', function (this: SpecWorld) {
  const result = commonFailureGate(), current = state(this); current.model = result.model; current.initial = result.initial;
  result.model.acquire(result.initial.find(work => work.target === 'C')!);
  current.retry = result.model.start(result.model.pending('assistance').find(work => work.payload.partitionAttempt === 2)!);
  current.usage = structuredClone(result.model.context.usage);
});
When('随后可信回执证明相同读取前提再次失败', function (this: SpecWorld) {
  const value = model(this), work = state(this).retry!;
  value.settleOperation(work, { type: 'runCli', executable: 'node', args: ['read.mjs', value.url(work)] },
    { ok: false, code: 'failed', data: { exitCode: 1, stderr: 'authentication required' } });
});
Then('旧成功方法不得因版本相同或服务恢复而再次触发补做', function (this: SpecWorld) {
  const current = state(this), value = model(this);
  assert.equal(sharedToolKnowledge(value.context, current.initial!.find(work => work.target === 'E')!).filter(item => 'validation' in item).length, 0);
  assert.deepEqual(value.context.usage.retries, (current.usage as { retries: number }).retries);
});
Then('只有故障之后重新取得的适用正文凭证才能开启有界的新一轮补做', function (this: SpecWorld) {
  const current = state(this), value = model(this), retries = value.context.usage.retries, work = current.retry!;
  assert(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'failed', text: '可信认证失败已结算' }).ok);
  value.acquire(current.initial!.find(work => work.target === 'C')!);
  assert.equal(value.context.usage.retries, retries + 1);
});

Given('宿主已将{string}完整身份绑定到稳定分片编号', function (this: SpecWorld, kind: string) {
  const current = state(this); current.typed = typedResourcePreparation(kind); current.resourceKind = kind; current.model = current.typed.model;
});
When('一份经验证的方法取得该完整身份的资源', function (this: SpecWorld) {
  const scenario = state(this).typed!; scenario.model.acquireTyped(scenario.source, scenario.sourceResource);
});
Then('仅绑定相同完整身份的失败分片可以补做', function (this: SpecWorld) {
  const value = model(this); assert.equal(value.context.usage.retries, 1);
  assert.equal(value.queue.find(part => part.partitionId === 'part-1')!.status, 'queued');
});
Then('文档命名空间或文件版本不匹配以及未映射分片不得借用该方法', function (this: SpecWorld) {
  const kind = state(this).resourceKind!; typedResourceIdentityGate(kind, false); typedResourceIdentityGate(kind, true, false);
});

Given('两名成员的不同副本使用可信工作区隔离后端', function (this: SpecWorld) { state(this).resourceCopies = isolatedPolicyGate(); });
When('两个操作同时准备同一只读源并完成各自副本准备', function (this: SpecWorld) {
  const { model: value } = state(this).resourceCopies!;
  for (const work of value.context.intents.filter(item => item.localOperations?.some(operation => operation.status === 'claimed'))) {
    const operation = work.localOperations!.find(item => item.status === 'claimed')!;
    assert(value.send({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: operation.id,
      sessionId: operation.sessionId!, workspaceRevision: 'a'.repeat(64), isolated: true }).ok);
    assert(value.send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: operation.id, sessionId: operation.sessionId! }).ok);
  }
});
Then('两者应能分别执行且不再占用源准备租约', function (this: SpecWorld) {
  const value = state(this).resourceCopies!.model, operations = value.context.intents.flatMap(work => work.localOperations ?? []);
  assert.equal(operations.filter(operation => operation.status === 'running').length, 2);
  assert(operations.every(operation => heldLocalResourceLeases(operation).every(lease => lease.phase === 'execute')));
});
Then('不得仅因属于同一任务而串行等待另一条命令结束', function (this: SpecWorld) {
  const { a, b, model: value } = state(this).resourceCopies!;
  assert.notEqual(a.conflictKey, b.conflictKey); assert.equal(value.context.intents.flatMap(work => work.localOperations ?? []).filter(operation => operation.status === 'queued').length, 0);
  independentResourceEngineAcceptance(); resourceRecoveryEngineAcceptance();
});
Given('本地执行处于{string}且可能影响共享资源', function (this: SpecWorld, boundary: string) {
  state(this).executionBoundary = boundary; state(this).conservative = conservativePolicyGate(boundary);
});
When('两个冲突操作竞争执行租约', function (this: SpecWorld) {
  const { a, b } = state(this).conservative!;
  const rows = a.resourceLeases.map(lease => ({ ...lease, owner: 'first' }));
  assert.equal(canAcquireResourceLeases(rows, b.resourceLeases, 'second'), false);
});
Then('第二个操作应等待实际冲突解除', function (this: SpecWorld) {
  const operations = state(this).conservative!.model.context.intents.flatMap(work => work.localOperations ?? []);
  assert.equal(operations.filter(operation => operation.status === 'queued').length, 1);
  assert.equal(operations.filter(operation => operation.status === 'claimed').length, 1);
});
Then('后端可用标记不得被当作副本工作区隔离证明', function (this: SpecWorld) {
  const { a, b } = state(this).conservative!; assert.equal(a.conflictKey, 'source'); assert.equal(b.conflictKey, 'source');
  conservativeResourceEngineAcceptance(state(this).executionBoundary!);
});
Given('一个隔离副本正在读取权威源准备执行', function (this: SpecWorld) { state(this).resourceCopies = isolatedPolicyGate(); });
When('另一操作尝试写入该权威源', function (this: SpecWorld) {
  const { a, b } = state(this).resourceCopies!;
  const rows = [...a.resourceLeases.map(lease => ({ ...lease, owner: 'a' })), ...b.resourceLeases.map(lease => ({ ...lease, owner: 'b' }))];
  const writer = resolveLocalResourcePolicy({ workspaceId: 'source', isolatedWork: false, execution: 'sandbox', sandboxConfinesWorkspace: true, action: 'runCli' });
  assert.equal(canAcquireResourceLeases(rows, writer.resourceLeases, 'writer'), false);
});
Then('源准备完成前共享写应被拒绝', function (this: SpecWorld) {
  const value = state(this).resourceCopies!.model;
  assert(value.context.intents.flatMap(work => work.localOperations ?? []).every(operation => heldLocalResourceLeases(operation).some(lease => lease.key === 'source' && lease.phase === 'prepare')));
});
Then('宿主可信确认准备完成后应只释放准备读并保留副本执行保护', function (this: SpecWorld) {
  const value = state(this).resourceCopies!.model;
  for (const work of value.context.intents.filter(item => item.localOperations?.length)) {
    const operation = work.localOperations![0]!;
    assert(value.send({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: operation.id, sessionId: operation.sessionId!, isolated: true }).ok);
    const current = value.context.intents.find(item => item.id === work.id)!.localOperations![0]!;
    assert(heldLocalResourceLeases(current).every(lease => lease.phase === 'execute'));
    assert(heldLocalResourceLeases(current).some(lease => lease.key.startsWith('copy-') && lease.mode === 'write'));
  }
});
Given('两个验证只读取同一权威源和各自副本', function (this: SpecWorld) { state(this).readonlyPolicies = readonlyVerificationPolicyGate(); });
When('系统校验这两个验证以及一个共享写操作的租约', function (this: SpecWorld) {
  const { a, b, writer } = state(this).readonlyPolicies!;
  const rows: ResourceLeaseRow[] = a.resourceLeases.map(lease => ({ ...lease, owner: 'a' }));
  assert(canAcquireResourceLeases(rows, b.resourceLeases, 'b')); assert.equal(canAcquireResourceLeases(rows, writer.resourceLeases, 'writer'), false);
});
Then('两个只读验证应能并行而共享写仍须等待', function (this: SpecWorld) {
  assert(state(this).readonlyPolicies!.a.resourceLeases.every(lease => lease.mode === 'read'));
  assert(state(this).readonlyPolicies!.writer.resourceLeases.some(lease => lease.mode === 'write'));
});
Then('验证期间不得提前释放其执行阶段的读取保护', function (this: SpecWorld) {
  const { a } = state(this).readonlyPolicies!; assert.deepEqual(localExecutionLeases(a.resourceLeases), a.resourceLeases);
  resourceLeaseStoreAcceptance(false); resourceLeaseStoreAcceptance(true);
});

Given('分片补做只剩一个并发空位且首个空闲成员没有所需工具权限', function (this: SpecWorld) {
  const scenario = alternateMemberPreparation(), current = state(this); current.model = scenario.model; current.retry = scenario.retry;
});
Given('另一名空闲成员满足该补做方法的权限前提', function (this: SpecWorld) {
  assert(model(this).context.config.bots.some(bot => bot.id === 'F' && bot.localTools !== false));
});
When('系统重新选择分片与成员', function (this: SpecWorld) {
  assert(model(this).send({ type: 'WORK_FAILED', intentId: state(this).retry!.id, transient: false, reason: '首选成员所需工具已撤权' }).ok);
});
Then('应由满足前提的成员接手且不得重复空转队列', function (this: SpecWorld) {
  const value = model(this); assert(value.pending('assistance').some(work => work.target === 'F' && !!work.payload.verifiedReadMethod));
  assert.equal(value.context.discussion!.mapReduce!.concurrency, 4); assert(value.queue.filter(part => part.status === 'running').length <= 4);
});

Given('分片负有明确的{string}读取义务而没有适用可信获取凭证', function (this: SpecWorld, kind: string) {
  const current = state(this); current.evidence = evidencePartitionPreparation(kind); current.evidenceKind = kind;
});
When('成员自报成功并声称已经抓取来源', function (this: SpecWorld) {
  const scenario = state(this).evidence!; reportUnverifiedSuccess(scenario.model, scenario.work);
});
Then('可信分片状态应为部分完成且列出资源缺口', function (this: SpecWorld) {
  const scenario = state(this).evidence!; assertUnverifiedPartition(scenario.model, scenario.work, scenario.resource);
});
Then('成员原始成功自报和原文应保留但不得冒充执行事实', function (this: SpecWorld) {
  const current = state(this), scenario = current.evidence!;
  const result = assertUnverifiedPartition(scenario.model, scenario.work, scenario.resource);
  assert.equal(result.reportedStatus, 'success'); assert.equal(result.status, 'partial');
  partitionEvidenceEngineAcceptance(current.evidenceKind!);
});
Given('分片只要求基于已有上下文推理而没有资源读取义务', function (this: SpecWorld) {
  state(this).reasoning = reasoningPartitionPreparation();
});
When('成员在没有工具调用时提交完成的推理结果', function (this: SpecWorld) {
  const { model: value, work } = state(this).reasoning!;
  assert(value.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id,
    attempt: work.attempt, fence: work, status: 'success', text: '基于已有上下文的完整推理' }).ok);
});
Then('该分片仍应允许按原有结果契约成功结算', function (this: SpecWorld) {
  const { model: value, work } = state(this).reasoning!;
  assert.equal(value.context.discussion!.mapReduce!.queue!.find(part => part.workId === work.id)!.status, 'succeeded');
  assert.equal(work.localOperations?.length ?? 0, 0); reasoningPartitionEngineAcceptance();
});
Given('一个读取分片的原成功自报已被可信状态降为部分完成', function (this: SpecWorld) {
  const scenario = unverifiedPartitionGate(), current = state(this); current.evidence = scenario;
  current.evidenceHistory = structuredClone(scenario.model.context.discussion!.results.find(result => result.workId === scenario.work.id));
});
When('后续成员取得适用的新可信读取方法并允许补做', function (this: SpecWorld) {
  const current = state(this), scenario = current.evidence!, source = scenario.initial.find(work => work.target === 'C')!;
  current.evidenceReceipt = scenario.model.acquire(source, scenario.model.url(scenario.work), '后续可信来源正文', false);
});
Then('系统应保留原始自报并安排该资源缺口的有界补做', function (this: SpecWorld) {
  const current = state(this), scenario = current.evidence!, value = scenario.model;
  assert.equal(value.context.usage.retries, 1); assert.equal(value.queue.find(part => part.partitionId === 'part-1')!.reason, 'VERIFIED_METHOD_AVAILABLE');
  assert.deepEqual(value.context.discussion!.results.find(result => result.workId === scenario.work.id), current.evidenceHistory);
});
Then('资源完成结论应引用原始获取凭证并区分复用与新抓取', function (this: SpecWorld) {
  const current = state(this), value = current.evidence!.model;
  const occupied = value.pending('assistance').find(work => work.target === 'B' && work.payload.partitionAttempt === 1)!;
  value.fail(value.start(occupied), false);
  const retry = value.start(value.pending('assistance').find(work => (work.payload.partition as { id: string }).id === 'part-1')!);
  reportUnverifiedSuccess(value, retry);
  assert.equal(value.queue.find(part => part.workId === retry.id)!.status, 'succeeded');
  const result = value.context.discussion!.results.find(item => item.workId === retry.id)!;
  assert(result.resourceSources?.some(reference => reference.acquisitionId === current.evidenceReceipt!.id && reference.reused));
  partitionGapRecoveryEngineAcceptance(); partitionSavedSourceEngineAcceptance();
});

Given('一个待补齐分片负有明确的{string}读取义务且另一个操作已取得真实正文', function (this: SpecWorld, kind: string) {
  const current = state(this); current.recoverySource = recoverySourcePreparation(kind); current.recoverySourceKind = kind;
});
When('负责人却指定没有取得该资源的成功命令作为补齐来源', function (this: SpecWorld) {
  submitRecoverySource(state(this).recoverySource!);
});
Then('系统应拒绝该片恢复声明并保留原失败和资源缺口', function (this: SpecWorld) {
  assertRecoverySourceRejected(state(this).recoverySource!);
});
Then('全任务已有其他真实来源或命令完整退出成功均不得替代指定来源的资源凭证', async function (this: SpecWorld) {
  recoverySourceEngineAcceptance(state(this).recoverySourceKind!);
  const actual = await verifyMapRecoveryWrongSourceIntegration();
  assert.equal(actual.outcome, 'partial'); assert.equal(actual.cliCalls, 2);
  assert.equal(actual.checkCalls, 0); assert.equal(actual.resolutions, 0);
});

Given('原分片读取失败而负责人已通过网页工具取得目标的完整可信正文', function (this: SpecWorld) {
  state(this).webRecovery = webRecoveryPreparation();
});
When('负责人仅使用工具回传的来源引用声明补齐该分片', function (this: SpecWorld) {
  submitWebRecovery(state(this).webRecovery!);
});
Then('该网页来源应能进入独立核验并在通过后解决原分片缺口', async function (this: SpecWorld) {
  const scenario = state(this).webRecovery!, { event } = webRecoveryCheck(scenario);
  assert(scenario.model.send(event).ok); assert.equal(scenario.model.context.outcome, 'complete');
  assert.deepEqual(scenario.model.queue[0]!.resolution!.sourceOperationIds, [scenario.receipt.id]);
  const actual = await webPartitionRecoveryAcceptance(); assert.equal(actual.outcome, 'complete'); assert.equal(actual.resolutions, 2);
});
Then('未完整核实或身份与冻结来源不匹配的网页仍不得被当作恢复证据', async function (this: SpecWorld) {
  for (const boundary of ['不完整', '未验证', '资源不匹配', '登录页', '读取失败', '请求ID冒充来源引用']) rejectedWebRecoveryGate(boundary);
  changedFrozenWebRecoveryGate(); stoppedWebRecoveryGate();
  const actual = await webPartitionRecoveryAcceptance(true); assert.equal(actual.outcome, 'partial'); assert.equal(actual.resolutions, 0);
});
Then('同配置网页宿主观察到的新认证故障也应立即失效旧方法且不得重复复活旧补做', async function () {
  assert.equal(partitionWebAuthenticationModelGate().paths, 4);
  const actual = await partitionWebAuthenticationAcceptance(); assert.deepEqual(actual.methodCounts, [1, 0, 1]);
});
