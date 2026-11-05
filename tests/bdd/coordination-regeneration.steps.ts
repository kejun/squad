import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { CoordinationFixture, CoordinationWebFixture, assertRepairWait, assistDecision, decisionOutput, realHumanQuestion } from '../coordination-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

interface CoordinationState {
  fixture?: CoordinationFixture; web?: CoordinationWebFixture;
  phase?: string; action?: string; target?: string; result?: { ok: boolean; code?: string };
  reason?: string; messages?: ReturnType<CoordinationFixture['h']['context']>['messages'];
}
const states = new WeakMap<SpecWorld, CoordinationState>();
const state = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };
const fixture = (world: SpecWorld) => { const value = state(world).fixture; assert(value); return value; };
function setup(world: SpecWorld, owner = 'A', limits = {}, sqlite = false) {
  const value = new CoordinationFixture(owner, limits, sqlite); states.set(world, { fixture: value }); return value;
}
After(async function (this: SpecWorld) {
  const value = states.get(this); if (!value) return;
  await value.web?.close(); value.fixture?.close(); states.delete(this);
});

Given('当前负责人为{string}且协调员先向{string}请求协助', function (this: SpecWorld, owner: string, wrongTarget: string) {
  setup(this, owner).repair.replies = [decisionOutput(assistDecision(wrongTarget))];
});
When('协调员重新生成{string}并指定{string}', async function (this: SpecWorld, action: string, target: string) {
  const f = fixture(this), s = state(this); s.action = action; s.target = target;
  f.repair.replies.push(decisionOutput(action === 'continue' ? { action: 'continue', reason: '继续当前目标' } : assistDecision(target)));
  await f.run();
});
Then('应只应用修正后的协调决策且不因首次无效对象等待人工', function (this: SpecWorld) {
  const f = fixture(this), s = state(this);
  assert.equal(f.h.view().phase, s.action === 'continue' ? 'running' : 'waitingAssistance');
  assert.equal(f.context.trace.filter(trace => trace.event === 'COORDINATION_DECISION').length, 1);
  assert.deepEqual(f.context.assists.map(assist => assist.target), s.action === 'assist' ? [s.target] : []);
  assert.deepEqual(f.requestContexts.map(context => context.owner), [f.owner, f.owner]);
  const feedback = f.requests[1]!.messages.at(-1)!.content;
  assert(feedback.includes('invalid_decision')); assert(feedback.includes('context.owner')); assert(/configured/iu.test(feedback));
});
Then('应消耗一次重试和两次普通模型请求额度', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.requests.length, 2); assert.equal(f.repairs.length, 1);
  assert.equal(f.context.usage.retries, 1); assert.equal(f.context.usage.ordinary, 2);
});

Given('当前负责人已由默认成员A交接给B', function (this: SpecWorld) {
  const f = setup(this, 'B'); assert.equal(f.context.owner, 'B'); assert.equal(f.h.config.defaultBot, 'A');
});
When('协调员直接安排A协助B', async function (this: SpecWorld) {
  const f = fixture(this); f.repair.fallback = decisionOutput(assistDecision('A')); await f.run();
});
Then('应正常等待A协助且不消耗格式修正次数', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.h.view().phase, 'waitingAssistance'); assert.equal(f.context.assists[0]!.target, 'A');
  assert.equal(f.requests.length, 1); assert.equal(f.repairs.length, 0); assert.equal(f.context.usage.retries, 0);
});

Given('协调员持续向当前负责人本人求助且{string}不足以继续修正', function (this: SpecWorld, budget: string) {
  setup(this, 'A', budget === '重试额度' ? { retries: 0 } : { ordinary: 1 }).continueInvalid();
});
When('执行这次协调模型工作', async function (this: SpecWorld) { await fixture(this).run(); });
Then('应等待人工并以中文说明自动修正未完成和可采取的操作', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.h.view().phase, 'waitingHuman'); assertRepairWait(f.context.reason);
  assert(f.context.messages.some(message => message.author === 'facilitator' && message.kind === 'notice' && message.text.includes('修正')));
});
Then('不得产生无效协助或额度外模型请求', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.requests.length, 1); assert.deepEqual(f.context.assists, []);
  assert.equal(f.repairs.length, 0); assert.equal(f.context.usage.ordinary, 1); assert.equal(f.context.usage.retries, 0);
});

