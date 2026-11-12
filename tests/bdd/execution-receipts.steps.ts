import assert from 'node:assert/strict';
import { Before, Given, When, Then } from '@cucumber/cucumber';
import { persistTask, restoreTask } from '../../src/task.machine.js';
import { resourceAcquisitionProblem, requiredResources, savedResourceAcquisitions, type HostAcquisition } from '../../src/resource-acquisition.js';
import { sharedToolKnowledge } from '../../src/task/tool-knowledge.js';
import { taskHumanGate } from '../../src/task/resilience.js';
import { publicationIds } from '../../src/task/delivery.js';
import { receiptModel, recordCliObservation, recordWebObservation, currentReceiptWork, submitReceiptCandidate,
  finishReceiptCheck, assertReceiptBlocked, documentFive, documentUrl, receiptSemantics } from '../execution-receipts-model-fixture.js';
import { captureCliObservation } from '../execution-receipts-model-fixture.js';
import { receiptBackfillWindowModel, receiptCheckpointRetryModel, webHostEvidenceModel } from '../execution-receipts-model-fixture.js';
import { prepareTypedPartitionResourcesModel, unverifiedPartitionResultModel } from '../execution-receipts-model-fixture.js';
import { batchReaderModel, customReaderSourceItemsModel, dedicatedReaderRegistration, registeredReaderModel, rejectedReaderConfigurationModel } from '../acquisition-reader-configuration-model-fixture.js';
import { parseCliAcquisitionReaders } from '../../src/acquisition-readers.js';
import type { LocalModel } from '../local-model-fixture.js';
import type { SpecWorld } from './steps.js';
import { cliReceiptAcceptance, webReceiptAcceptance, receiptCheckpointRetryAcceptance, configuredReaderAcceptance, type CliReceiptCase, type WebReceiptCase } from '../execution-receipts-acceptance.js';
import { receiptWindowRecoveryAcceptance } from '../execution-recovery-acceptance.js';

interface Run { id: string; labels: string[]; m: LocalModel; receipt?: HostAcquisition; original?: string; metadata?: HostAcquisition[];
  previous?: LocalModel; frozen?: string; act(): void | Promise<void>; verify(): void; prepared(): void }
const runs = new WeakMap<SpecWorld, Run>();
const lastOwner = (m: LocalModel) => {
  const pending = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(pending); assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  m.work = m.c.intents.find(work => work.id === pending.id)!;
};
const stopAndContinue = (m: LocalModel) => {
  assert(m.send({ type: 'STOP' }).ok); assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
  assert(m.send({ type: 'CONTINUE' }).ok); lastOwner(m);
};
const changeGoal = (m: LocalModel) => {
  assert(m.send({ type: 'USER_INPUT', text: '新目标重新读取', goal: { ...m.c.goal, text: '新目标重新读取文档五',
    resourceRequirements: [{ resource: documentFive, freshness: 'current' }] } }).ok);
  assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok); lastOwner(m);
};
function preparePartial(m: LocalModel) { assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m, 'unverified'); }
function richReportPreparation(m: LocalModel) {
  assert(recordCliObservation(m).reply.ok);
  assert(m.send({ type: 'ARTIFACT', artifact: { id: 'unverified', name: 'draft.md', content: '未核实的生成材料' } }).ok);
  assert(m.send({ type: 'HELP', workId: m.work.id, fence: m.work, requestId: 'failed-helper', caller: m.c.owner,
    target: 'B', question: '核对未取得内容', expected: '缺口' }).ok);
  const pending = m.c.intents.find(work => work.kind === 'assistance' && work.status === 'pending')!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const helper = m.c.intents.find(work => work.id === pending.id)!;
  assert(m.send({ type: 'HELP_RESULT', requestId: 'failed-helper', resultId: 'failed-result', status: 'failed', answer: '资料未取得' }).ok);
  assert.equal(m.c.intents.find(work => work.id === helper.id)?.status, 'done'); lastOwner(m);
  assert(m.send({ type: 'WAIT_USER', workId: m.work.id, fence: m.work, question: '是否跳过此项内容' }).ok);
  const gate = m.c.resilience!.gates.find(item => item.scope === 'task' && item.status === 'open')!;
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确跳过这一项' }).ok); lastOwner(m);
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'unknown-physical', namespace: 'a'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['external-effect.js'] }, parentAttempt: m.work.attempt, fence: m.work, messages: [], workspaceId: 'shared' }).ok);
  assert(m.send({ type: 'LOCAL_CLAIM', intentId: m.work.id, operationId: 'unknown-physical', parentAttempt: m.work.attempt,
    sessionId: 'unknown-session', leaseAvailable: true, fence: m.work }).ok);
  assert(m.send({ type: 'LOCAL_STARTED', intentId: m.work.id, operationId: 'unknown-physical', sessionId: 'unknown-session' }).ok);
  assert(m.send({ type: 'LOCAL_RESULT', intentId: m.work.id, operationId: 'unknown-physical', sessionId: 'unknown-session',
    result: { ok: false, code: 'timeout', data: {} }, settled: true, effectsKnown: false }).ok);
}
function freeze(m: LocalModel) {
  m.at = m.c.resilience!.window.hardDeadline;
  assert(m.send({ type: 'SUPERVISE', trigger: 'timer' }).ok);
  const gate = taskHumanGate(m.c); assert.equal(gate?.cause, 'windowExpired');
  assert(m.send({ type: 'HUMAN_GATE_DECISION', gateId: gate!.id, decision: 'skip', text: '明确结束并保留已有成果与缺口' }).ok);
}

