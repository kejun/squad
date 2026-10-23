import assert from 'node:assert/strict';
import { Before, Given, When, Then, setWorldConstructor, World, type DataTable } from '@cucumber/cucumber';
import { Harness, configuration } from '../helpers.js';
import { MemoryStore, TeamEngine, WorkRunner, WorkFailure, type Intent, type TaskEvent, type WorkAdapter } from '../../src/index.js';

export class SpecWorld extends World {
  h = new Harness(); result: { ok: boolean; code?: string } = { ok: true };
  problem = ''; received: Intent | undefined; prepared = ''; oldWork: Intent | undefined;
  frame = { epoch: 1, goalVersion: 1 }; question = '核对恢复能力的范围';
  reviewCalls: Intent[] = []; reviewPath = ''; extraReviewRequests = 0; reviewAttempts = 0;
  reviewAdapter(): WorkAdapter {
    return { execute: async (work, _signal, scope) => {
      this.reviewCalls.push(work);
      if (work.kind === 'facilitator') return { type: 'decision', decision: { action: 'review', question: '评审方案的风险与改进项', expected: '具体意见', reason: '用户请求成员评审' } };
      if (work.kind === 'assistance') {
        this.reviewAttempts++;
        if (this.reviewPath === '瞬态故障重试' && this.reviewAttempts === 1) throw new WorkFailure('评审服务暂时不可用', true);
        if (this.reviewPath === '额外模型请求') scope.authorizeAdditionalRequest('extra-review-model');
        if (this.reviewPath === '技能搜索') await scope.findSkills('proposal review');
        this.extraReviewRequests++;
        return { type: 'answer', text: '建议补充离线恢复验证。' };
      }
      if (work.kind === 'check') return { type: 'check', passed: true, gaps: [] };
      assert.equal(work.kind, 'owner');
      return { type: 'deliver', text: '已汇总收到的意见，并列出尚未完成的成员评审。', artifactIds: [] };
    } };
  }
  async drainReview() {
    const runner = new WorkRunner(this.h.engine, this.reviewAdapter(), () => this.h.now, async () => {
      this.extraReviewRequests++;
      return new Response(JSON.stringify({ skills: [] }));
    });
    for (let n = 0; n < 30; n++) if (!(await runner.runOne(this.h.room, this.h.task))) return;
    assert.fail('成员评审未在有限步骤内结算');
  }
  ask(id = 'H1') {
    return this.h.event({ type: 'HELP', requestId: id, caller: 'A', target: this.problem === '目标成员不存在' ? 'missing' : this.problem === '向自己求助' ? 'A' : 'B', question: this.question, expected: '官方依据与限制', requiredTools: ['read'] });
  }
  record(answer = 'official evidence', status: 'success' | 'partial' | 'failed' | 'timeout' = 'success') {
    const work = this.received;
    this.result = this.h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'R1', answer, status,
      ...(work ? { workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } } : {}) });
    this.h.engine.flushResults(this.h.room, this.h.task);
  }
  prepare(operation: string) {
    this.prepared = operation;
    if (operation === '协助派发') { this.ask(); this.oldWork = this.h.engine.pending(this.h.room, this.h.task)[0]; }
    if (operation === '结果回传推进') { this.ask(); this.h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'R1', status: 'success', answer: 'evidence' }); }
    if (operation === '最终结果发布') { this.h.event({ type: 'DELIVER', text: 'candidate', artifactIds: [] }); this.oldWork = this.h.claim('check'); }
  }
}
setWorldConstructor(SpecWorld);
Before(function (this: SpecWorld) { this.h = new Harness(); });

