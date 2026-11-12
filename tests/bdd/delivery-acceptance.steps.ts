import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import { currentDeliveryIssues, deliveryJudgments, type CriterionJudgment } from '../../src/delivery-acceptance.js';
import { OpenAICompatibleAdapter, WorkRunner, type Intent } from '../../src/index.js';
import { candidateJudgments, configuration, Harness, saveEvidence, type EventBody } from '../helpers.js';
import { regenerationConfig, modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

type Delivery = Extract<EventBody, { type: 'DELIVER' }>;
type Test = { repeated?: EventBody; delivery?: Delivery; oldCheck?: Intent; criterionId?: string; sourceId?: string; requests?: number };
const tests = new WeakMap<SpecWorld, Test>();
function test(world: SpecWorld) {
  const previous = tests.get(world);
  if (previous) return previous;
  const current: Test = {};
  tests.set(world, current);
  return current;
}
const pending = (world: SpecWorld) => world.h.engine.pending(world.h.room, world.h.task).map(work => work.kind);
const text = '候选已有可用内容';
const judgments = (world: SpecWorld) => {
  const context = world.h.context();
  return deliveryJudgments(context, context.candidate?.revision);
};

function ownerDelivery(world: SpecWorld, work = world.h.claim('owner'), changes: Partial<Delivery> = {}): Delivery {
  return { type: 'DELIVER', text, artifactIds: [], workId: work.id, fence: work, attempt: work.attempt, ...changes };
}

function submit(world: SpecWorld, changes: Partial<Delivery> = {}, work?: Intent) {
  const delivery = ownerDelivery(world, work, changes);
  assert(world.h.event(delivery).ok);
  return delivery;
}

function finding(world: SpecWorld, status: 'failed' | 'unverified', reason: string, index = 0) {
  return candidateJudgments(world.h.context().candidate, { index, status, reason });
}

function report(world: SpecWorld, results: CriterionJudgment[]) {
  const work = world.h.authorizeCheck();
  assert(world.h.checkResult(work, results).ok);
  return work;
}

async function runCheck(world: SpecWorld, reply: (body: string) => unknown) {
  const { h } = world;
  const adapter = new OpenAICompatibleAdapter(h.config, { clock: () => h.now,
    transport: async (_url, request) => modelResponse(reply(String(request?.body))) });
  assert(await new WorkRunner(h.engine, adapter, () => h.now).runOne(h.room, h.task));
}

function assertUnpublished(world: SpecWorld) {
  assert.notEqual(world.h.context().outcome, 'complete');
  assert.equal(world.h.context().publishedDelivery, undefined);
}

Given('任务有必需验收项且负责人提交的候选{string}', function (this: SpecWorld, problem: string) {
  this.h = new Harness();
  const oldId = 'old-file';
  if (problem.includes('旧目标')) {
    assert(this.h.event({ type: 'ARTIFACT', artifact: { id: oldId, name: '原稿.md', content: '旧目标成果' } }).ok);
    assert(this.h.event({ type: 'USER_INPUT', text: '修改交付目标', goal: { ...this.h.context().goal, text: '新目标' } }).ok);
  }
  test(this).delivery = ownerDelivery(this, this.h.claim('owner'), {
    id: 'structured-delivery', artifactIds: [problem.includes('旧目标') ? oldId : 'missing-file'],
  });
});
When('系统处理候选并收到相同提交的重复通知', function (this: SpecWorld) {
  const delivery = test(this).delivery!;
  assert(this.h.event(delivery).ok);
  this.h.event(delivery);
});
Then('应记录当前候选的具体缺口', function (this: SpecWorld) {
  const context = this.h.context();
  assert(context.candidate!.text.includes('引用的文件不存在或不属于当前目标'));
});
Then('应保留已有成果并直接交给下游而不安排负责人补交', function (this: SpecWorld) {
  assert(this.h.context().candidate!.text.startsWith(text));
  assert.deepEqual(pending(this), ['check']);
  assert.equal(this.h.context().deliveryCycle?.revisionUsed,false);
});
Then('下游应收到缺少实际文件的说明且不生成虚假文件链接', function (this: SpecWorld) {
  assert.equal(this.h.context().usage.checks, 0);
  assert.deepEqual(pending(this), ['check']);
});

Given('当前候选通过机械门禁并已进入独立检查', function (this: SpecWorld) {
  this.h = new Harness(regenerationConfig({ retries: 0 }));
  submit(this);
});
When('检查员返回{string}', async function (this: SpecWorld, problem: string) {
  const results = finding(this, problem.includes('无法') ? 'unverified' : 'failed', problem);
  test(this).criterionId = results[0]!.criterionId; this.problem=problem;
  await runCheck(this, body => {
    assert(body.includes(test(this).criterionId!));
    return { type: 'check', criteriaResults: problem.includes('遗漏') ? results.slice(1) : results };
  });
});
Then('合法内容结论应声明缺口交付而无效协议应明确结束',function(this:SpecWorld){if(this.problem.includes('遗漏'))assertUnpublished(this);else {assert.equal(this.h.context().outcome,'complete');assert(this.h.context().candidate!.text.includes(this.problem));}});
Then('用户应能看到尚未验收的要求和关联候选版本', function (this: SpecWorld) {
  const context = this.h.context();
  assert(context.candidate?.acceptance?.criteria.some(criterion => criterion.id === test(this).criterionId));
  assert(currentDeliveryIssues(context).some(issue => issue.candidateRevision === context.candidate?.revision && issue.reason));
});

Given('已检查的候选发现一项内容错误且其他必需验收项曾通过', function (this: SpecWorld) {
  this.h = new Harness(configuration({ checks: 2 }));
  submit(this, { text: '第一项工作已完成，其他要求均已提供' });
  const results = finding(this, 'failed', '第一段把计划写成已完成');
  test(this).criterionId = results[1]!.criterionId;
});
When('负责人修复该错误但新候选遗漏了另一项原有要求', function (this: SpecWorld) {
  report(this, finding(this, 'failed', '修订遗漏此前通过的一项要求', 1));
});
Then('该要求仍应保留在验收清单中', function (this: SpecWorld) {
  assert(this.h.context().candidate?.acceptance?.criteria.some(criterion => criterion.id === test(this).criterionId));
});
Then('复核应指出该遗漏并以部分完成或失败结束', function (this: SpecWorld) {
  const context = this.h.context();
  assert.equal(context.outcome, 'complete');
  assert(judgments(this).some(result => result.criterionId === test(this).criterionId && result.status === 'failed'));
});
Then('不得再自动安排修订或发布新候选', function (this: SpecWorld) {
  assert.deepEqual(pending(this), []);
  assert(this.h.context().publishedDelivery);
});

Given('负责人已补齐机械门禁指出的缺失产物', function (this: SpecWorld) {
  this.h = new Harness(configuration({ checks: 1 }));
  submit(this, { artifacts: [{ name: '已补交.md', content: '可查看的文件' }] });
});
When('独立检查发现一项有依据的内容错误', function (this: SpecWorld) {
  report(this, finding(this, 'failed', '报告把计划写成完成'));
});
Then('应保留已有成果和该内容错误并明确结束', function (this: SpecWorld) {
  assert.equal(this.h.view().phase, 'ended');
  assert.equal(this.h.context().outcome, 'complete');
  assert(this.h.context().candidate?.artifactIds.length);
  assert.equal(judgments(this)[0]?.reason, '报告把计划写成完成');
});
Then('不得再自动修订或发布', function (this: SpecWorld) {
  assert.deepEqual(pending(this), []);
  assert(this.h.context().publishedDelivery);
});

Given('独立检查已使用本轮最后一次检查请求额度并发现内容错误', function (this: SpecWorld) {
  this.h = new Harness(configuration({ checks: 1 }));
  submit(this);
  test(this).oldCheck = this.h.authorizeCheck();
});
When('系统处理检查结果', function (this: SpecWorld) {
  assert(this.h.checkResult(test(this).oldCheck!, finding(this, 'failed', '缺少必要依据')).ok);
});
Then('应保存已有成果和缺口并明确结束', function (this: SpecWorld) {
  assert.equal(this.h.context().outcome, 'complete');
  assert(this.h.context().candidate!.text.startsWith(text));
  assert.equal(judgments(this)[0]?.reason, '缺少必要依据');
});
Then('不得再安排作者修订或额外检查请求', function (this: SpecWorld) {
  assert.equal(this.h.context().usage.checks, 1);
  assert.deepEqual(pending(this), []);
});

Given('当前候选相关的完整证据超过模型输入容量', function (this: SpecWorld) {
  const config = regenerationConfig();
  config.models!.services.test!.contextWindowTokens = 8192;
  config.models!.services.test!.maxTokens = 1024;
  this.h = new Harness(config);
  const work = this.h.claim('owner');
  test(this).sourceId = saveEvidence(this.h, work, '需完整核实的原始资料'.repeat(800));
  submit(this, {}, work);
});
When('系统准备独立检查', async function (this: SpecWorld) {
  test(this).requests = 0;
  await runCheck(this, () => {
    test(this).requests!++;
    return { type: 'check', criteriaResults: candidateJudgments(this.h.context().candidate) };
  });
});
Then('应标明未能覆盖的材料并以部分完成或失败结束', function (this: SpecWorld) {
  assert.equal(this.h.context().outcome, 'partial');
  assert.match(this.h.context().reason, /超[出过]|容量|CONTEXT|EVIDENCE/);
});
Then('不得静默截断材料或安排作者重写', function (this: SpecWorld) {
  assert.equal(test(this).requests, 0);
  assert.deepEqual(pending(this), []);
  assertUnpublished(this);
});

Given('当前交付周期已授权一次检查技术补试及一次作者修订',function(this:SpecWorld){
 this.h=new Harness();submit(this);const first=this.h.authorizeCheck();assert(this.h.event({type:'WORK_FAILED',intentId:first.id,attempt:first.attempt,fence:first,reason:'瞬态网络故障',transient:true}).ok);
 const check=this.h.authorizeCheck();test(this).oldCheck=check;
 const event={type:'CHECK_RESULT' as const,id:'direct-repair',workId:check.id,fence:check,attempt:check.attempt,resultId:'direct-repair',candidateRevision:this.h.context().candidate!.revision!,criteriaResults:candidateJudgments(this.h.context().candidate),repair:{text:'检查员直接纠正报告内容',artifacts:[]}};
 test(this).repeated=event;assert(this.h.event(event).ok);
});
When('服务重启且重复收到候选提交通知',function(this:SpecWorld){this.h.reopen();this.h.event(test(this).repeated!);});
Then('应保留已使用的修订和技术补试次数',function(this:SpecWorld){assert.equal(this.h.context().deliveryCycle?.revisionUsed,false);assert.equal(this.h.context().deliveryCycle?.retry?.status,'used');assert.deepEqual(pending(this),[]);});
Then('不得重复扣费或发布旧结果对应的新候选',function(this:SpecWorld){assert.equal(this.h.context().usage.checks,2);assert.equal(this.h.context().usage.retries,1);assert.equal(this.h.context().outcome,'complete');assert(this.h.context().candidate!.text.includes('检查员直接纠正'));});

Given('候选声称已取得必需资料但只有{string}', function (this: SpecWorld, evidence: string) {
  this.h = new Harness(regenerationConfig());
  const original = this.h.claim('owner');
  const old = evidence.includes('旧目标');
  test(this).sourceId = saveEvidence(this.h, original, '不可用于验收的采集正文', old);
  if (old) {
    assert(this.h.event({ type: 'USER_INPUT', text: '切换资料目标', goal: { ...this.h.context().goal, text: '读取新资料' } }).ok);
    assert(this.h.event({ type: 'SETTLE', intentId: original.id }).ok);
  }
  submit(this, { text: '声称已取得当前目标所需的资料' }, old ? undefined : original);
});
When('独立检查核实资料的出处', async function (this: SpecWorld) {
  await runCheck(this, body => {
    const projected = JSON.parse(JSON.parse(body).messages[1].content).context.evidence as { id: string; stdout?: string }[];
    assert(!projected.some(source => source.id === test(this).sourceId && source.stdout));
    assert(!body.includes('不可用于验收的采集正文'));
    return { type: 'check', criteriaResults: finding(this, 'unverified', '没有证明当前资料取得成功的回执') };
  });
});
Then('应明确记录该项无法核实并保留已有成果', function (this: SpecWorld) {
  const context = this.h.context();
  assert.equal(context.outcome, 'complete');
  assert.equal(judgments(this)[0]?.status, 'unverified');
  assert(context.candidate!.text.startsWith('声称已取得当前目标所需的资料'));
});
Then('不得发布候选或安排作者重复改稿', function (this: SpecWorld) {
  assert(this.h.context().publishedDelivery);
  assert.deepEqual(pending(this), []);
});

Given('本周期总检查额度只有两次', function (this: SpecWorld) { assert.equal(this.h.context().config.limits.checks, 2); });
Given('本周期总检查额度只有一次', function (this: SpecWorld) { assert.equal(this.h.context().config.limits.checks, 1); });
