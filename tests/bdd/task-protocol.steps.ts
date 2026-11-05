import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { TeamEngine } from '../../src/engine.js';
import { TaskProtocolFixture } from '../task-protocol-fixture.js';
import type { SpecWorld } from './steps.js';

interface State {
  fixture: TaskProtocolFixture;
  original: ReturnType<TaskProtocolFixture['view']>;
  saved: TaskProtocolFixture['saved'];
}
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => states.get(world)!;
const fixture = (world: SpecWorld) => state(world).fixture;
async function prepare(world: SpecWorld, terminal: boolean) {
  const f = await TaskProtocolFixture.create(terminal);
  states.set(world, { fixture: f, original: f.view(), saved: f.saved });
  assert.equal(f.saved.version, 1);
}
After(async function (this: SpecWorld) { await states.get(this)?.fixture.close(); });
Given('旧协议的活动任务已启动一条命令且尚未记录已结算结果', async function (this: SpecWorld) {
  await prepare(this, false);
  assert.equal(fixture(this).persistedOp.status, 'running');
});
When('服务按当前协议重启并恢复任务', function (this: SpecWorld) { fixture(this).upgrade(); });
Then('应保留旧协议和执行结果待核对的状态', function (this: SpecWorld) {
  const f = fixture(this);
  assert.equal(f.view().phase, 'waitingHuman');
  assert.equal(f.view().context.config.version, 'team-v1');
  assert.equal(f.persistedOp.status, 'uncertain');
});
Then('核对可信回执后应保留历史并继续显示恢复阻塞', async function (this: SpecWorld) {
  const f = fixture(this);
  await f.reconcile();
  assert.equal(f.view().context.reason, 'Execution version incompatible');
  assert.equal(f.persistedOp.status, 'failed');
  assert.equal(f.persistedOp.result?.data.stdout, '旧回执');
  assert.equal(f.saved.version, 1);
});
Then('不应恢复旧的模型请求或重放命令', async function (this: SpecWorld) {
  const f = fixture(this);
  const continuation = f.continue('继续任务');
  assert.equal(continuation.code, 'INCOMPATIBLE_EXECUTION');
  assert.equal(await f.tryRun(), false);
  assert.equal(f.modelCalls, 0);
  assert.equal(f.backend.calls.length, 1);
});
Given('旧协议的已结束任务保存了交付历史、已用额度和确定失败的沙箱记录', async function (this: SpecWorld) {
  await prepare(this, true);
});
When('当前协议服务重启并读取该任务', function (this: SpecWorld) { fixture(this).upgrade(); });
Then('原交付和已结算记录应保持可查看且任务仍处于结束状态', function (this: SpecWorld) {
  const { fixture: f, original, saved } = state(this);
  assert.deepEqual(f.view(), original);
  assert.deepEqual(f.saved, saved);
  assert.equal(f.view().phase, 'ended');
});
When(/^用户通过「(.+)」明确继续该任务$/, function (this: SpecWorld, route: string) {
  const reply = fixture(this).continue(route);
  assert(reply.ok, reply.code);
});
Then('应使用当前协议和当前权限为同一目标安排新工作', function (this: SpecWorld) {
  const { fixture: f, original } = state(this);
  const current = f.view().context;
  assert.equal(f.saved.version, 2);
  assert.equal(current.config.version, 'team-v2');
  assert.equal(current.config.toolVersion, 'tools-v2');
  assert.deepEqual(current.config.bots, f.currentConfig.bots);
  assert.deepEqual(current.goal, original.context.goal);
  const pending = f.engine.pending(f.room, f.task);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.model?.serviceId, 'current');
  assert.equal(pending[0]?.epoch, original.context.epoch + 1);
});
Then('应保留原交付和已用额度且旧工作不能重新领取', function (this: SpecWorld) {
  const { fixture: f, original } = state(this);
  const current = f.view().context;
  assert.deepEqual(current.usage, original.context.usage);
  assert.deepEqual(current.artifacts, original.context.artifacts);
  assert.deepEqual(current.messages.filter(m => m.kind === 'final'), original.context.messages.filter(m => m.kind === 'final'));
  assert.equal(f.engine.claim(f.room, f.task, original.context.intents[0]!.id), null);
  assert.equal(f.backend.calls.length, 1);
});
Then('旧服务不能领取当前协议的新工作', function (this: SpecWorld) {
  const f = fixture(this);
  const older = new TeamEngine(f.store, f.legacyConfig, () => 55);
  const pending = f.engine.pending(f.room, f.task)[0]!;
  assert.equal(f.saved.version, 2);
  assert.deepEqual(older.pending(f.room, f.task), []);
  assert.equal(older.claim(f.room, f.task, pending.id), null);
  assert.equal(f.engine.claim(f.room, f.task, pending.id)?.id, pending.id);
});
