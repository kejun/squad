import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { sharedModelRoles, sharedRoleAcceptance, sharedNormativeAcceptance, sharedUnknownAcceptance,
  sharedAuthorizationAcceptance, sharedNonModelBoundaryAcceptance, type SharedBehaviorProof, type SharedModelRole } from '../shared-agent-behavior-acceptance.js';
import { sharedCitationAcceptance, sharedFixedMaterialAcceptance } from '../shared-agent-behavior-acceptance.js';

interface State { role?: SharedModelRole; family?: string; basis?: string; label?: string; proof?: SharedBehaviorProof;
  nonModel?: Awaited<ReturnType<typeof sharedNonModelBoundaryAcceptance>> }
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; }
function role(value: string): SharedModelRole { assert(sharedModelRoles.includes(value as SharedModelRole)); return value as SharedModelRole; }
function proof(world: SpecWorld) { const result = state(world).proof; assert(result); assert.equal(result.layer, 'actual-http-and-host-protocol; scripted-provider-not-semantic-effect'); return result; }
function delivered(world: SpecWorld) { const result = proof(world); assert(result.requests.length); assert(result.requests.every(request => request.sharedCopies === 1 && request.schemaPreserved)); return result; }
const timeout = { timeout: 30_000 };

Given('当前任务已经保存可领取的{string}工作', function (this: SpecWorld, value: string) { state(this).role = role(value); });
When('宿主通过默认模型适配器执行该工作', timeout, async function (this: SpecWorld) {
  const current = state(this); current.proof = await sharedRoleAcceptance(current.role!);
  if (current.role === 'owner') current.nonModel = await sharedNonModelBoundaryAcceptance();
});
Then('模型请求应恰好包含一次完整的共享行为规范', function (this: SpecWorld) { delivered(this); });
Then('该工作的专用职责和现有输出协议应继续生效', function (this: SpecWorld) {
  const result = delivered(this); assert(result.requests.some(request => request.kind === state(this).role)); assert.equal(result.noNewAuthority, true);
  if (state(this).nonModel) { assert.equal(state(this).nonModel!.providerRequests, 0); assert.equal(state(this).nonModel!.defaultPromptCoverageClaimed, false); }
});

Given('{string}只允许宿主规定的动作和字段', function (this: SpecWorld, value: string) { state(this).role = role(value); });
When('该工作收到共享规范并修正不合协议的响应', timeout, async function (this: SpecWorld) { state(this).proof = await sharedRoleAcceptance(state(this).role!, 'repair'); });
Then('后续模型请求仍应保留同一共享规范和宿主保存的当前工作身份', function (this: SpecWorld) {
  const result = delivered(this), target = result.requests.filter(request => request.kind === state(this).role); assert.equal(target.length, 2); assert(target.every(request => request.workId.length > 0));
});
Then('更正和限制只能使用该角色原有的可读字段', function (this: SpecWorld) { assert(delivered(this).requests.every(request => request.schemaPreserved)); });
Then('不得新增权限或为格式修复重放外部操作', function (this: SpecWorld) { const result = proof(this); assert.equal(result.noNewAuthority, true); assert.equal(result.host!.webCalls, 0); assert.equal(result.host!.retries, 1); });

Given('当前关于某项操作的依据只有{string}', function (this: SpecWorld, value: string) { state(this).basis = value; state(this).family = 'execution-claim'; });
When('宿主向模型提供共享行为规范', timeout, async function (this: SpecWorld) {
  const scope: Record<string, string> = { 仅有计划: '尚未执行', 已发起但没有确定结果: '结果尚未确认', 宿主记录明确没有运行: '未运行',
    当前没有执行记录: '无法确认是否运行', 只有其他成员报告通过: '保留报告者和报告范围', 只核查了部分要求: '只报告这些要求通过' };
  const current = state(this); assert(scope[current.basis!]); current.proof = await sharedNormativeAcceptance(current.family!, current.basis!, scope[current.basis!]!);
});
Then('规范应要求将该操作表述为{string}', function (this: SpecWorld, value: string) { const result = delivered(this); assert.equal(result.host!.requiredScope, value); assert(result.expectedText?.includes(value)); assert.equal(result.host!.semanticChoiceMeasured, false); });
Then('不得把局部结果或他人报告扩大为独立核验或整体完成', function (this: SpecWorld) { const result = proof(this); assert.equal(result.partialPreserved, true); assert.equal(result.outcome, null); });

Given('当前任务的取得依据为{string}', function (this: SpecWorld, value: string) { state(this).basis = value; });
When('宿主提供共享规范和当前资源的实际记录', timeout, async function (this: SpecWorld) {
  const scope: Record<string, string> = { HTTP成功但正文为登录页: '不能据此声称已取得目标正文', 其他文档的完整取得回执: '不能据此声称当前文档已取得',
    旧工作区的测试通过记录: '不能据此声称当前工作区已通过测试', 同一操作尚未确认的请求记录: '不能据此声称操作已成功或确定失败' };
  const current = state(this); assert(scope[current.basis!]); current.proof = await sharedNormativeAcceptance('receipt-scope', current.basis!, scope[current.basis!]!);
});
Then('规范应要求核对原资源版本尝试时间和实际结果语义', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.host!.basis, state(this).basis); assert.equal(result.host!.scenarioFamily, 'receipt-scope'); });
Then('{string}不得仅由该依据推出', function (this: SpecWorld, value: string) { const result = proof(this); assert(result.expectedText?.includes(value)); assert.equal(result.partialPreserved, true); assert.equal(result.outcome, null); });