Given('主任务{string}由成员{string}负责且状态为{string}', function (this: SpecWorld, _task: string, owner: string, phase: string) { assert.equal(this.h.context().owner, owner); assert.equal(phase, '执行中'); });
Given('成员{string}具备执行所请求核查的权限', function (this: SpecWorld, id: string) { assert(this.h.config.bots.find(b => b.id === id)?.tools.includes('read')); });
Given('当前目标版本为{string}，执行轮次为{string}', function (this: SpecWorld, goal: string, epoch: string) { assert.equal(goal, 'G1'); assert.equal(epoch, 'E1'); });
Given('求助和执行预算足够', function (this: SpecWorld) { assert(this.h.context().config.limits.assists > 0); });
When('{string}通过 ask_bot 提交请求{string}', function (this: SpecWorld, _bot: string, id: string, table: DataTable) {
  const data = table.rowsHash(); this.question = data['问题']!;
  this.result = this.h.event({ type: 'HELP', requestId: id, caller: 'A', target: data['对象']!, question: this.question, expected: data['所需结果']!, refs: [data['材料引用']!] });
  this.received = this.h.claim('assistance');
});
Then('群内应显示一条{string}向{string}提出的求助', function (this: SpecWorld, author: string, target: string) { const m = this.h.context().messages.filter(m => m.kind === 'help'); assert.equal(m.length, 1); assert.equal(m[0]!.author, author); assert.equal(m[0]!.recipient, target); });
Then('{string}应进入{string}并关联{string}', function (this: SpecWorld, _task: string, state: string, id: string) { assert.equal(state, '等待协助'); assert.equal(this.h.view().phase, 'waitingAssistance'); assert(this.h.context().reason.includes(id)); });
Then('{string}应收到具体问题、所需结果与必要上下文', function (this: SpecWorld, bot: string) { assert.equal(this.received?.target, bot); assert.equal(this.received?.payload.question, this.question); assert(this.received?.payload.expected); assert(this.received?.payload.goal); });
Then('不应为批准本次明确求助额外调用促进者模型', function (this: SpecWorld) { assert(!this.h.context().intents.some(i => i.kind === 'facilitator')); });
Given('请求{string}已派发给{string}', function (this: SpecWorld, id: string, bot: string) { assert(this.ask(id).ok); this.received = this.h.claim('assistance'); assert.equal(this.received.target, bot); });
When('{string}仍在允许期限内执行', function (this: SpecWorld, _ignored0: string) { this.h.now = 10; this.h.engine.tick(this.h.room); });
Then('{string}不应发起新的模型调用', function (this: SpecWorld, bot: string) { assert(!this.h.engine.pending(this.h.room, this.h.task).some(i => i.target === bot)); });
Then('状态行应显示{string}', function (this: SpecWorld, text: string) { assert.equal(text, 'A 等待 B'); assert.equal(this.h.view().phase, 'waitingAssistance'); assert.equal(this.h.context().assists[0]!.target, 'B'); });
Given('{string}正在等待请求{string}', function (this: SpecWorld, _bot: string, id: string) { this.ask(id); this.received = this.h.claim('assistance'); });
When('{string}提交关联{string}的核查结果{string}', function (this: SpecWorld, _bot: string, request: string, id: string) { assert.equal(request, 'H1'); assert.equal(id, 'R1'); this.record(); });
Then('群内应显示署名{string}的答复', function (this: SpecWorld, bot: string) { assert(this.h.context().messages.some(m => m.kind === 'answer' && m.author === bot)); });
Then('{string}应在原任务{string}中收到一次{string}', function (this: SpecWorld, bot: string, _task: string, id: string) { const input = this.h.engine.pending(this.h.room, this.h.task); assert.equal(input.length, 1); assert.equal(input[0]!.target, bot); assert.equal(input[0]!.payload.resultId, id); });
Then('{string}应按当前目标判断原缺口是否解决', function (this: SpecWorld, _ignored0: string) { assert.equal(this.h.engine.pending(this.h.room, this.h.task)[0]!.payload.requiresAssessment, true); });
Then('不应仅因收到答复就把主任务标记为完成', function (this: SpecWorld) { assert.equal(this.h.context().outcome, null); });
When('协助以{string}结束并说明{string}', function (this: SpecWorld, status: string, reason: string) { const map = { '部分完成': 'partial', '失败': 'failed', '超时': 'timeout' } as const; this.record(reason, map[status as keyof typeof map]); });
Then('{string}应结算为{string}', function (this: SpecWorld, id: string, status: string) { const map = { '部分完成': 'partial', '失败': 'failed', '超时': 'timeout' } as const; assert.equal(this.h.context().assists.find(a => a.id === id)?.status, map[status as keyof typeof map]); });
Then('{string}应收到该结果及原因', function (this: SpecWorld, _ignored0: string) { const p = this.h.engine.pending(this.h.room, this.h.task)[0]!.payload; assert(p.status); assert(p.answer); });
Then('{string}不应继续无限等待{string}', function (this: SpecWorld, _ignored0: string, _ignored1: string) { assert.equal(this.h.view().phase, 'running'); });
Given('本次求助存在{string}', function (this: SpecWorld, issue: string) {
  this.problem = issue; const config = configuration();
  if (issue === '目标成员权限不足') config.bots[1]!.tools = [];
  if (issue === '求助预算已耗尽') config.limits.assists = 0;
  this.h = new Harness(config);
});
When('{string}提交该求助', function (this: SpecWorld, _ignored0: string) { this.result = this.ask(); });
Then('不应启动目标成员', function (this: SpecWorld) { assert.equal(this.h.context().assists.length, 0); });
Then('执行记录应说明{string}', function (this: SpecWorld, issue: string) {
  const map: Record<string, string> = { '目标成员不存在': 'UNKNOWN_BOT', '目标成员权限不足': 'TOOL_PERMISSION', '求助预算已耗尽': 'ASSISTANCE_LIMIT', '向自己求助': 'SELF_DEPENDENCY' };
  assert.equal(this.result.code, map[issue]);
});
Then('{string}应获得明确的拒绝结果而不留下无效等待', function (this: SpecWorld, _ignored0: string) { assert.equal(this.result.ok, false); assert.equal(this.h.view().phase, 'running'); });
Given('{string}正在执行{string}', function (this: SpecWorld, _bot: string, id: string) { this.ask(id); this.received = this.h.claim('assistance'); });
When('{string}尝试继续求助第三位成员', function (this: SpecWorld, _ignored0: string) { this.result = this.h.event({ type: 'HELP', requestId: 'H2', caller: 'B', target: 'A', question: 'help', expected: 'answer' }); });
Then('应拒绝创建第二层协助', function (this: SpecWorld) { assert.equal(this.result.ok, false); assert.equal(this.h.context().assists.length, 1); });
Then('应允许{string}将未解决的缺口返回{string}', function (this: SpecWorld, _ignored0: string, _ignored1: string) { this.record('still missing evidence', 'partial'); assert.equal(this.h.view().phase, 'running'); });
Given('请求{string}已经启动且尚未结算', function (this: SpecWorld, id: string) { this.ask(id); this.received = this.h.claim('assistance'); });
When('{string}尝试启动另一项协助{string}', function (this: SpecWorld, _bot: string, id: string) { this.result = this.ask(id); });
Then('不应同时启动{string}', function (this: SpecWorld, id: string) { assert(!this.h.context().assists.some(a => a.id === id)); });
Then('应明确说明需要先结算{string}', function (this: SpecWorld, id: string) { assert.equal(this.result.ok, false); assert(this.h.context().reason.includes(id)); });
Given('促进者已决定为无法继续发言的{string}安排{string}核查', function (this: SpecWorld, _ignored0: string, _ignored1: string) { this.h.event({ type: 'BLOCKED', reason: 'need source' }); });
When('执行层落实该协助', function (this: SpecWorld) { this.h.event({ type: 'COORDINATE', decision: { action: 'assist', target: 'B', question: 'verify source', expected: 'proof', reason: 'capability match' } }); });
Then('群消息作者应为{string}', function (this: SpecWorld, author: string) { assert.equal(author, '协作提示'); assert.equal(this.h.context().messages.at(-1)!.author, 'facilitator'); });
Then('消息应说明这是为{string}安排的协助', function (this: SpecWorld, bot: string) { assert(this.h.context().messages.at(-1)!.text.includes(`为 ${bot} 安排`)); });
Then('不应伪造成{string}主动发言', function (this: SpecWorld, bot: string) { assert.notEqual(this.h.context().messages.at(-1)!.author, bot); });
Given('本次求助的持久保存会失败', function (this: SpecWorld) { (this.h.store as MemoryStore).failNextCommit = true; });
When('{string}提交请求{string}', function (this: SpecWorld, _bot: string, id: string) { try { this.result = this.ask(id); } catch { this.result = { ok: false, code: 'STORAGE_FAULT' }; } });
Then('不应启动{string}', function (this: SpecWorld, bot: string) { assert(!this.h.context().intents.some(i => i.target === bot && i.status === 'inflight')); });
Then('群内不应显示该求助已经提交成功', function (this: SpecWorld) { assert.equal(this.h.context().messages.filter(m => m.kind === 'help').length, 0); });
Then('应显示保存故障并停止新增工作', function (this: SpecWorld) { assert.equal(this.result.code, 'STORAGE_FAULT'); assert.throws(() => this.h.engine.submit('r2', { id: 'new', text: 'new' }), /Storage fault/); });

