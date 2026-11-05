import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpecWorld } from './steps.js';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { failedSandbox, request } from '../host-retry-model-fixture.js';
import { HostRetryButton } from '../../web/src/HostRetryButton.js';

interface State { f?: HostRetryFixture; boundary?: string; rejected?: boolean }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => { let s = states.get(w); if (!s) { s = {}; states.set(w, s); } return s; };
async function setup(w: SpecWorld) { const s = state(w); s.f = new HostRetryFixture(); await s.f.failedRound(); return s.f; }
After(async function (this: SpecWorld) { await states.get(this)?.f?.close(); });
Given('命令需要本机登录态或系统能力且沙箱返回权限或网络签名失败', async function (this: SpecWorld) { await setup(this); });
When('模型收到失败回执并选择下一步动作', function (this: SpecWorld) {
  assert(state(this).f!.requests.at(-1)!.messages.some(m => m.content.startsWith('{"type":"local_tool_result",')));
});
Then('提示必须要求先申请具体宿主命令而非直接要求用户粘贴内容', function (this: SpecWorld) {
  const prompt = state(this).f!.requests[0]!.messages[0]!.content;
  for (const signature of ['PERM_DENIED', 'Operation not permitted', 'ENOTFOUND localhost', 'MUST first REQUEST', 'Do not declare the task impossible']) assert(prompt.includes(signature), signature);
});
Then('普通业务错误不得据此自动执行宿主命令', async function (this: SpecWorld) {
  const f = state(this).f!; assert(f.requests[0]!.messages[0]!.content.includes('Ordinary business errors'));
  assert.deepEqual(f.snapshot().hostApprovals, []); assert.equal(await f.runs(), '');
});
Given('Bot 已结束本轮且保留一条确定失败的沙箱命令', async function (this: SpecWorld) { const f = await setup(this); assert.equal(f.snapshot().tasks.at(-1)?.outcome, 'complete'); });
When('用户从该失败记录请求在宿主执行', async function (this: SpecWorld) { assert.equal((await state(this).f!.requestRetry()).status, 200); });
Then('应从原始记录生成固定命令并显示按次审批而尚未执行', async function (this: SpecWorld) {
  const f = state(this).f!, a = await f.approval(); assert.equal(a.executable, f.executable);
  assert.deepEqual(a.args, f.action.type === 'runCli' ? f.action.args : []); assert.equal(await f.runs(), '');
});
Then('批准后命令只执行一次且真实回执交回任务负责人继续整理', async function (this: SpecWorld) {
  const f = state(this).f!, a = await f.approval(); assert.equal((await f.request(f.decisionData(a, 'approve'))).status, 200);
  await f.complete(); assert.equal(await f.runs(), 'once\n');
  const c = f.service.engine.view(f.room.id, f.taskId)!.context;
  assert.equal(c.intents.find(w => w.localOperations?.some(op => op.hostRetryOf))?.target, c.owner);
  assert(f.requests.at(-1)!.messages.some(m => m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"')));
});
Given('模型未申请宿主执行且失败命令旁显示手动入口', async function (this: SpecWorld) {
  const f = await setup(this); const command = f.snapshot().failedSandboxCommands![0]!;
  assert(command.canRequest); assert(renderToStaticMarkup(createElement(HostRetryButton, { roomId: f.room.id, command, connected: true })).includes('请求在宿主执行'));
});
When('用户重复点击对应记录的宿主请求入口', async function (this: SpecWorld) {
  const f = state(this).f!, data = f.retryData(); assert.equal((await f.requestRetry(data)).status, 200);
  assert.equal((await f.requestRetry(data)).status, 200); assert.equal((await f.requestRetry({ ...data, id: 'another-click' })).status, 200);
});
Then('只应存在一条关联的宿主操作且必须等待用户批准', async function (this: SpecWorld) {
  const f = state(this).f!; await f.approval(); assert.equal(f.snapshot().hostApprovals!.length, 1); assert.equal(await f.runs(), '');
  const c = f.service.engine.view(f.room.id, f.taskId)!.context;
  assert.equal(c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf).length, 1);
});
Given('一条沙箱命令记录遇到{string}', function (this: SpecWorld, boundary: string) { state(this).boundary = boundary; });
When('用户尝试从该记录申请宿主执行', async function (this: SpecWorld) {
  const s = state(this);
  if (s.boundary === '其他任务活动' || s.boundary === '伪造参数') {
    const f = await setup(this), data = f.retryData();
    if (s.boundary === '其他任务活动') f.service.submit(f.room.id, { id: 'new-task', intent: 'new', text: '另一任务' });
    const reply = await f.requestRetry(s.boundary === '伪造参数' ? { ...data, args: ['changed'] } : data);
    assert.equal(reply.status, s.boundary === '伪造参数' ? 400 : 409); assert.equal(await f.runs(), ''); assert.deepEqual(f.snapshot().hostApprovals, []);
  } else {
    const m = failedSandbox(true), count = m.c.intents.length;
    if (s.boundary === '效果不明') m.op!.status = 'uncertain';
    else if (s.boundary === '已停止') m.c.stopped = true;
    else if (s.boundary === '旧目标') m.c.goalVersion++;
    else if (s.boundary === '权限关闭') m.c.config.localTools = { enabled: false };
    else if (s.boundary === '原命令已成功') { m.op!.status = 'succeeded'; m.op!.result!.ok = true; }
    else if (s.boundary === '原命令本来就是宿主执行' && m.op!.action.type === 'runCli') m.op!.action.execution = 'host';
    else if (s.boundary === '隔离检查副本') m.c.intents[0]!.kind = 'check';
    else if (s.boundary === '隔离讨论副本') m.c.intents[0]!.discussionId = 'discussion';
    else throw new Error('Unknown boundary: ' + s.boundary);
    assert.equal(request(m).ok, false); assert.equal(m.c.intents.length, count);
    assert.equal(m.c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf).length, 0);
  }
  s.rejected = true;
});
Then('应拒绝不适用的请求且不得启动进程', function (this: SpecWorld) { assert.equal(state(this).rejected, true); });
