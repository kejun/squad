import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { TeamEngine, MemoryStore, SqliteStore, WorkRunner, initialTask, persistTask, type Intent, type WorkAdapter, type Store } from '../../src/index.js';
import { Harness, configuration } from '../helpers.js';
import type { SpecWorld } from './steps.js';

const proposal = 'ESP32 同步方案：缓存文档增量并在联网后同步，墨水屏按区域刷新。';
const reviewers = ['B', 'builder-1', 'builder-2', 'builder-3'];
interface State { oldTask: string; before: number; calls: Intent[]; seq: number; selected?: string; fail?: string; decision?: string; work?: Intent; directory?: string; store: Store }
const states = new WeakMap<SpecWorld, State>();
const s = (w: SpecWorld) => { const value = states.get(w); assert(value); return value; };
function fresh(w: SpecWorld, seeded = true, sqlite = false) {
  const directory = sqlite ? mkdtempSync(join(tmpdir(), 'gherkin-review-')) : undefined;
  const store = directory ? new SqliteStore(join(directory, 'team.sqlite')) : new MemoryStore();
  w.h = new Harness(configuration(), store); w.h.room = 'review-room';
  const state: State = { oldTask: 'task:plan', before: 0, calls: [], seq: 0, store, ...(directory ? { directory } : {}) }; states.set(w, state);
  if (seeded) {
    const task = w.h.engine.submit(w.h.room, { id: 'plan', text: '制定同步方案' }); w.h.task = task.taskId!;
    w.h.event({ type: 'ARTIFACT', artifact: { id: 'old-plan', name: '原方案', content: proposal } });
    w.h.event({ type: 'DELIVER', text: proposal, artifactIds: ['old-plan'] });
    w.h.event({ type: 'CHECK_RESULT', resultId: 'plan-check', passed: true, gaps: [] });
    state.before = w.h.engine.timeline(w.h.room).length;
  }
}
function request(w: SpecWorld, text = '大家都提提意见', mentions: string[] = []) {
  const result = w.h.engine.submit(w.h.room, { id: `review-${++s(w).seq}`, text, mentions }); assert(result.ok); w.h.task = result.taskId!;
}
function adapter(w: SpecWorld): WorkAdapter {
  return { execute: async work => {
    const state = s(w); state.calls.push(work);
    if (work.kind === 'facilitator') {
      if (state.decision === 'askUser') return { type: 'decision', decision: { action: 'askUser', question: '请补充待评审方案', reason: '确实没有材料' } };
      if (state.decision && state.decision !== 'review') return { type: 'decision', decision: { action: state.decision, target: 'B', question: '评审', expected: '意见', plan: '跳过评审', reason: '尝试跳过' } as never };
      return { type: 'decision', decision: { action: 'review', question: '评审已有同步方案的风险与改进', expected: '带依据的具体意见', reason: '用户要求成员评审' } };
    }
    if (work.kind === 'assistance') { if (work.target === state.fail) throw new Error('核查服务不可用'); return { type: 'answer', text: `${work.target}：建议验证离线恢复。` }; }
    if (work.kind === 'check') return { type: 'check', passed: true, gaps: [] };
    assert.equal(work.kind, 'owner'); return { type: 'deliver', text: '共识为增量同步；分歧与失败成员已列入缺口；下一步验证离线恢复。', artifactIds: [] };
  } };
}
async function drain(w: SpecWorld) { const runner = new WorkRunner(w.h.engine, adapter(w), () => 0); for (let n = 0; n < 30; n++) if (!(await runner.runOne(w.h.room, w.h.task))) return; assert.fail('评审没有在有限步骤内结束'); }
async function startMember(w: SpecWorld) { request(w); await new WorkRunner(w.h.engine, adapter(w), () => 0).runOne(w.h.room, w.h.task); const work = w.h.engine.pending(w.h.room, w.h.task)[0]!; s(w).work = w.h.engine.claim(w.h.room, w.h.task, work.id)!; assert.equal(s(w).work!.kind, 'assistance'); }
After(function (this: SpecWorld) { const state = states.get(this); if (state?.directory) { (state.store as SqliteStore).close(); rmSync(state.directory, { recursive: true, force: true }); } });