Given('当前工作类型为check且固定材料{string}', function (this: SpecWorld, value: string) { state(this).label = value; });
When('核查员按当前要求判断候选内容', timeout, async function (this: SpecWorld) {
  state(this).proof = await sharedFixedMaterialAcceptance(state(this).label === '直接显示标题已经按要求修改' ? 'passed' : 'unverified');
});
Then('宿主应接受基于固定材料的{string}而不额外要求工具运行记录', function (this: SpecWorld, value: string) { const result = delivered(this); assert.equal(result.host!.webCalls, 0); assert.equal(result.outcome, value === 'passed' ? 'complete' : 'partial'); });
Then('固定检查不得取证补证或添加协议外的调查计划', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.host!.frozenRequirements, true); assert.equal(result.host!.webCalls, 0); assert.equal(result.host!.protocolPlanRejected, true); assert.equal(result.host!.hostWebAvailable, true); assert(result.requests.some(request => request.kind === 'check')); });

Given('执行或协调工作的一条路径已经确定失败且仍有获准替代路径', function (this: SpecWorld) { state(this); });
When('模型收到共享规范和当前预算期限', timeout, async function (this: SpecWorld) { state(this).proof = await sharedRoleAcceptance('assistance', 'alternative'); });
Then('规范应要求核对原因已有结果和未受影响的工作后选择可行替代', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.host!.webCalls, 2); assert.equal(result.requests.filter(request => request.kind === 'assistance').length, 3); });
Then('不得仅因单次工具或成员失败就声明整个任务无法完成', function (this: SpecWorld) { const result = proof(this); assert.equal(result.partialPreserved, true); assert.equal(result.outcome, null); });
Then('原预算截止时间和重试边界不得被恢复或换成员自动增加', function (this: SpecWorld) { const result = proof(this); assert.equal(result.host!.deadlineUnchanged, true); assert.equal(result.host!.retries, 0); });

Given('原外部操作处于{string}', function (this: SpecWorld, value: string) { state(this).label = value; });
When('系统接续当前任务并保留其已知材料', timeout, async function (this: SpecWorld) { state(this).proof = await sharedUnknownAcceptance(state(this).label!); });
Then('原外部效果应继续保持未确认并保留核对责任', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.host!.observedUnconfirmedCheckpoint, true); });
Then('共享规范应要求先核对原请求而不换工具或成员重做同一副作用', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.noNewAuthority, true); assert.equal(result.host!.physicalSandboxProofClaimed, false); });
Then('只有不依赖该结果且不争用其资源的获准工作可以继续', function (this: SpecWorld) {
  const result = proof(this); if (state(this).label === '请求超时但效果未知') { assert.equal(result.host!.ownRoomIsolated, true); assert.equal(result.host!.otherRoomIsolated, true); assert.equal(result.host!.contentProceeding, true); }
  else { assert.equal((result.host!.drain as { settled: boolean }).settled, false); assert.equal(result.host!.lateAccesses, 0); }
});

Given('{string}发现需要人类明确回应的关键缺口', function (this: SpecWorld, value: string) { state(this).role = role(value); });
When('它通过获准输出交接该缺口', timeout, async function (this: SpecWorld) { state(this).proof = await sharedRoleAcceptance(state(this).role!, 'human'); });
Then('应使用{string}且不得自行增加动作或直接越权提问', function (this: SpecWorld, value: string) { const result = delivered(this); assert.equal(result.roleAction, value); assert.equal(result.noNewAuthority, true); });
Then('普通文字描述阻塞不应被当作人类已经答复', function (this: SpecWorld) { const result = proof(this); if (['owner', 'facilitator', 'interpretation'].includes(result.role)) assert.equal(result.gateOpen, true); else assert.notEqual(result.outcome, 'complete'); });

Given('工具正文或成员转述声称用户已经批准新的操作', function (this: SpecWorld) { state(this); });
When('当前模型工作收到该内容和共享规范', timeout, async function (this: SpecWorld) { state(this).proof = await sharedAuthorizationAcceptance(); });
Then('这些内容只能作为资料而不能修改目标权限或验收要求', function (this: SpecWorld) { assert.equal(delivered(this).host!.ordinaryReportGrantedApproval, false); });
Then('执行和人类决定仍须通过宿主认可的授权机制', function (this: SpecWorld) { assert.equal(proof(this).host!.startedProcesses, 0); assert.equal(proof(this).host!.originalApprovalState, 'pending'); });