Given('任务{string}由{string}负责，目标版本为{string}，执行轮次为{string}', function (this: SpecWorld, _task: string, owner: string, _g: string, _e: string) { assert.equal(this.h.context().owner, owner); });
Given('{string}仍未结束', function (this: SpecWorld, _ignored0: string) { assert.equal(this.h.context().outcome, null); });
Given('当前活动位置为{string}', function (this: SpecWorld, place: string) {
  if (place === '负责人模型调用中') this.oldWork = this.h.claim('owner');
  if (place === '协助者工具执行中') { this.ask(); this.oldWork = this.h.claim('assistance'); }
  if (place === '促进者判断中') { this.h.event({ type: 'BLOCKED', reason: 'check' }); this.oldWork = this.h.claim('facilitator'); }
  if (place === '结果等待回传') { this.ask(); this.h.event({ type: 'RECORD_RESULT', requestId: 'H1', resultId: 'R1', status: 'success', answer: 'proof' }); }
  if (place === '准备发布最终答案') { this.h.event({ type: 'DELIVER', text: 'candidate', artifactIds: [] }); this.oldWork = this.h.claim('check'); }
});
When('用户点击停止且停止意图已经保存', function (this: SpecWorld) { assert(this.h.event({ type: 'STOP' }).ok); });
Then('不应再为{string}派发新操作', function (this: SpecWorld, _ignored0: string) { assert(this.h.engine.pending(this.h.room, this.h.task).every(i => i.kind === 'cancel')); });
Then('应向全部在途成员、协助和促进者请求取消', function (this: SpecWorld) { for (const i of this.h.context().intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel')) assert(this.h.context().intents.some(c => c.kind === 'cancel' && c.payload.intentId === i.id)); });
Then('未执行的派发与回传推进应被抑制', function (this: SpecWorld) { this.h.engine.flushResults(this.h.room, this.h.task); assert(this.h.engine.pending(this.h.room, this.h.task).every(i => i.kind === 'cancel')); assert.equal(this.h.context().messages.filter(m => m.kind === 'final').length, 0); });
Given('{string}已经停止', function (this: SpecWorld, _ignored0: string) { this.ask(); this.h.event({ type: 'STOP' }); });
Given('用户明确继续{string}并开始轮次{string}', function (this: SpecWorld, _ignored0: string, _ignored1: string) { assert(this.h.event({ type: 'CONTINUE' }).ok); assert.equal(this.h.context().epoch, 2); });
When('{string}的协助结果迟到', function (this: SpecWorld, _ignored0: string) { this.result = this.h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'late', status: 'success', answer: 'late', fence: this.frame }); });
Then('结果应仅关联到{string}的历史记录', function (this: SpecWorld, _ignored0: string) { assert.equal(this.h.context().lateResults.at(-1)?.fence?.epoch, 1); });
Then('不应推进{string}或覆盖其当前结论', function (this: SpecWorld, _ignored0: string) { assert.equal(this.result.ok, false); assert.equal(this.h.context().epoch, 2); assert.equal(this.h.context().outcome, null); });
Given('针对{string}的完成检查已经通过但最终结果尚未发布', function (this: SpecWorld, _ignored0: string) { this.h.event({ type: 'DELIVER', text: 'old candidate', artifactIds: [] }); this.oldWork = this.h.claim('check'); });
When('用户的新硬约束先保存为{string}', function (this: SpecWorld, _ignored0: string) { this.h.event({ type: 'USER_INPUT', text: 'new constraint', goal: { ...this.h.context().goal, constraints: ['G2 constraint'] } }); });
When('旧发布操作随后尝试提交', function (this: SpecWorld) { this.result = this.h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'oldCheck', workId: this.oldWork!.id, fence: this.frame }); });
Then('应拒绝按{string}直接发布为当前最终答案', function (this: SpecWorld, _ignored0: string) { assert.equal(this.result.ok, false); assert(!this.h.context().messages.some(m => m.kind === 'final')); });
Then('应重新检查结果对{string}的适用性', function (this: SpecWorld, _ignored0: string) { assert.equal(this.h.context().goalVersion, 2); assert.equal(this.h.context().outcome, null); });
Given('{string}已依据{string}和{string}准备完成但尚未提交', function (this: SpecWorld, operation: string, _ignored1: string, _ignored2: string) { this.prepare(operation); });
Given('提交前已持久保存{string}', function (this: SpecWorld, change: string) {
  if (change === '停止意图') this.h.event({ type: 'STOP' });
  if (change === '目标改为 G2') this.h.event({ type: 'USER_INPUT', text: 'G2', goal: { ...this.h.context().goal, constraints: ['G2'] } });
  if (change === '执行轮次已改为 E2') {
    this.h.event({ type: 'STOP' });
    for (const i of this.h.context().intents.filter(i => i.status === 'inflight')) this.h.event({ type: 'SETTLE', intentId: i.id });
    this.h.event({ type: 'CONTINUE' });
  }
});
When('该操作尝试提交', function (this: SpecWorld) {
  if (this.prepared === '协助派发') this.result = { ok: Boolean(this.h.engine.claim(this.h.room, this.h.task, this.oldWork!.id)) };
  if (this.prepared === '结果回传推进') this.result = this.h.event({ type: 'HELP_RESULT', requestId: 'H1', resultId: 'R1', status: 'success', answer: 'evidence', fence: this.frame });
  if (this.prepared === '最终结果发布') this.result = this.h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'check', workId: this.oldWork!.id, fence: this.frame });
});
Then('应拒绝该操作对当前任务的过期推进', function (this: SpecWorld) { assert.equal(this.result.ok, false); });
Then('应保留当前控制状态及已保存的历史记录', function (this: SpecWorld) { const c = this.h.context(); assert(c.stopped || c.goalVersion === 2 || c.epoch === 2); assert(c.messages.length > 0); assert(!c.messages.some(m => m.kind === 'final')); });

