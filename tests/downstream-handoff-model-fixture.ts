import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { LocalModel } from './local-model-fixture.js';
import { maximumCount } from '../src/budget-defaults.js';
import { currentDeliveryIssues, deliveryJudgments, type CriterionJudgment } from '../src/delivery-acceptance.js';
import { artifactVerification } from '../src/resource-acquisition.js';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';
import { sourceClaimsModel, submitSourceClaim } from './source-claims-model-fixture.js';
import { unknownEffectsModel } from './direct-map-delivery-model-fixture.js';
import type { Intent } from '../src/types.js';

export function claimHandoff(m: LocalModel, kind: Intent['kind']) {
  const pending = m.c.intents.find(w => w.kind === kind && w.status === 'pending'); assert(pending, `missing ${kind}`);
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const work = m.c.intents.find(w => w.id === pending.id)!;
  if (kind === 'check') assert(m.send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt }).ok);
  return work;
}
export function submitHandoff(m: LocalModel, owner = m.work, id = 'delivery') {
  assert(m.send({ type: 'DELIVER', id, workId: owner.id, fence: owner, attempt: owner.attempt, text: '当前任务的最终报告', artifactIds: [],
    artifacts: [{ name: 'result.md', content: '本次已满足用户要求的正文' }] }).ok);
}
export function reportHandoff(m: LocalModel, check: Intent, results?: CriterionJudgment[]) {
  return m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, resultId: `result:${check.id}:${check.attempt}`,
    candidateRevision: (check.payload.candidate as { revision: string }).revision,
    criteriaResults: results ?? m.c.candidate!.acceptance!.criteria.map(c => ({ criterionId: c.id, status: 'passed' })) });
}
export function historicalHandoff(history: string) {
  const m = new LocalModel();
  if (history === '成员评审失败') m.c.review = { id: 'r', request: '评审', targets: ['B'], completed: ['B'], status: 'summarizing', epoch: 1, goalVersion: 1, incomplete: 'B执行失败' };
  else if (history === '用户跳过执行步骤') m.c.resilience!.skips.push({ id: 'skip', windowId: m.c.resilience!.window.id, targetKind: 'work', targetId: 'old-work', reason: '用户明确跳过', at: 0, authorization: 'human', epoch: 1, goalVersion: 1 });
  else {
    assert(m.send({ type: 'USER_INPUT', text: '请B讨论', reviewTargets: ['B'] }).ok);
    const coordinator = claimHandoff(m, 'facilitator');
    assert(m.send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, fence: coordinator, discussionId: coordinator.discussionId,
      decision: { action: 'review', question: '评审当前任务', expected: '建议', reason: '用户邀请' } }).ok);
    const member = claimHandoff(m, 'assistance');
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: member.id, fence: member, attempt: member.attempt, discussionId: member.discussionId,
      status: 'failed', text: '' }).ok);
    const summary = claimHandoff(m, 'discussionSummary');
    assert(m.send({ type: 'DISCUSSION_RESULT', workId: summary.id, fence: summary, attempt: summary.attempt, discussionId: summary.discussionId,
      status: 'partial', text: '保留B失败事实，负责人继续完成。' }).ok);
    assert(m.send({ type: 'SETTLE', intentId: m.work.id, attempt: m.work.attempt }).ok);
  }
  const owner = m.c.intents.find(w => w.kind === 'owner' && w.status === 'inflight') ?? claimHandoff(m, 'owner');
  submitHandoff(m, owner); return m;
}
export function sourceHandoffModel() {
  const run = sourceClaimsModel('跨文档'); assert(submitSourceClaim(run).ok);
  assert.equal(run.m.snapshot.value, 'checking'); assert.equal(run.m.c.candidate?.deliveryIssue, undefined);
  const check = run.m.c.intents.find(w => w.kind === 'check')!;
  const materials = deliveryCheckMaterials(run.m.c, check)!;
  assert.equal(materials.artifacts[0]!.sourceItems![0]!.sourceDocId, 'doc-4');
  assert.equal(materials.artifacts[0]!.sourceItems![0]!.sourceEvidenceId, 'op1');
  assert(!run.m.c.intents.some(w => w.payload.deliveryRevision)); return run;
}
export function citationHandoff(quote: string) {
  const m = new LocalModel(); submitHandoff(m);
  const check = claimHandoff(m, 'check');
  const results: CriterionJudgment[] = m.c.candidate!.acceptance!.criteria.map(c => ({ criterionId: c.id, status: 'passed',
    source: { id: quote === '未收录的来源编号' ? 'unlisted' : 'M', quote: '不是原文逐字引用' } }));
  return { m, check, results };
}
export function latestHandoffModel() {
  const m = new LocalModel(); submitHandoff(m); const check = claimHandoff(m, 'check'); assert(reportHandoff(m, check).ok);
  const latest = m.c.intents.find(w => w.id === check.id)!;
  const old = structuredClone(latest); old.id = 'old-check'; old.criteriaResults = old.criteriaResults!.map(r => ({ ...r, status: 'failed', reason: '旧失败' }));
  m.c.intents.splice(m.c.intents.indexOf(latest), 0, old);
  assert(deliveryJudgments(m.c, m.c.candidate!.revision).every(r => r.status === 'passed'));
  assert.deepEqual(currentDeliveryIssues(m.c), []);
  assert.equal(artifactVerification(m.c, m.c.artifacts.at(-1)!).status, 'verified'); return m;
}
export function protocolHandoffModel() {
  const m = new LocalModel(input => { input.config.limits.checks = maximumCount; input.config.limits.retries = maximumCount; input.config.limits.replans = maximumCount; });
  submitHandoff(m); const first = claimHandoff(m, 'check'); assert(reportHandoff(m, first, []).ok);
  assert.equal(m.snapshot.value, 'checking');
  const retry = claimHandoff(m, 'check'); assert(reportHandoff(m, retry, []).ok);
  assert.equal(m.c.outcome, 'partial'); assert.equal(m.c.candidate?.deliveryIssue?.code, 'CHECK_MISSING_CRITERION');
  assert.equal(m.c.intents.filter(w => w.kind === 'check' && ['pending', 'inflight'].includes(w.status)).length, 0);
  assert.equal(m.c.usage.checks, 2); return m;
}
export function protocolFailureHandoffModel() {
  const m = new LocalModel(input => { input.config.limits.checks = maximumCount; input.config.limits.retries = maximumCount; });
  submitHandoff(m);
  for (let attempt = 0; attempt < 2; attempt++) {
    const check = claimHandoff(m, 'check');
    assert(m.send({ type: 'WORK_FAILED', intentId: check.id, fence: check, attempt: check.attempt,
      transient: true, reason: 'Invalid model response', checkDiagnostic: { code: 'CHECK_INVALID_RESULT' } }).ok);
  }
  assert.equal(m.c.outcome, 'partial'); assert.equal(m.c.usage.retries, 1);
  assert(!m.c.intents.some(w => w.kind !== 'cancel' && w.status === 'pending')); return m;
}
export function staleHandoffModel() {
  const m = new LocalModel(); submitHandoff(m); const old = claimHandoff(m, 'check');
  assert(m.send({ type: 'USER_INPUT', text: '新的用户要求' }).ok);
  assert(reportHandoff(m, old).ok);
  submitHandoff(m, claimHandoff(m, 'owner'), 'revised');
  assert.equal(reportHandoff(m, old).ok, false); assert.equal(m.c.outcome, null);
  assert.equal(m.snapshot.value, 'checking'); return m;
}
export function repairedHandoffModel() {
  const m = new LocalModel(); submitHandoff(m); const check = claimHandoff(m, 'check');
  const oldId = m.c.artifacts[0]!.id;
  assert(m.send({ type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, resultId: 'repaired',
    candidateRevision: m.c.candidate!.revision, repair: { text: '检查员已直接补齐正文', artifacts: [{ name: 'result.md', content: '已直接修正的完整报告', replacesArtifactId: oldId }] },
    criteriaResults: m.c.candidate!.acceptance!.criteria.map(c => ({ criterionId: c.id, status: 'passed' })) }).ok);
  assert.equal(m.c.outcome, 'complete'); assert.equal(m.c.candidate!.text, '检查员已直接补齐正文');
  assert(m.c.artifacts.some(a => a.id === oldId)); assert.equal(m.c.intents.filter(w => w.kind === 'owner').length, 1);
  assert.equal(m.c.intents.filter(w => w.kind === 'check').length, 1); return m;
}
export function gapsHandoffModel() {
  const m = new LocalModel(); submitHandoff(m); const check = claimHandoff(m, 'check');
  assert(reportHandoff(m, check, m.c.candidate!.acceptance!.criteria.map(c => ({ criterionId: c.id, status: 'unverified', reason: '原资料无法取得' }))).ok);
  assert.equal(m.c.outcome, 'complete'); assert(m.c.messages.at(-1)!.text.includes('原资料无法取得'));
  assert.equal(m.c.intents.filter(w => w.kind === 'owner').length, 1); return m;
}
export function noMechanicalLoopModel() {
  const m = new LocalModel(input => { input.goal.requiredArtifacts = 1; input.config.limits.replans = maximumCount; });
  assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, attempt: m.work.attempt, text: '没有文件', artifactIds: [] }).ok);
  assert(reportHandoff(m, claimHandoff(m, 'check')).ok);
  assert(m.c.candidate!.text.includes('尚未提供要求的全部文件'));
  assert.equal(m.c.intents.filter(w => w.kind === 'owner').length, 1); assert.equal(m.c.outcome, 'complete'); return m;
}
export function selfRepairToolsModel() {
  const m = new LocalModel(); submitHandoff(m); const check = claimHandoff(m, 'check'); m.work = check;
  assert(m.send({ type: 'CONSUME', intentId: check.id, fence: check, attempt: check.attempt }).ok);
  assert(m.request({ type: 'runCli', executable: 'node', args: ['repair.js'] }).ok);
  assert(m.claim().ok); assert(m.started().ok); assert(m.result().ok);
  assert(reportHandoff(m, check).ok); assert.equal(m.c.outcome, 'complete');
  assert.equal(m.c.intents.filter(w => w.kind === 'owner').length, 1); return m;
}
export function failedValidationHandoffModel() {
 const m=new LocalModel(input=>{input.goal.text='运行 npm test';input.message.text='运行 npm test';});submitHandoff(m);const check=claimHandoff(m,'check');m.work=check;
 assert(m.request({type:'runCli',executable:'npm',args:['test'],execution:'sandbox'}).ok);assert(m.claim().ok);
 assert(m.send({type:'LOCAL_STARTED',intentId:check.id,operationId:'op1',sessionId:'session1',isolated:true,workspaceRevision:'a'.repeat(64)}).ok);
 assert(m.result({intentId:check.id,result:{ok:false,code:'CLI_FAILED',data:{exitCode:1,stdout:'test stdout',stderr:'具体失败诊断',truncated:false}}}).ok);
 const material=deliveryCheckMaterials(m.c,m.c.intents.find(w=>w.id===check.id)!)!;
 assert.equal(material.verification?.status,'failed');assert.equal(material.verification?.stderr,'具体失败诊断');
 assert(material.evidence.some(source=>source.metadata.sourceWorkId===check.id));
 assert(m.send({type:'WORK_FAILED',intentId:check.id,fence:check,attempt:check.attempt,transient:true,reason:'network'}).ok);
 const retry=claimHandoff(m,'check');assert(deliveryCheckMaterials(m.c,retry)!.evidence.some(source=>source.id==='op1'));
 return m;
}
export function failedAssistanceHandoffModel() {
 const m=new LocalModel();assert(m.send({type:'HELP',workId:m.work.id,fence:m.work,requestId:'help',caller:'A',target:'B',question:'读取材料',expected:'原文'}).ok);
 const help=claimHandoff(m,'assistance');assert(m.send({type:'RECORD_RESULT',workId:help.id,fence:help,attempt:help.attempt,requestId:'help',resultId:'failed-help',status:'failed',answer:'无法访问必要资料'}).ok);
 assert(m.send({type:'HELP_RESULT',requestId:'help',resultId:'failed-help',status:'failed',answer:''}).ok);
 assert.equal(m.c.assists[0]!.answer,'');assert.equal(m.c.assists[0]!.reason,'无法访问必要资料');
 const owner=m.c.intents.find(w=>w.kind==='owner'&&w.status==='pending')!;assert.equal(owner.payload.answer,'');assert.equal(owner.payload.reason,'无法访问必要资料');
 const failed=new LocalModel();assert(failed.send({type:'HELP',workId:failed.work.id,fence:failed.work,requestId:'help',caller:'A',target:'B',question:'读取材料',expected:'原文'}).ok);
 const child=claimHandoff(failed,'assistance');assert(failed.send({type:'WORK_FAILED',intentId:child.id,fence:child,attempt:child.attempt,transient:false,reason:'执行器失败诊断'}).ok);
 const resumed=failed.c.intents.find(w=>w.kind==='owner'&&w.status==='pending')!;assert.equal(resumed.payload.answer,'');assert.equal(resumed.payload.reason,'执行器失败诊断');return m;
}
export function explicitRetryAfterDeliveryModel() {
 const m=failedAssistanceHandoffModel();submitHandoff(m,claimHandoff(m,'owner'));const check=claimHandoff(m,'check');
 assert(reportHandoff(m,check,m.c.candidate!.acceptance!.criteria.map(c=>({criterionId:c.id,status:'unverified',reason:'协助原资料仍缺失'}))).ok);
 assert.equal(m.c.outcome,'complete');assert(!m.c.intents.some(w=>w.status==='pending'));const published=structuredClone(m.c.publishedDelivery);
 assert(m.send({type:'RETRY_ASSISTANCE',requestId:'help',text:'用户明确重试该协助',config:m.c.config}).ok);
 assert.equal(m.c.epoch,2);assert.deepEqual(m.c.publishedDelivery,published);assert.equal(m.c.assists.at(-1)!.retryOf,'help');return m;
}
export function downstreamHandoffModelGate() {
  for (const history of ['普通讨论失败', '成员评审失败', '用户跳过执行步骤']) {
    const m = historicalHandoff(history); assert(reportHandoff(m, claimHandoff(m, 'check')).ok); assert.equal(m.c.outcome, 'complete');
  }
  sourceHandoffModel(); failedValidationHandoffModel(); failedAssistanceHandoffModel(); explicitRetryAfterDeliveryModel();
  for (const quote of ['未收录的来源编号', '非逐字引文']) { const run = citationHandoff(quote); assert(reportHandoff(run.m, run.check, run.results).ok); assert.equal(run.m.c.outcome, 'complete'); assert.equal(run.m.c.usage.checks, 1); }
  latestHandoffModel(); protocolHandoffModel(); protocolFailureHandoffModel(); staleHandoffModel(); unknownEffectsModel(); repairedHandoffModel(); gapsHandoffModel(); noMechanicalLoopModel(); selfRepairToolsModel();
  return { model: createHash('sha256').update(readdirSync('src',{recursive:true}).map(String).filter(p=>p.endsWith('.ts')).sort().map(p=>readFileSync('src/'+p)).join('')).digest('hex'), traces: ['discussion-failure-latest-pass', 'review-failure-latest-pass', 'explicit-skip-latest-pass', 'source-declarations-forwarded', 'unknown-citation-accepted', 'paraphrase-accepted', 'latest-verdict-and-artifact', 'maximum-budget-protocol-exits', 'stale-candidate-rejected', 'unknown-effects-preserved','direct-repair-with-original-retained','gaps-declared-and-delivered','missing-files-declared-and-delivered','same-work-tools','failed-validation-diagnostics-and-own-source-reuse','malformed-provider-protocol-exits','failed-assistance-diagnostic-preserved','explicit-user-retry-after-delivery'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(downstreamHandoffModelGate(), null, 2));