Given('同群已经交付一份方案且另一群有私有资料', function (this: SpecWorld) { fresh(this); this.h.engine.submit('private-room', { id: 'secret', text: '不可外泄的其他群资料' }); });
When('用户在原群提出关于上述方案的后续问题', function (this: SpecWorld) { request(this, '请说明上述方案的边界'); });
Then('新任务输入应包含有来源身份的原方案且不包含另一群资料', function (this: SpecWorld) { const payload = this.h.engine.pending(this.h.room, this.h.task)[0]!.payload; assert(JSON.stringify(payload).includes(proposal)); assert(JSON.stringify(payload).includes(s(this).oldTask)); assert(!JSON.stringify(payload).includes('不可外泄的其他群资料')); });
Then('原任务应保持结束且时间线不应复制历史发言', function (this: SpecWorld) { assert.equal(this.h.engine.view(this.h.room, s(this).oldTask)?.phase, 'ended'); assert.equal(this.h.engine.timeline(this.h.room).length, s(this).before + 1); });
Given('同群已有方案且一个旧等待任务没有历史上下文', function (this: SpecWorld) {
  fresh(this); const taskId = 'task:legacy';
  const snapshot = initialTask({ taskId, owner: 'A', config: this.h.config, goal: { text: '评审方案', constraints: [], criteria: ['给出意见'], requiredArtifacts: 0 }, at: 0, message: { id: 'legacy', taskId, author: 'user', at: 0, text: '看看方案', kind: 'user' } });
  s(this).store.transact(this.h.room, tx => { tx.room.tasks[taskId] = { version: 1, snapshot: persistTask(snapshot) }; tx.room.activeTaskId = taskId; });
  this.h.task = taskId; this.h.event({ type: 'WAIT_USER', question: '此前未提供方案' }); assert.equal(this.h.context().history, undefined);
});
When('用户要求大家评审上述方案', function (this: SpecWorld) { request(this); });
Then('促进者输入应包含原方案且不应要求重复提交已有材料', function (this: SpecWorld) { const work = this.h.engine.pending(this.h.room, this.h.task)[0]!; assert.equal(work.kind, 'facilitator'); assert(JSON.stringify(work.payload.messages).includes(proposal)); assert.equal(this.h.view().phase, 'coordinating'); });
Given('同群历史超过消息或文本上限且包含旧任务产物', function (this: SpecWorld) { fresh(this); const task = this.h.engine.submit(this.h.room, { id: 'large', text: '历史长文本'.repeat(25000) }); const id = task.taskId!; this.h.engine.send(this.h.room, id, { type: 'DELIVER', id: 'large-deliver', at: 0, text: '大任务已交付', artifactIds: [] }); this.h.engine.send(this.h.room, id, { type: 'CHECK_RESULT', id: 'large-check', at: 0, resultId: 'large-check', passed: true, gaps: [] }); });
When('准备一个要求新交付物的后续任务', function (this: SpecWorld) { const result = this.h.engine.submit(this.h.room, { id: 'new-delivery', text: '参考旧方案，交付新文件', goal: { text: '交付新文件', constraints: [], criteria: ['文件存在'], requiredArtifacts: 1 } }); this.h.task = result.taskId!; });
When('尝试将旧产物作为本轮交付', function (this: SpecWorld) { this.h.event({ type: 'DELIVER', text: '声称复用文件', artifactIds: ['old-plan'] }); this.h.event({ type: 'CHECK_RESULT', resultId: 'new-check', passed: true, gaps: [] }); });
Then('历史输入应有界并说明发生截断', function (this: SpecWorld) { const history = this.h.context().history!; assert(history.truncated); assert(history.messages.length <= 100); assert(history.messages.reduce((n, message) => n + message.text.length, 0) <= 96000); });
Then('旧产物只应作为参考且不能通过本轮产物检查', function (this: SpecWorld) { assert(this.h.context().history?.artifacts.some(artifact => artifact.id === 'old-plan')); assert.equal(this.h.context().artifacts.length, 0); assert.equal(this.h.context().outcome, null); assert(this.h.context().reason.includes('MISSING')); });
Given('群内已有待评审方案与五位有效成员', function (this: SpecWorld) { fresh(this); assert.equal(this.h.config.bots.length, 5); });
When('用户直接说{string}', async function (this: SpecWorld, text: string) { request(this, text); await drain(this); });
Then('应先由促进者组织评审且依次收集其余四位成员意见', function (this: SpecWorld) { assert.deepEqual(s(this).calls.map(work => `${work.kind}:${work.target}`), ['facilitator:facilitator', ...reviewers.map(id => `assistance:${id}`), 'owner:A', 'check:facilitator']); });
Then('负责人应在所有成员结算后汇总一次并接受完成检查', function (this: SpecWorld) { const owner = s(this).calls.filter(work => work.kind === 'owner'); assert.equal(owner.length, 1); assert.deepEqual((owner[0]!.payload.review as { completed: string[] }).completed, reviewers); assert.equal(this.h.context().outcome, 'complete'); });
Given('当前任务由{string}负责且尚未结束', function (this: SpecWorld, owner: string) { request(this, '请处理上述方案'); assert.equal(this.h.context().owner, owner); assert.equal(this.h.context().outcome, null); });
When('用户仅选择{string}评审方案', async function (this: SpecWorld, id: string) { request(this, `@${id} 评审方案`, [id]); s(this).selected = id; await drain(this); });
Then('只应收集该成员意见并由原负责人汇总', function (this: SpecWorld) { assert.deepEqual(s(this).calls.filter(work => work.kind === 'assistance').map(work => work.target), [s(this).selected]); assert.equal(s(this).calls.filter(work => work.kind === 'owner').length, 1); assert.equal(this.h.context().owner, 'A'); });
When('评审邀请来自{string}', function (this: SpecWorld, source: string) { if (source === 'Bot 发言') { request(this, '请继续处理方案'); this.h.event({ type: 'DELIVER', text: '大家都提提意见', artifactIds: [] }); } else request(this, source === '引用' ? '> 大家都提提意见' : source === '代码' ? '```text\n大家都提提意见\n```' : '大家不用提意见，先等我补充'); });
Then('不应创建全员评审队列', function (this: SpecWorld) { assert.equal(this.h.context().review, undefined); assert.equal(this.h.context().assists.length, 0); });
Given('群内没有待评审方案', function (this: SpecWorld) { fresh(this, false); });
When('用户要求全员评审且促进者请求补充方案', async function (this: SpecWorld) { s(this).decision = 'askUser'; request(this); await drain(this); });
Then('应等待用户且不应通过定时检查反复询问', function (this: SpecWorld) { this.h.now = 1000000; this.h.engine.tick(this.h.room); assert.equal(this.h.view().phase, 'waitingHuman'); assert.equal(s(this).calls.length, 1); assert.equal(this.h.engine.nextWake(this.h.room), null); });
When('用户提交缺失方案', function (this: SpecWorld) { s(this).decision = 'review'; this.h.engine.submit(this.h.room, { id: 'material', text: proposal, intent: 'decision' }); });
Then('应重新组织评审并向促进者提供该方案', function (this: SpecWorld) { const work = this.h.engine.pending(this.h.room, this.h.task)[0]!; assert.equal(work.kind, 'facilitator'); assert(JSON.stringify(work.payload).includes(proposal)); });
When('用户要求全员评审但促进者返回{string}', async function (this: SpecWorld, decision: string) { s(this).decision = decision; request(this); await drain(this); });
Then('应拒绝跳过评审并等待用户处理', function (this: SpecWorld) { assert.equal(this.h.view().phase, 'waitingHuman'); assert.equal(this.h.context().assists.length, 0); assert(this.h.context().trace.some(trace => trace.detail.includes('REVIEW_PLAN_REQUIRED'))); });
When('首位评审成员失败且其余成员正常返回', async function (this: SpecWorld) { s(this).fail = 'B'; request(this); await drain(this); });
Then('应继续收集剩余意见并由负责人汇总', function (this: SpecWorld) { assert.deepEqual(s(this).calls.filter(work => work.kind === 'assistance').map(work => work.target), reviewers); assert.equal(s(this).calls.filter(work => work.kind === 'owner').length, 1); });
Then('最终结果应为部分完成且保留失败原因', function (this: SpecWorld) { assert.equal(this.h.context().outcome, 'partial'); assert(this.h.context().messages.some(message => message.author === 'B' && message.text.includes('核查服务不可用'))); });
Given('首位成员评审正在执行', async function (this: SpecWorld) { fresh(this); await startMember(this); });
When('用户停止且关联工作结算', function (this: SpecWorld) { this.h.event({ type: 'STOP' }); this.h.event({ type: 'SETTLE', intentId: s(this).work!.id }); });
Then('本轮评审队列应取消且不再派发成员', function (this: SpecWorld) { assert.equal(this.h.context().review?.status, 'cancelled'); assert.equal(this.h.context().outcome, 'stopped'); assert(this.h.engine.pending(this.h.room, this.h.task).every(work => work.kind === 'cancel')); });
When('用户明确继续评审', function (this: SpecWorld) { assert(this.h.event({ type: 'CONTINUE' }).ok); });
Then('应以新轮次重新组织且旧结果不能推进新队列', function (this: SpecWorld) { assert.equal(this.h.context().epoch, 2); const result = this.h.event({ type: 'HELP_RESULT', requestId: String(s(this).work!.payload.requestId), resultId: 'late', status: 'success', answer: '旧评审', fence: { epoch: 1, goalVersion: 1 } }); assert.equal(result.ok, false); assert.deepEqual(this.h.context().review?.completed, []); assert.equal(this.h.engine.pending(this.h.room, this.h.task)[0]?.kind, 'facilitator'); });
When('用户补充新的评审重点', function (this: SpecWorld) { this.h.engine.submit(this.h.room, { id: 'focus', text: '重点检查离线恢复' }); });
Then('应先记录输入且不并发改写正在执行的成员', function (this: SpecWorld) { assert.equal(this.h.context().inputs.at(-1)?.applied, false); assert.equal(this.h.context().intents.find(work => work.id === s(this).work!.id)?.status, 'inflight'); assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 0); });
When('当前成员结算', function (this: SpecWorld) { const work = s(this).work!; this.h.event({ type: 'RECORD_RESULT', workId: work.id, requestId: String(work.payload.requestId), resultId: 'member-result', status: 'success', answer: '原重点意见', fence: { epoch: 1, goalVersion: 1 } }); });
Then('应先应用补充并重新组织评审再派发剩余工作', function (this: SpecWorld) { assert(this.h.context().inputs.every(input => input.applied)); const work = this.h.engine.pending(this.h.room, this.h.task)[0]!; assert.equal(work.kind, 'facilitator'); assert(JSON.stringify(work.payload).includes('重点检查离线恢复')); assert.equal(this.h.context().review?.status, 'pending'); });
Given('评审结果已在 SQLite 保存但尚未消费', async function (this: SpecWorld) { fresh(this, true, true); await startMember(this); const work = s(this).work!; this.h.event({ type: 'RECORD_RESULT', workId: work.id, requestId: String(work.payload.requestId), resultId: 'saved', status: 'success', answer: 'B 的已保存评审' }); assert.equal(this.h.context().results[0]?.consumed, false); });
When('重新打开存储并恢复两次', function (this: SpecWorld) { const state = s(this); (state.store as SqliteStore).close(); state.store = new SqliteStore(join(state.directory!, 'team.sqlite')); this.h.engine = new TeamEngine(state.store, this.h.config, () => 0); this.h.engine.recover(this.h.room); this.h.engine.recover(this.h.room); });
Then('该成员意见应只发布一次且只完成一次队列推进', function (this: SpecWorld) { assert.equal(this.h.context().messages.filter(message => message.text === 'B 的已保存评审').length, 1); assert.deepEqual(this.h.context().review?.completed, ['B']); });
Then('剩余成员应继续执行并最终汇总', async function (this: SpecWorld) { await drain(this); assert.equal(this.h.context().outcome, 'complete'); assert.deepEqual(s(this).calls.filter(work => work.kind === 'assistance').map(work => work.target), reviewers.slice(1)); });
When('用户修改硬约束且旧成员结果随后到达', function (this: SpecWorld) { this.h.engine.submit(this.h.room, { id: 'constraint', text: '预算不超过 500 元', goal: { ...this.h.context().goal, constraints: ['预算不超过 500 元'] } }); const work = s(this).work!; this.result = this.h.event({ type: 'RECORD_RESULT', workId: work.id, requestId: String(work.payload.requestId), resultId: 'old', status: 'success', answer: '旧硬约束评审', fence: { epoch: 1, goalVersion: 1 } }); });
Then('应保留旧结果历史但不能计入新版本评审', function (this: SpecWorld) { assert.equal(this.result.ok, false); assert(this.h.context().lateResults.length); assert.equal(this.h.context().goalVersion, 2); assert.deepEqual(this.h.context().review?.completed, []); assert(!this.h.context().messages.some(message => message.text === '旧硬约束评审')); });
Given('已组织评审但尚未派发的成员从当前配置移除', async function (this: SpecWorld) { fresh(this); request(this); await new WorkRunner(this.h.engine, adapter(this), () => 0).runOne(this.h.room, this.h.task); });
When('任务恢复', function (this: SpecWorld) { const config = configuration(); config.bots = config.bots.filter(bot => bot.id !== 'builder-3'); this.h.engine = new TeamEngine(s(this).store, config, () => 0); this.h.engine.recover(this.h.room); });
Then('应暂停并说明成员不可用且不派发剩余评审', function (this: SpecWorld) { assert.equal(this.h.view().phase, 'waitingHuman'); assert(this.h.context().reason.includes('member unavailable')); assert.equal(this.h.engine.pending(this.h.room, this.h.task).length, 0); });