function prepare(id: string, labels: string[]): Run {
  const label = labels[0] ?? '';
  const m = receiptModel(['E105', 'E113', 'E114', 'E115', 'E118'].includes(id) ? null : id === 'E101' && label === '网页读取器' ? documentUrl : documentFive,
    id === 'E103' ? 'current' : 'saved', id === 'E113' && label === '检查额度不足' ? { checks: 0 } : {});
  const run: Run = { id, labels, m, act: () => { assertReceiptBlocked(run.m); },
    prepared: () => { assert.equal(run.m.c.outcome, null); assert(requiredResources(run.m.c).length > 0); },
    verify: () => { assert.notEqual(run.m.c.outcome, 'complete'); assert.equal(resourceAcquisitionProblem(run.m.c), 'RESOURCE_ACQUISITION_UNVERIFIED'); } };
  if (id === 'E101') {
    const observed = label === '网页读取器' ? recordWebObservation(m) : recordCliObservation(m);
    assert(observed.reply.ok); run.receipt = observed.receipt;
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 1); };
    run.act = async () => { assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m);
      if (label === '网页读取器') await webReceiptAcceptance('正文', true); else await cliReceiptAcceptance('正文'); };
    run.verify = () => { assert.equal(m.c.outcome, 'complete'); assert.equal(savedResourceAcquisitions(m.c)[0]?.snapshot, run.receipt!.snapshot); };
  }
  if (id === 'E100') run.act = () => { unverifiedPartitionResultModel(); assertReceiptBlocked(m); };
  if (id === 'E102') {
    const actual = label === '同批文档四' ? { ...documentFive, id: 'four' } : label === '另一服务中同编号的文档五'
      ? { ...documentFive, service: 'other.example' } : { ...documentFive, namespace: 'other-team' };
    const observed = recordCliObservation(m, { resource: actual }); assert(observed.reply.ok); run.receipt = observed.receipt;
  }
  if (id === 'E103' || id === 'E108' || id === 'E119') {
    const deferred = id === 'E103' && label === '被替代的执行尝试';
    const observed = deferred ? { receipt: captureCliObservation(m), reply: m.c.reply } : recordCliObservation(m);
    assert(observed.reply.ok); run.receipt = observed.receipt;
    if (label === '另一任务') { run.previous = m; run.m = receiptModel(documentFive, 'current'); }
    else if (label === '旧目标' || label === '切换目标') changeGoal(m);
    else if (label === '被替代的执行尝试' || label === '替代执行尝试') {
      assert(m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: '受控临时失败', transient: true }).ok);
      const original = m.work.id; assert(m.send({ type: 'CLAIM', intentId: original }).ok); m.work = currentReceiptWork(m);
    } else if (label === '停止') { assert(m.send({ type: 'STOP' }).ok); assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok); }
    else if (label === '原执行工作已终结') assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
    else stopAndContinue(m);
    if (id !== 'E108' && id !== 'E119') {
      run.prepared = () => { assert(run.receipt); assert(resourceAcquisitionProblem(run.m.c)); };
      run.verify = () => { assert.notEqual(run.m.c.outcome, 'complete'); assert(resourceAcquisitionProblem(run.m.c));
        const original = run.previous ?? run.m;
        if (deferred) assert(original.c.intents.flatMap(work => work.localOperations ?? []).some(op => op.id === run.receipt!.operationId && op.finishedAt === run.receipt!.at));
        else assert(original.c.intents.flatMap(work => work.hostAcquisitions ?? []).some(receipt => receipt.snapshot === run.receipt!.snapshot)); };
    }
    if (id === 'E108') {
      run.prepared = () => { assert.equal(resourceAcquisitionProblem(m.c), null); assert(run.receipt!.epoch < m.c.epoch); };
      run.act = () => { assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m); };
      run.verify = () => { assert.equal(m.c.outcome, 'complete'); assert.equal(savedResourceAcquisitions(m.c)[0]?.at, observed.receipt.at);
        assert.equal(m.c.intents.flatMap(work => work.localOperations ?? []).length, 1); };
    }
    if (id === 'E119') {
      run.prepared = () => { assert(run.receipt); assert(run.receipt!.goalVersion < m.c.goalVersion || m.c.stopped || currentReceiptWork(m).status === 'done'); };
      run.act = () => { const before = m.c.artifacts.length; assert.equal(m.send({ type: 'RECORD_ACQUISITION', intentId: run.receipt!.workId, receipt: run.receipt }).ok, false);
        assert.equal(m.c.artifacts.length, before); };
      run.verify = () => { assert.notEqual(m.c.outcome, 'complete'); assert.equal(m.c.publishedDelivery, undefined); };
    }
  }
  if (id === 'E104' || id === 'E107') {
    const semantic = id === 'E107' ? label === '缺少正文流' ? '尚未核实' : '不完整'
      : labels[1] === '需要认证' ? '需要登录' : labels[1] as keyof typeof receiptSemantics;
    const { status, ...options } = receiptSemantics[semantic as keyof typeof receiptSemantics];
    const observed = recordCliObservation(m, options); assert(observed.reply.ok); run.receipt = observed.receipt;
    run.prepared = () => { assert.equal(observed.receipt.status, status); };
    if (id === 'E104') run.act = async () => { assertReceiptBlocked(m);
      if (label.startsWith('HTTP') || label === '请求文档五却返回文档四') await webReceiptAcceptance(semantic as WebReceiptCase);
      else await cliReceiptAcceptance(semantic as CliReceiptCase); };
    run.verify = () => { assert.equal(run.receipt!.status, status); assert.equal(savedResourceAcquisitions(m.c).length, 0); assert.notEqual(m.c.outcome, 'complete'); };
  }
  if (id === 'E105') {
    run.prepared = () => { assert.equal(requiredResources(m.c).length, 0); };
    run.act = () => { assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m); };
    run.verify = () => { assert.equal(m.c.outcome, 'complete'); assert.equal(m.c.intents.flatMap(work => work.localOperations ?? []).length, 0); };
  }
  if (id === 'E106') {
    assert(m.request().ok); assert(m.claim().ok); assert(m.started().ok);
    assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout: `${label}声称已取得正文`, acquisition: { status: 'acquired' }, exitCode: 0, truncated: false } } }).ok);
    run.prepared = () => { assert.equal(m.op?.status, 'succeeded'); assert.equal(savedResourceAcquisitions(m.c).length, 0); };
  }
  if (id === 'E109') {
    assert(recordCliObservation(m).reply.ok); assert(submitReceiptCandidate(m).ok);
    run.prepared = () => { assert(m.c.candidate?.revision); assert(m.c.deliveryCycle?.evidence?.length); };
    run.act = () => {
      const saved = structuredClone(persistTask(m.snapshot)) as { context: LocalModel['c'] };
      const receipt = saved.context.intents[0]!.hostAcquisitions![0]!;
      if (label === '正文') receipt.content = '等长篡改的资源正文';
      if (label === '资源身份') receipt.resource = { ...documentFive, id: 'four' };
      if (label === '完整性') receipt.complete = false;
      if (label === '正文验证器版本') receipt.verifier = { id: 'registered-document-reader', version: 'changed' };
      m.snapshot = restoreTask(saved); finishReceiptCheck(m);
    };
  }
  if (id === 'E110') {
    run.m = receiptModel(documentUrl);
    const config = { id: 'task-protocol', version: label === '配置版本' ? 'old-version'
      : JSON.stringify([run.m.c.config.version, run.m.c.config.toolVersion]), authentication: label === '认证或会话状态' ? 'required' as const : 'satisfied' as const };
    assert(recordCliObservation(run.m, { requestedResource: documentUrl, resource: documentUrl, configuration: config,
      ...(label === '正文验证状态' ? { verifier: null } : {}) }).reply.ok);
    const url = label === '服务和租户' ? 'https://other.example/other/five' : documentUrl.url;
    assert(run.m.send({ type: 'HELP', workId: run.m.work.id, fence: run.m.work, requestId: 'next-reader', caller: 'A',
      target: 'B', question: `读取 ${url}`, expected: '正文' }).ok);
    const next = run.m.c.intents.find(work => work.kind === 'assistance' && work.status === 'pending')!;
    assert(run.m.send({ type: 'CLAIM', intentId: next.id }).ok); run.m.work = run.m.c.intents.find(work => work.id === next.id)!;
    run.prepared = () => { assert.equal(run.m.c.intents.flatMap(work => work.hostAcquisitions ?? []).length, 1); };
    run.act = () => { assert.equal(sharedToolKnowledge(run.m.c, currentReceiptWork(run.m)).filter(item => 'methodId' in item).length, 0); };
    run.verify = () => { assert.equal(run.m.c.intents.flatMap(work => work.hostAcquisitions ?? []).length, 1); };
  }
  if (id === 'E111') {
    assert(m.request({ type: 'discoverHost', commands: ['document-reader'] }).ok); assert(m.claim().ok);
    assert(m.result({ result: { ok: true, code: 'succeeded', data: { cli: { commands: [{ command: 'document-reader', host: true }], authentication: 'satisfied' } } } }).ok);
    run.prepared = () => { assert.equal(m.op?.status, 'succeeded'); };
    run.act = () => { assert.equal(savedResourceAcquisitions(m.c).length, 0); };
    run.verify = () => { assert.equal(savedResourceAcquisitions(m.c).length, 0); assert.equal(JSON.stringify(sharedToolKnowledge(m.c, currentReceiptWork(m))).includes('secret'), false); };
  }
  if (id === 'E112') {
    assert(recordCliObservation(m, { requestedResource: { ...documentFive, id: 'four' }, resource: { ...documentFive, id: 'four' } }).reply.ok);
  }
  if (id === 'E113') {
    assert(m.send({ type: 'ARTIFACT', artifact: { id: 'candidate-report', name: 'candidate.md', content: '已保存待检查报告' } }).ok);
    run.prepared = () => { assert(m.c.artifacts.some(artifact => artifact.id === 'candidate-report')); };
    run.act = () => {
      assert(submitReceiptCandidate(m).ok);
      if (label === '检查额度不足') assert.equal(m.c.candidate?.deliveryIssue?.code, 'CHECK_BUDGET_EXHAUSTED');
      else if (label === '全部要求尚未核实') finishReceiptCheck(m, 'unverified');
      else {
        const pending = m.c.intents.find(work => work.kind === 'check' && work.status === 'pending')!;
        assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
        assert(m.send({ type: 'WORK_FAILED', intentId: pending.id, reason: '检查服务失败', transient: false }).ok);
      }
    };
    run.verify = () => { assert.equal(m.c.outcome, 'partial'); assert(m.c.artifacts.some(a => a.name === 'report.md')); };
  }
  if (id === 'E114' || id === 'E115') {
    assert(m.send({ type: 'ARTIFACT', artifact: { id: 'earlier', name: 'earlier.md', content: '先前草稿' } }).ok);
    if (id === 'E114') {
      // This task tests version selection, independently of resource acquisition.
      const goal = { text: '新目标', constraints: [], criteria: ['新内容'], requiredArtifacts: 0 };
      assert(m.send({ type: 'USER_INPUT', text: '新目标不要求读取', goal }).ok);
      assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok); lastOwner(m);
    }
    assert(submitReceiptCandidate(m, '当前目标报告').ok);
    run.prepared = () => { assert(m.c.artifacts.some(a => a.id === 'earlier')); assert(m.c.candidate?.revision); };
    run.act = () => { finishReceiptCheck(m, 'unverified'); };
    run.verify = () => { assert.equal(m.c.outcome, 'partial'); assert(!publicationIds(m.c)?.includes('earlier'));
      assert(m.c.artifacts.some(a => a.id === 'earlier')); assert(publicationIds(m.c)?.length); };
  }
  if (id === 'E116') {
    richReportPreparation(m);
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 1); assert(m.c.resilience!.skips.length);
      assert(m.c.assists.some(a => a.status === 'failed')); assert(m.c.intents.some(w => w.status === 'uncertain')); };
    run.act = () => freeze(m);
    run.verify = () => {
      assert.equal(m.c.outcome, 'partial'); const report = m.c.artifacts.find(a => a.id === m.c.resilience?.frozen?.reportArtifactId)!;
      assert(report); for (const term of ['任务', '目标', 'partial', '未核验', '失败', '跳过', '未决']) assert(report.content.includes(term), term);
      assert(report.content.includes(m.c.taskId)); assert(report.content.includes(m.c.intents.flatMap(w => w.hostAcquisitions ?? [])[0]!.id));
    };
  }
  if (id === 'E117') {
    assert(submitReceiptCandidate(m, '全部资料均已处理完成').ok);
    run.prepared = () => { assert(m.c.candidate?.text.includes('全部资料均已处理完成')); assert(resourceAcquisitionProblem(m.c)); };
    run.act = () => freeze(m);
    run.verify = () => { assert.equal(m.c.outcome, 'partial'); assert(m.c.artifacts.some(a => a.content === '全部资料均已处理完成'));
      const report = m.c.artifacts.find(a => a.id === m.c.resilience?.frozen?.reportArtifactId)!;
      assert(report.content.includes('partial')); assert(report.content.includes('未核验')); assert(!report.content.includes('全部资料均已处理完成')); };
  }
  if (id === 'E118') {
    preparePartial(m); run.frozen = JSON.stringify(m.c.resilience!.frozen);
    run.prepared = () => { assert(m.c.resilience?.frozen); };
    run.act = () => { m.snapshot = restoreTask(structuredClone(persistTask(m.snapshot))); assert(m.send({ type: 'RECOVER', config: m.c.config }).ok);
      m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, attempt: m.work.attempt, text: '迟到的新正文', artifactIds: [] }); };
    run.verify = () => { assert.equal(JSON.stringify(m.c.resilience!.frozen), run.frozen); assert.equal(m.c.outcome, 'partial'); };
  }
  if (id === 'E120') {
    const original = recordCliObservation(m); assert(original.reply.ok); run.receipt = original.receipt;
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 1); assert.equal(m.c.outcome, null); };
    run.act = async () => { receiptCheckpointRetryModel(); const io = await receiptCheckpointRetryAcceptance();
      assert.equal(io.cliExecutions, 1); assert.equal(io.outcome, 'complete'); };
    run.verify = () => { assert.equal(savedResourceAcquisitions(m.c)[0]!.snapshot, run.receipt!.snapshot); };
  }
  if (id === 'E121') {
    const typed = prepareTypedPartitionResourcesModel(label as '服务文档' | '工作区文件' | 'URL');
    run.prepared = () => { assert.equal(requiredResources(typed.model.context).length, 2); };
    run.act = () => { assert.equal(typed.model.acquireTyped(typed.first, typed.resources[0]!).status, 'acquired'); };
    run.verify = () => { assert.equal(resourceAcquisitionProblem(typed.model.context, typed.first), null);
      assert.equal(resourceAcquisitionProblem(typed.model.context, typed.second), 'RESOURCE_ACQUISITION_UNVERIFIED'); };
  }
  if (id === 'E122' || id === 'E123') {
    const readers = parseCliAcquisitionReaders([dedicatedReaderRegistration]);
    run.prepared = () => { assert.equal(readers.length, 1); assert.equal(savedResourceAcquisitions(m.c).length, 0); };
    if (id === 'E122') {
      run.act = () => { run.m = rejectedReaderConfigurationModel(label); };
      run.verify = () => { assert.equal(savedResourceAcquisitions(run.m.c).length, 0);
        assert.equal(run.m.c.candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED'); };
    } else {
      run.act = async () => { run.m = registeredReaderModel('matching').m; registeredReaderModel('wrong-document'); registeredReaderModel('unregistered');
        run.m = customReaderSourceItemsModel('document').m; customReaderSourceItemsModel('url');
        customReaderSourceItemsModel('document', true); customReaderSourceItemsModel('url', true);
        run.metadata = [registeredReaderModel('description-only').receipt, registeredReaderModel('metadata-only').receipt];
        assert.equal((await configuredReaderAcceptance('matching')).outcome, 'complete');
        assert.equal((await configuredReaderAcceptance('wrong-document')).status, 'resource_mismatch');
        assert.equal((await configuredReaderAcceptance('unregistered-command')).status, 'unknown');
        assert.equal((await configuredReaderAcceptance('description-only')).status, 'empty');
        assert.equal((await configuredReaderAcceptance('custom-fields')).outcome, 'complete'); };
      run.verify = () => { assert.equal(run.m.c.outcome, 'complete'); assert.equal(savedResourceAcquisitions(run.m.c).length, 1);
        assert.deepEqual(run.metadata?.map(receipt => receipt.status), ['empty', 'empty']); };
    }
  }
  if (id === 'E125') {
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 0); };
    run.act = () => { run.m = batchReaderModel(label as '两份匹配正文' | '只有第二份正文').m; };
    run.verify = () => { assert.equal(savedResourceAcquisitions(run.m.c).length, label === '两份匹配正文' ? 2 : 1);
      assert.equal(run.m.c.intents.flatMap(work => work.localOperations ?? []).length, 1); };
  }
  if (id === 'E126') {
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 0); };
    run.act = async () => { run.m = receiptBackfillWindowModel(label === '当前处理窗口读取' ? 'current' : 'saved').m;
      assert.equal((await receiptWindowRecoveryAcceptance('MemoryStore')).outcome, 'complete');
      assert.equal((await receiptWindowRecoveryAcceptance('SqliteStore')).outcome, 'complete'); };
    run.verify = () => { assert.equal(run.m.c.outcome, 'complete'); assert.equal(savedResourceAcquisitions(run.m.c)[0]!.attempt, 1);
      assert.equal(run.m.c.intents.flatMap(work => work.localOperations ?? []).length, 1); };
  }
  if (id === 'E127') {
    run.prepared = () => { assert.equal(savedResourceAcquisitions(m.c).length, 0); };
    run.act = async () => { run.m = webHostEvidenceModel().m; webHostEvidenceModel(true);
      const actual = await webReceiptAcceptance('正文', true); assert.equal(actual.outcome, 'complete');
      assert.equal(actual.sourceIdFrom, 'actual web_fetch_result.hostEvidence JSON only'); };
    run.verify = () => { assert.equal(run.m.c.outcome, 'complete');
      assert.equal(run.m.c.intents.flatMap(work => work.localOperations ?? []).length, 0); };
  }
  return run;
}

