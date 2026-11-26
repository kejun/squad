import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { WebTask } from '../../src/web/contracts.js';
import { PanelFixture } from '../panel-fixture.js';
import type { SpecWorld } from './steps.js';

const fixtures = new WeakMap<SpecWorld, PanelFixture>();
function fixture(world: SpecWorld) {
  const result = fixtures.get(world);
  assert(result);
  return result;
}

After(async function (this: SpecWorld) { await fixtures.get(this)?.close(); });

Given('群聊输入区有一项正在等用户回复的任务', async function (this: SpecWorld) {
  const task: WebTask = { id: 'task:original', goal: '原委托', owner: 'A', phase: 'waitingHuman', outcome: null, reason: '请补充资料',
    usage: { ordinary: 1, checks: 0 }, limits: { ordinary: 10, checks: 1 }, artifacts: [], board: [], trace: [] };
  const panel = new PanelFixture();
  fixtures.set(this, panel);
  await panel.mount({ activeTaskId: task.id, tasks: [task] });
});

When('用户用输入区另开一条独立委托', async function (this: SpecWorld) {
  const panel = fixture(this);
  await panel.click('新委托');
  assert.equal(panel.label('新委托').getAttribute('aria-pressed'), 'true');
  await panel.typeMessage('@B 整理另一个问题');
  await panel.click('发送消息');
});

Then('输入应作为同群新委托提交', function (this: SpecWorld) {
  const [post] = fixture(this).posts;
  assert.equal(post?.url, '/api/rooms/first/messages');
  assert.equal(post.body.intent, 'new');
  assert.equal(post.body.text, '@B 整理另一个问题');
  assert(!Object.hasOwn(post.body, 'replyToTaskId'));
});

When('用户继续回复原任务', async function (this: SpecWorld) {
  const panel = fixture(this);
  await panel.typeMessage('补上原资料');
  await panel.click('发送消息');
});

Then('回复应附原任务的标识', function (this: SpecWorld) {
  const [, post] = fixture(this).posts;
  assert.equal(post?.url, '/api/rooms/first/messages');
  assert.equal(post.body.intent, 'decision');
  assert.equal(post.body.replyToTaskId, 'task:original');
  assert.equal(post.body.text, '补上原资料');
});

When('原任务恢复执行后用户继续补充资料', async function (this: SpecWorld) {
  const panel = fixture(this);
  await panel.setActivePhase('running');
  await panel.typeMessage('再补一条原任务资料');
  await panel.click('发送消息');
});

Then('补充也应附原任务的标识', function (this: SpecWorld) {
  const post = fixture(this).posts[2];
  assert.equal(post?.url, '/api/rooms/first/messages');
  assert.equal(post.body.intent, 'supplement');
  assert.equal(post.body.replyToTaskId, 'task:original');
  assert.equal(post.body.text, '再补一条原任务资料');
});