Given('团队已配置方案师{string}、核查员{string}与后台促进者', function (this: SpecWorld, a: string, b: string) { assert(this.h.config.bots.some(bot => bot.id === a)); assert(this.h.config.bots.some(bot => bot.id === b)); });
Given('本次任务的完成标准为一份带官方依据和恢复边界的 Markdown 方案', function (this: SpecWorld) { this.h.event({ type: 'USER_INPUT', text: 'deliver markdown with evidence', goal: { ...this.h.context().goal, requiredArtifacts: 1 } }); });
When('用户要求{string}', function (this: SpecWorld, text: string) { this.h.event({ type: 'USER_INPUT', text }); });
When('{string}提交要求{string}核对官方恢复边界的求助', function (this: SpecWorld, _ignored0: string, _ignored1: string) { assert(this.ask().ok); this.received = this.h.claim('assistance'); });
When('{string}返回有关会话恢复和外部动作去重的证据', function (this: SpecWorld, _ignored0: string) { this.record('Session recovery is supported; external writes need idempotency. Official source attached.'); });
When('{string}结合该证据提交符合要求的方案文件', function (this: SpecWorld, _ignored0: string) { this.h.event({ type: 'ARTIFACT', artifact: { id: 'A1', name: 'plan.md', content: '# Plan\nOfficial source; recovery limitations.' } }); this.h.event({ type: 'DELIVER', text: 'Final plan with evidence', artifactIds: ['A1'] }); });
When('确定性检查与必要的语义检查均通过', function (this: SpecWorld) { this.h.event({ type: 'CHECK_RESULT', passed: true, gaps: [], resultId: 'finalCheck' }); });
Then('群内应能看到原委托、具体求助、核查答复及一份最终交付', function (this: SpecWorld) { const kinds = this.h.context().messages.map(m => m.kind); for (const k of ['user', 'help', 'answer', 'final']) assert(kinds.includes(k as never)); assert.equal(kinds.filter(k => k === 'final').length, 1); });
Then('主任务应结束为{string}且负责人仍为{string}', function (this: SpecWorld, outcome: string, owner: string) { assert.equal(outcome, '完成'); assert.equal(this.h.context().outcome, 'complete'); assert.equal(this.h.context().owner, owner); });
Then('无需用户逐次批准派发或再次确认才能停止自主运行', function (this: SpecWorld) { assert.equal(this.h.view().phase, 'ended'); assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 0); });