Before({ tags: '@execution_receipts' }, function (this: SpecWorld, { pickle }) {
  const id = pickle.tags.find(tag => /^@BT_E1\d\d$/.test(tag.name))!.name.slice(4);
  const labels = pickle.steps.flatMap(step => [...step.text.matchAll(/"([^"]*)"/g)].map(match => match[1]!));
  runs.set(this, prepare(id, labels));
});

const givens = [
  '当前分片必须读取文档五的正文', '没有保存该资源的读取凭证', '{string}已保存与文档五匹配且完整的正文凭证',
  '已保存的完整读取凭证只对应{string}', '当前目标要求重新读取文档五', '引用的读取凭证属于{string}',
  '当前分片必须取得文档五的完整正文', '读取器已结束并返回{string}', '用户要求{string}且没有要求重新取得外部资源',
  '当前分片缺少文档五的可信读取凭证', '{string}自称该资源已取得正文并附有操作标识', '已保存的读取正文为{string}',
  '当前目标允许使用已保存的文档五原文且没有要求刷新', '保存的正文和原采集身份均可核实', '当前候选已经冻结文档五的读取凭证',
  '已保存文档五读取方法及其宿主验证状态', '后续执行的{string}与该方法不一致', '已核实工具入口可用且认证状态满足读取前提',
  '文档四已取得完整正文而文档五尚未取得正文', '当前目标已经保存候选报告', '旧目标已经保存文件而用户在检查期间切换目标',
  '新目标已经保存另一个候选文件', '当前目标已有多个草稿及成员原文附件', '当前任务同时存在已核实内容和未核实内容',
  '还有失败分片、明确跳过的内容和已隔离的未决效果', '未核实的模型草稿声称全部资料均已处理完成', '宿主仍保留该任务的缺失分片',
  '当前任务已经冻结部分交付正文及文件选择', '当前读取所属任务已经{string}',
  '当前目标已取得并保存完整正文及原读取检查点', '后续模型网络请求失败但工具回执和效果均已核实',
  '当前目标已明确各分片对应的{string}身份', '本片与另一片要求不同资源',
  '管理员登记固定读取器命令及参数和资源解析规则', '管理员配置固定服务读取CLI及完整参数前缀和文档身份解析',
  '该配置没有授予命令执行或宿主授权',
  '宿主为同一固定读取命令登记两份文档的真实身份与原始编号',
  '{string}的CLI正文及检查点已经持久化而宿主凭证尚未保存', '同一目标和执行轮次已安全重领原工作',
  '当前目标必须读取网页原文并按原文状态列出工作项', '网页正文自带的同名凭证字段不具有宿主权限',
];
for (const expression of givens) {
  if (expression.includes('{string}')) Given(expression, function (this: SpecWorld, _label: string) { runs.get(this)!.prepared(); });
  else Given(expression, function (this: SpecWorld) { runs.get(this)!.prepared(); });
}
const whens = [
  '成员声称已收到HTTP200和242字符并报告分片完成', '成员引用该凭证报告完成读取', '成员使用该凭证声称文档五已取得正文',
  '成员声称该凭证证明本次执行已经读取', '系统结算该资源的读取结果', '成员基于已有输入提交推理结果', '系统接受成员答复',
  '成员引用已有内容交回结果', '负责人引用该原文完善报告', '恢复后该凭证的{string}与冻结记录不一致',
  '系统投影后续执行可用的读取经验', '成员只取得配置建议而没有执行资源读取', '汇总和最终检查声称全部分片已经完成',
  '最终检查遇到{string}', '新目标因检查未核实而形成部分交付', '负责人只选择当前修订报告形成部分交付',
  '系统冻结部分交付并导出宿主报告', '用户导出该任务的部分交付', '服务恢复后收到原尝试迟到的读取结果', '原读取尝试回传资源正文凭证',
  '系统恢复并安全重试同一目标的模型请求',
  '本片保存匹配自身资源的完整正文凭证',
  '读取器配置包含{string}', '已获授权的原读取操作保存完整匹配文档正文',
  '该命令的完整JSON批次返回{string}',
  '宿主从原已保存结果重新解析并补录凭证',
  '模型只从真实网页工具结果的宿主元数据复制来源引用并交付',
];
for (const expression of whens) {
  if (expression.includes('{string}')) When(expression, async function (this: SpecWorld, _label: string) { await runs.get(this)!.act(); });
  else When(expression, async function (this: SpecWorld) { await runs.get(this)!.act(); });
}
const thens = [
  '不应把该资源记为已取得正文', '应保留缺少读取凭证的缺口并阻止完整交付', '应记录文档五的取得结果及原执行身份和正文指纹',
  '独立检查应能核对同一份冻结正文', '应保留资源不匹配的缺口', '不应借用其他文档的正文或状态完成文档五',
  '应保留本次读取尚未核实的缺口', '原始凭证仍应作为带原身份的历史观察保留', '应保留{string}而不是已取得完整正文',
  '不应把该操作共享为已经验证成功的正文读取经验', '应允许沿用该任务的独立检查流程', '不应为了证明未要求的读取而发起工具调用',
  '不应把该声明提升为宿主执行事实', '应保留原始声明及尚未核实的资源缺口', '应保留已取得内容及其实际完整性',
  '未取得的范围应保持可见且不能发布完整交付', '应允许引用原采集观察并显示原采集时间', '不应为补充凭证重新读取或声称发生了本次新读取',
  '应阻止使用变化后的凭证发布该候选', '不应靠相同长度或自报指纹掩盖变化', '不应将该方法标为已验证适用于本次资源',
  '原观察仍应保留其资源范围和验证前提', '工具建议应只表达已核实的非敏感前提', '不应产生正文读取成功事实或暴露凭据值',
  '应保留文档五的读取缺口', '不应发布完整交付或把文档四凭证移给文档五', '应保留候选及未核实的检查缺口',
  '只能形成部分交付而不能发布完整交付', '当前文件应只包含新目标明确选择的交付文件', '旧目标文件应可作为历史查阅且不能列为当前交付',
  '应冻结该报告的当前文件选择', '其他草稿和未选择原文应保留在历史或依据中', '文件本身应包含任务目标与交付版本及部分完成状态',
  '应分别列出已核实、未核实、失败、跳过和未决效果', '已核实内容应保留可追溯资源和凭证引用', '宿主报告应明确部分完成及未核实草稿身份',
  '原始草稿应原样保留且不能冒充已证实终稿', '应保留冻结的正文和当前文件选择不变', '迟到结果只能追加原身份的历史或结算原资源',
  '不应创建新的当前交付或恢复原业务执行', '不应把旧凭证绑定到新目标或新尝试',
  '应沿用原正文继续完成独立检查且不重复执行读取命令', '原凭证应保留原尝试身份和实际采集时间',
  '分片原始自报应保留且有效结果应明确尚未核实', '本片的读取义务应满足且不能被另一片资源误挡', '全任务仍应保留另一片的未取得正文缺口',
  '应拒绝无效配置且不能把该配置提升为资源取得事实', '应由同一个宿主凭证门禁核对原资源及原操作',
  '未登记命令和返回其他文档的操作应保持尚未取得正文',
  '只有标题或简介的元数据应保留正文为空缺口',
  '自定义正文协议应沿用同一凭证验证来源工作项',
  '每份取得状态应只取决于自己编号对应的唯一正文', '缺失文档不能借用相邻正文也不应重复执行该批命令',
  '应沿用原正文完成独立检查且不重复执行CLI或退回额度', '补录应保留原操作尝试和采集时间且事件时间不得倒退',
  '来源工作项应绑定原网页操作和完整冻结正文', '独立检查应完成且不能把执行操作标识当成凭证引用',
];
for (const expression of thens) {
  if (expression.includes('{string}')) Then(expression, function (this: SpecWorld, _label: string) { runs.get(this)!.verify(); });
  else Then(expression, function (this: SpecWorld) { runs.get(this)!.verify(); });
}
