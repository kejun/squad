import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SpecWorld } from './steps.js';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { failedSandbox, request, retryOp, retryWork, claimRetryWork, prepareRetry, decideRetry } from '../host-retry-model-fixture.js';
import type { LocalModel } from '../local-model-fixture.js';
import { Workspace } from '../../web/src/App.js';
import { Details } from '../../web/src/Details.js';
import { HostRetryButton } from '../../web/src/HostRetryButton.js';
import type { useWorkspace } from '../../web/src/api.js';

interface State { f?: HostRetryFixture; boundary?: string; rejected?: boolean; model?: LocalModel; warning?: string }
const states = new WeakMap<SpecWorld, State>();
const state = (w: SpecWorld) => { let s = states.get(w); if (!s) { s = {}; states.set(w, s); } return s; };
async function setup(w: SpecWorld) { const s = state(w); s.f = new HostRetryFixture(); await s.f.failedRound(); return s.f; }
function renderWorkspace(f: HostRetryFixture) {
  const workspace: ReturnType<typeof useWorkspace> = {
    rooms: [f.room], roomId: f.room.id, snapshot: f.snapshot(), connected: true, error: '',
    setError() {}, chooseRoom() {}, createRoom: async () => f.room.id, refreshRooms: async () => [f.room],
    setRoomArchived: async () => { throw new Error('Unexpected archive action'); },
  };
  return renderToStaticMarkup(createElement(Workspace, { workspace }));
}
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
Given('已结束的失败沙箱记录包含{string}', async function (this: SpecWorld, warning: string) {
  const s = state(this); s.model = failedSandbox(true); s.warning = warning;
  if (warning === '一个文件已有变更') s.model.op!.result!.data.outputFiles = [{ path: 'changed.txt' }];
  const f = await setup(this); assert.equal(f.snapshot().tasks.at(-1)?.outcome, 'complete');
});
When('用户从该失败记录请求在宿主执行', async function (this: SpecWorld) { assert(request(state(this).model!).ok); assert.equal((await state(this).f!.requestRetry()).status, 200); });
Then('应从原始记录生成固定命令并显示按次审批而尚未执行', async function (this: SpecWorld) {
  const s = state(this), m = s.model!, retry = retryWork(m);
  assert.equal(m.snapshot.value, 'running'); assert.equal(m.c.outcome, null); assert.equal(m.c.goalVersion, 1); assert.equal(retry.target, 'A'); assert.equal(retry.status, 'pending');
  assert.deepEqual(retry.localOperations?.[0]?.action, { type: 'runCli', executable: 'node', args: ['script.js'], execution: 'host', reason: s.warning === '一个文件已有变更' ? retry.localOperations![0]!.action.type === 'runCli' ? retry.localOperations![0]!.action.reason : '' : '用户请求在宿主重试已确定失败的沙箱命令' });
  if (s.warning === '一个文件已有变更') assert(retry.localOperations?.[0]?.action.type === 'runCli' && retry.localOperations[0].action.reason?.includes('1个文件变更'));
  assert.equal(retry.localOperations?.[0]?.approval, undefined); assert.equal(retry.localCheckpoint?.pendingOperationId, retry.localOperations?.[0]?.id); assert.equal(m.op?.status, 'failed'); assert.equal(m.op?.hostRetryIntentId, retry.id);
  const f = s.f!, a = await f.approval(); assert.equal(a.executable, f.executable);
  assert.deepEqual(a.args, f.action.type === 'runCli' ? f.action.args : []); assert.equal(await f.runs(), '');
});
Then('批准后命令只执行一次且真实回执交回任务负责人继续整理', async function (this: SpecWorld) {
  const f = state(this).f!, a = await f.approval(); assert.equal((await f.request(f.decisionData(a, 'approve'))).status, 200);
  await f.complete(); assert.equal(await f.runs(), 'once\n');
  const c = f.service.engine.view(f.room.id, f.taskId)!.context;
  assert.equal(c.intents.find(w => w.localOperations?.some(op => op.hostRetryOf))?.target, c.owner);
  assert(f.requests.at(-1)!.messages.some(m => m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"')));
});
Given('进行中的任务在聊天输入区提供失败命令的宿主重试入口', async function (this: SpecWorld) {
  const f = new HostRetryFixture(); state(this).f = f;
  await f.pauseAfterTwoFailures();
  assert.match(renderWorkspace(f), /请求在宿主执行/);
});
When('任务成功交付', async function (this: SpecWorld) {
  const f = state(this).f!; f.resumeMain();
  const snapshot = await f.complete();
  assert.equal(snapshot.tasks.at(-1)?.outcome, 'complete');
});
Then('聊天输入区应收起该任务的失败命令提示', function (this: SpecWorld) {
  assert.doesNotMatch(renderWorkspace(state(this).f!), /aria-label="失败的沙箱命令"/);
});
Then('成员执行记录仍显示失败命令和可用的宿主重试入口', function (this: SpecWorld) {
  const snapshot = state(this).f!.snapshot();
  const agent = snapshot.agents.find(agent => agent.id === snapshot.tasks.at(-1)?.owner);
  assert(agent);
  const details = renderToStaticMarkup(createElement(Details, { snapshot, agent, connected: true, onClose() {} }));
  assert.match(details, /aria-label="失败的沙箱命令"/);
  assert.match(details, /<button\b(?![^>]*\bdisabled\b)[^>]*>请求在宿主执行<\/button>/);
});
Given('模型未申请宿主执行且失败命令旁显示手动入口', async function (this: SpecWorld) {
  state(this).model = failedSandbox(true);
  const f = await setup(this); const command = f.snapshot().failedSandboxCommands![0]!;
  assert(command.canRequest); assert(renderToStaticMarkup(createElement(HostRetryButton, { roomId: f.room.id, command, connected: true })).includes('请求在宿主执行'));
});
When('用户重复点击对应记录的宿主请求入口', async function (this: SpecWorld) {
  const m = state(this).model!, saved = request(m), count = m.c.intents.length; assert.deepEqual(request(m), saved); assert.equal(m.c.intents.length, count);
  const f = state(this).f!, data = f.retryData(); const first = await f.requestRetry(data); assert.equal(first.status, 200);
  const duplicate = await f.requestRetry(data), nextClick = await f.requestRetry({ ...data, id: 'another-click' }); assert.equal(duplicate.status, 200); assert.equal(nextClick.status, 200);
  const identity = (value: unknown) => { assert(value && typeof value === 'object' && !Array.isArray(value)); const body = value as Record<string, unknown>; return { code: body.code, detail: body.detail, taskId: body.taskId }; };
  assert.deepEqual(identity(duplicate.data), identity(first.data)); assert.deepEqual(identity(nextClick.data), identity(first.data));
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
    else if (s.boundary === '明确隔离副本') m.op!.isolated = true;
    else if (s.boundary === '仍有其他本地命令') m.c.intents[0]!.localOperations!.push({ ...m.op!, id: 'other', status: 'running' });
    else if (s.boundary === '写入清单截断') m.op!.result!.data.outputFilesTruncated = true;
    else if (s.boundary === '普通额度耗尽') m.c.config.limits.ordinary = m.c.usage.ordinary;
    else if (s.boundary === '源命令摘要变化') { assert.equal(request(m, 'forged').code, 'SOURCE_COMMAND_CHANGED'); assert.equal(m.c.intents.length, count); s.rejected = true; return; }
    else if (s.boundary === '准备后原成员权限撤回') { m.c.intents[0]!.target = 'B'; assert(request(m).ok); claimRetryWork(m); prepareRetry(m); m.c.config.bots.find(b => b.id === 'B')!.localTools = false; assert.equal(decideRetry(m).code, 'LOCAL_TOOLS_DISABLED'); assert.equal(retryOp(m).startedAt, undefined); s.rejected = true; return; }
    else throw new Error('Unknown boundary: ' + s.boundary);
    const rejected = request(m); assert.equal(rejected.ok, false); if (['隔离检查副本', '隔离讨论副本', '明确隔离副本'].includes(s.boundary!)) { assert.equal(rejected.code, 'HOST_RETRY_ISOLATED_SOURCE'); assert.equal(m.c.hostRetryRequests, undefined); } assert.equal(m.c.intents.length, count);
    assert.equal(m.c.intents.flatMap(w => w.localOperations ?? []).filter(op => op.hostRetryOf).length, 0);
  }
  s.rejected = true;
});
Then('应拒绝不适用的请求且不得启动进程', function (this: SpecWorld) { assert.equal(state(this).rejected, true); });