Given('当前正在等待协调员的决策', function (this: SpecWorld) { setup(this).claim(); });
When('绕过模型适配器提交向负责人本人求助的当前协调决策', function (this: SpecWorld) { state(this).result = fixture(this).sendSelfDecision(); });
Then('应拒绝自我求助并保存中文等待原因和群消息', function (this: SpecWorld) {
  const s = state(this), f = fixture(this);
  assert.equal(s.result!.ok, false); assert.equal(s.result!.code, 'SELF_DEPENDENCY'); assert.equal(f.h.view().phase, 'waitingHuman');
  assert(/[\u4e00-\u9fff]/u.test(f.context.reason));
  assert(f.context.messages.some(message => message.kind === 'notice' && /负责人|本人/u.test(message.text)));
  s.reason = f.context.reason; s.messages = f.context.messages;
});
When('后续合法活动更新最近命令回执', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.h.event({ type: 'ACTIVITY', text: '保留等待诊断' }).code, 'OK'); assert.equal(f.context.reply.code, 'OK');
});
Then('原等待原因和问题消息仍应保留', function (this: SpecWorld) {
  const s = state(this), f = fixture(this); assert.equal(f.context.reason, s.reason); assert.deepEqual(f.context.messages, s.messages);
});

Given('任务已经向用户提出一个真实问题', function (this: SpecWorld) {
  const f = setup(this), work = f.claim();
  assert(f.h.event({ type: 'COORDINATE', workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion },
    decision: { action: 'askUser', question: realHumanQuestion, reason: '必须确认环境' } }).ok);
  state(this).messages = f.context.messages;
});
When('收到{string}的自我求助协调决策', function (this: SpecWorld, stale: string) { fixture(this).sendSelfDecision(stale === '旧目标版本'); });
Then('当前人工问题和原消息应保持不变', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.h.view().phase, 'waitingHuman'); assert.equal(f.context.reason, realHumanQuestion);
  assert.deepEqual(f.context.messages, state(this).messages);
});

Given('一个{string}的旧协调意图没有保存负责人且当前负责人为B', async function (this: SpecWorld, previous: string) {
  await setup(this, 'B', {}, true).prepareLegacyWork(previous === '重启恢复');
});
When('经真实领取事务执行该协调工作', async function (this: SpecWorld) { await fixture(this).run(); });
Then('模型请求前应已持久保存负责人B且允许向A求助', function (this: SpecWorld) {
  const f = fixture(this); assert.equal(f.requests.length, 1); assert.equal(f.requestContexts[0]!.owner, 'B');
  assert.equal(f.work.payload.owner, 'B'); assert.equal(f.h.view().phase, 'waitingAssistance'); assert.equal(f.context.assists[0]!.target, 'A');
  assert.equal(f.context.usage.retries, 0);
});

Given('网页中的协调员持续返回向负责人本人求助的决策', async function (this: SpecWorld) { states.set(this, { web: await CoordinationWebFixture.create() }); });
When('自动修正额度耗尽后读取群聊', async function (this: SpecWorld) { await state(this).web!.run(); });
Then('群聊应显示中文失败原因和下一步操作且保留修正记录', function (this: SpecWorld) {
  const web = state(this).web!, snapshot = web.snapshot;
  assert.equal(snapshot.tasks[0]!.phase, 'waitingHuman'); assertRepairWait(snapshot.tasks[0]!.reason);
  assert.equal(web.requests.length, 4);
  assert(snapshot.messages.some(message => message.author === 'facilitator' && /修正/u.test(message.text) && /请/u.test(message.text)));
  assert.equal(snapshot.events.filter(event => event.title === '模型输出格式不合规，重新生成').length, 2);
  assert.equal(web.service.engine.view(web.room, web.task)!.context.usage.retries, 2);
});