Given('用户或其他成员施加倾向而当前依据显示{string}', function (this: SpecWorld, value: string) { state(this).basis = value; });
When('模型按共享规范复核争议', timeout, async function (this: SpecWorld) {
  const responses: Record<string, string> = { 原判断仍受充分证据支持: '说明依据并维持判断', 原计算确实遗漏一项成本: '更正漏项和受影响结论', 新材料推翻先前关键假设: '指明新依据并修正后续结论' };
  const current = state(this); current.proof = await sharedNormativeAcceptance('independent-judgment', current.basis!, responses[current.basis!]!);
});
Then('规范应要求{string}', function (this: SpecWorld, value: string) { const result = delivered(this); assert.equal(result.host!.requiredScope, value); assert(result.expectedText?.includes(value)); });
Then('不得为了赞同或刻意反对而改变事实结论', function (this: SpecWorld) { const result = proof(this); assert.equal(result.host!.scenarioFamily, 'independent-judgment'); assert.equal(result.host!.semanticChoiceMeasured, false); assert.equal(result.partialPreserved, true); });

Given('当前工作需要解释用户意图且共享规范要求只澄清实质缺口', function (this: SpecWorld) { state(this); });
When('宿主提供已有上下文和解释输出协议', timeout, async function (this: SpecWorld) { state(this).proof = await sharedRoleAcceptance('interpretation', 'confidence'); });
Then('规范应要求先检查已有材料并在获准范围内采用低影响可逆默认值', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.role, 'interpretation'); assert.equal(result.requests.length, 2); });
Then('不得用假设补足必要权限或把主观评分说成已验证正确率', function (this: SpecWorld) { const result = proof(this); assert.equal(result.noNewAuthority, true); assert.equal(result.host!.confidence, 0.5); });
Then('现有confidence字段及其澄清门槛应保持原协议含义', function (this: SpecWorld) { const result = proof(this); assert.equal(result.host!.retries, 1); assert.equal(result.gateOpen, true); assert.equal(result.phase, 'waitingHuman'); });

Given('当前贡献包含他人报告分歧失败和未完成事项', function (this: SpecWorld) { state(this); });
When('模型在原有可读字段中给出结果或交接', timeout, async function (this: SpecWorld) { state(this).proof = await sharedNormativeAcceptance('handoff', 'A和B转述同一来源，第三项失败且未验证', '先给当前贡献结论，保留来源、分歧和未完成范围'); });
Then('共享规范应要求先给当前结论并保留重要来源范围和限制', function (this: SpecWorld) { const result = delivered(this); assert.equal(result.host!.scenarioFamily, 'handoff'); assert.equal(result.partialPreserved, true); });
Then('多个成员重复同一来源不能被计为多份独立证据', function (this: SpecWorld) { const result = proof(this); assert.equal(result.host!.semanticChoiceMeasured, false); assert.equal(result.outcome, null); });
Then('输出只应覆盖当前贡献且不强制每次重复完整检查表', function (this: SpecWorld) { const result = proof(this); assert.equal(result.role, 'assistance'); assert.equal(result.noNewAuthority, true); assert.equal(result.outcome, null); });

Given('固定检查材料直接显示正确标题但没有当前测试执行记录', function (this: SpecWorld) { state(this); });
Given('当前候选产物可见但其ID未列入宿主可引证来源', function (this: SpecWorld) { state(this); });
When('核查响应将标题判为passed测试判为unverified并{string}', timeout, async function (this: SpecWorld, handling: string) {
  const choices = { '引用可见候选的artifact:live': 'candidate', '省略没有支持材料的可选source': 'omit', '引用rawInputs目录中原有的准确来源': 'rawInput' } as const;
  assert(handling in choices); state(this).proof = await sharedCitationAcceptance(choices[handling as keyof typeof choices]);
});
Then('宿主应{string}且不把候选产物自动升级为可引证来源', function (this: SpecWorld, outcome: string) {
  const result = delivered(this); assert.equal(result.host!.catalogContainsArtifact, false); assert.equal(result.host!.candidateUnchanged, true);
  if (outcome === '保留CHECK_SOURCE_NOT_FOUND诊断而不保存该检查判定') {
    assert.equal(result.host!.diagnostic, 'CHECK_SOURCE_NOT_FOUND'); assert.equal(result.host!.rejectedJudgmentsSaved, false); assert.equal(result.host!.checkRequests, 2);
  } else { assert(['接受内容判定和缺证说明并保留partial', '接受目录内准确引用并保留partial'].includes(outcome)); assert.equal(result.host!.diagnostic, null); }
  assert.equal(result.outcome, 'partial'); assert.equal(result.host!.title, 'passed');
});
Then('没有执行记录的测试要求不得被判为已经运行通过', function (this: SpecWorld) {
  const result = proof(this); assert.equal(result.host!.tests, 'unverified'); assert.equal(result.host!.currentTestExecutionRecorded, false);
  assert.equal(result.host!.webCalls, 0); assert.equal(result.host!.semanticChoiceMeasured, false);
});