Given('任务{string}具有明确的目标、硬约束和完成标准', function (this: SpecWorld, _task: string) {
  const goal = this.h.context().goal;
  assert(goal.text && goal.constraints.length && goal.criteria.length);
});
Given('模型输出与语义检查结果由测试替身控制', function (this: SpecWorld) { assert.equal(this.h.config.models, undefined); });
Given('所有数字额度均为本场景的测试配置', function (this: SpecWorld) { assert(Number.isSafeInteger(this.h.config.limits.ordinary)); });
Given('群评审的普通执行额度为 {int} 次且完成检查额度单独预留', function (this: SpecWorld, limit: number) {
  this.h = new Harness(configuration({ ordinary: limit }));
  assert(this.h.config.limits.checks > 0);
  assert(this.h.engine.submit(this.h.room, { id: 'group-review', text: '大家都提提意见：方案为离线缓存并在联网后同步。' }).ok);
});
Given('促进者已完成评审组织且首位成员等待执行', async function (this: SpecWorld) {
  const runner = new WorkRunner(this.h.engine, this.reviewAdapter(), () => this.h.now);
  assert(await runner.runOne(this.h.room, this.h.task));
  assert.equal(this.h.context().usage.ordinary, 1);
  assert.equal(this.h.engine.pending(this.h.room, this.h.task)[0]?.kind, 'assistance');
});
When('该成员尝试通过{string}继续执行', async function (this: SpecWorld, path: string) {
  assert(['额外模型请求', '技能搜索', '瞬态故障重试', '重启后重新领取'].includes(path));
  this.reviewPath = path;
  if (path === '重启后重新领取') {
    const pending = this.h.engine.pending(this.h.room, this.h.task)[0]!;
    assert(this.h.engine.claim(this.h.room, this.h.task, pending.id));
    this.h.engine = new TeamEngine(this.h.store, this.h.config, () => this.h.now);
    this.h.engine.recover(this.h.room);
  }
  await this.drainReview();
});
Then('不应通过该路径发出额外的模型或工具请求', function (this: SpecWorld) { assert.equal(this.extraReviewRequests, 0); });
Then('应记录该成员的未完成原因并将最后一次普通请求用于负责人汇总', function (this: SpecWorld) {
  assert.equal(this.h.context().assists[0]?.status, 'failed');
  assert(this.h.context().assists[0]?.answer);
  assert(this.h.context().review?.incomplete);
  assert.equal(this.reviewCalls.filter(work => work.kind === 'owner').length, 1);
  assert.equal(this.h.context().usage.ordinary, 3);
});
When('该成员通过额外模型请求完成评审', async function (this: SpecWorld) {
  this.reviewPath = '额外模型请求';
  await this.drainReview();
});
Then('应允许该次额外请求且保留一次普通请求用于负责人汇总', function (this: SpecWorld) {
  assert.equal(this.extraReviewRequests, 1);
  assert.equal(this.reviewCalls.filter(work => work.kind === 'owner').length, 1);
  assert.equal(this.h.context().usage.ordinary, 4);
});
Then('该成员的评审应成功且未收齐的成员应如实记录为缺口', function (this: SpecWorld) {
  assert.equal(this.h.context().assists[0]?.status, 'success');
  const review = this.h.context().review!;
  assert.equal(review.completed.length, 1);
  for (const target of review.targets.filter(target => !review.completed.includes(target))) assert(review.incomplete?.includes(target));
});
Then('汇总应经过完成检查且群评审应结束为{string}', function (this: SpecWorld, outcome: string) {
  assert.equal(outcome, '部分完成');
  assert.equal(this.reviewCalls.filter(work => work.kind === 'check').length, 1);
  assert.equal(this.h.view().phase, 'ended');
  assert.equal(this.h.context().outcome, 'partial');
});
