import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { RoomArchiveFixture, archiveUntil } from '../room-archive-fixture.js';
import { RoomArchiveUIFixture } from '../room-archive-ui-fixture.js';
import { SqliteStore } from '../../src/store.js';
import { mergeRooms, roomList } from '../../web/src/room-list.js';
import type { SpecWorld } from './steps.js';
import type { RoomSnapshot, WebRoom } from '../../src/web/contracts.js';

interface Case { host: RoomArchiveFixture; stored?: ReturnType<RoomArchiveFixture['readStored']>; before?: RoomSnapshot; status?: number; list?: WebRoom[] }
const cases = new WeakMap<SpecWorld, Case>(), pages = new WeakMap<SpecWorld, RoomArchiveUIFixture>();
const state = (world: SpecWorld) => { const value = cases.get(world); assert(value); return value; };
const page = (world: SpecWorld) => { const value = pages.get(world); assert(value); return value; };
After(async function (this: SpecWorld) { await pages.get(this)?.close(); await cases.get(this)?.host.close(); });
Given('两个已有历史的群聊', async function (this: SpecWorld) {
  const host = new RoomArchiveFixture(); cases.set(this, { host }); await host.start(); await host.seed();
});
Given('一个已创建的群聊', async function (this: SpecWorld) {
  const host = new RoomArchiveFixture(); cases.set(this, { host }); await host.start(); await host.seed();
});
When('将当前群聊归档并查看归档列表', async function (this: SpecWorld) {
  const s = state(this); assert.equal((await s.host.change(true, 'archive')).status, 200);
  s.list = (await s.host.request<{ rooms: WebRoom[] }>('/api/rooms')).data.rooms;
});
Then('该群应只出现在归档列表且原消息任务和产物保持不变', function (this: SpecWorld) {
  const { host, list } = state(this); assert.deepEqual(roomList(list!, true).map(room => room.id), [host.first.id]);
  assert.deepEqual(roomList(list!, false).map(room => room.id), [host.second.id]); host.assertHistory();
});
When('从归档列表恢复该群聊', async function (this: SpecWorld) { assert.equal((await state(this).host.change(false, 'restore')).status, 200); });
Then('该群应回到普通列表并保留相同身份及历史', function (this: SpecWorld) {
  const { host } = state(this); assert.equal(host.service.snapshot(host.first.id).room.archived, false); host.assertHistory();
});
Given('一个负责人请求已经在途的群聊', async function (this: SpecWorld) {
  const host = new RoomArchiveFixture(); cases.set(this, { host }); await host.start(); host.first = host.service.createRoom(); host.hold = true;
  await host.request(host.route() + '/messages', { id: 'held', text: '在途任务' }); await archiveUntil(() => host.release, Boolean);
});
When('归档该群并让负责人返回结果及完成检查', async function (this: SpecWorld) {
  const { host } = state(this), before = host.service.snapshot(host.first.id);
  assert.equal((await host.change(true, 'archive-held')).status, 200); assert.deepEqual(host.service.snapshot(host.first.id).tasks, before.tasks);
  host.release!(); await archiveUntil(() => host.service.snapshot(host.first.id), value => value.tasks[0]?.outcome === 'complete');
});
Then('该任务应正常完成且归档操作不增加预算或取消工作', function (this: SpecWorld) {
  const { host } = state(this), after = host.service.snapshot(host.first.id);
  assert.equal(after.tasks[0]!.outcome, 'complete'); assert.deepEqual(after.tasks[0]!.usage, { ordinary: 1, checks: 1 });
  assert.equal(host.calls, 2); assert.equal(host.cancelled, 0); assert(after.room.archived);
});
When('用户向归档群发送新消息', async function (this: SpecWorld) {
  const { host } = state(this); assert.equal((await host.request(host.route() + '/messages', { id: 'next', text: '另一个工作' })).status, 200);
});
Then('新消息应沿用原路由且该群仍保持归档', async function (this: SpecWorld) {
  const { host } = state(this); const after = await archiveUntil(() => host.service.snapshot(host.first.id), value => value.tasks.length === 2 && value.tasks.at(-1)?.outcome === 'complete');
  assert.equal(after.tasks.at(-1)?.owner, 'A'); assert(after.room.archived); assert.equal(host.calls, 4);
});
Given('一个旧版本数据库和一个没有任务的群聊', async function (this: SpecWorld) {
  const host = new RoomArchiveFixture(); cases.set(this, { host }); await host.start(true); host.first = host.service.createRoom('空群');
});
When('归档空群并重启服务', async function (this: SpecWorld) { const { host } = state(this); await host.change(true, 'empty'); await host.restart(); });
Then('旧群默认属于普通列表且空群仍在归档列表中', function (this: SpecWorld) {
  const { host } = state(this); assert.equal(host.service.rooms().find(room => room.id === 'legacy')?.archived, false);
  const snapshot = host.service.snapshot(host.first.id); assert(snapshot.room.archived); assert.equal(snapshot.tasks.length, 0);
});
When('重复归档恢复并重放旧归档请求', async function (this: SpecWorld) {
  const { host } = state(this); await host.change(true, 'one'); await host.change(true, 'one'); await host.change(true, 'same-target');
  assert.equal(host.service.engine.roomArchive(host.first.id).archiveVersion, 1); await host.change(false, 'two'); await host.change(true, 'one');
});
Then('相同命令应至多提交一次且旧请求不得覆盖后续恢复', function (this: SpecWorld) {
  const { host } = state(this); assert.deepEqual(host.service.engine.roomArchive(host.first.id), { archived: false, archiveVersion: 2 }); host.assertHistory();
});
Then('不同内容复用请求标识应被拒绝且其他群不受影响', async function (this: SpecWorld) {
  const { host } = state(this); assert.equal((await host.change(false, 'one')).status, 409);
  assert.deepEqual(host.service.engine.roomArchive(host.second.id), { archived: false, archiveVersion: 0 });
});
When('发送{string}归档请求', async function (this: SpecWorld, problem: string) {
  const s = state(this), { host } = s; s.stored = host.readStored();
  const result = await host.request(host.route(problem === '群聊不存在' ? 'missing' : host.first.id) + '/archive',
    problem === '错误方法' ? undefined : problem === '缺少标识' ? {} : { id: problem === '空标识' ? '' : 'bad' },
    problem === '错误方法' ? 'GET' : 'POST', problem === '跨来源' ? 'https://example.org' : undefined);
  s.status = result.status; assert.equal(result.status, problem === '群聊不存在' ? 404 : problem === '错误方法' ? 405 : problem === '跨来源' ? 403 : 400);
});
Then('应拒绝请求且归档状态历史与预算均不变', function (this: SpecWorld) {
  const { host, stored } = state(this); assert.deepEqual(host.readStored(), stored); host.assertHistory();
});
When('归档事务在提交前发生存储故障', async function (this: SpecWorld) {
  const s = state(this); s.stored = s.host.readStored(); (s.host.service.engine.store as SqliteStore).failNextCommit = true;
  assert.equal((await s.host.change(true, 'fault')).status, 500);
});
Then('群聊状态与请求回执均应回滚且历史预算不变', function (this: SpecWorld) {
  const s = state(this); assert.deepEqual(s.host.readStored(), s.stored); s.host.assertHistory();
});
When('重新打开存储并重试同一归档请求', async function (this: SpecWorld) {
  const { host } = state(this); await host.restart(); assert.equal((await host.change(true, 'fault')).status, 200);
});
Then('应成功归档且只产生一个归档版本', function (this: SpecWorld) {
  const { host } = state(this); assert.deepEqual(host.service.engine.roomArchive(host.first.id), { archived: true, archiveVersion: 1 }); host.assertHistory();
});
Given('网页有两个群聊和当前群的未发送草稿', async function (this: SpecWorld) {
  const test = new RoomArchiveUIFixture(); pages.set(this, test); await test.open();
});
When('网页归档当前群聊且第一次请求失败', async function (this: SpecWorld) { await page(this).archive(); await page(this).failed(); });
Then('应显示错误并保留原群列表选择和草稿', function (this: SpecWorld) { page(this).assertFailed(); });
When('再次归档成功并打开已归档列表', async function (this: SpecWorld) { await page(this).archive(); await page(this).openArchived(); });
Then('应能查看原群历史及草稿并通过恢复入口回到普通列表', async function (this: SpecWorld) { await page(this).restore(); });
Given('群聊已经完成归档后又恢复', function (this: SpecWorld) {
  const host = new RoomArchiveFixture(); cases.set(this, { host, list: [{ id: 'one', title: '群', createdAt: 0, archived: false, archiveVersion: 2 }] });
});
When('归档前的列表和旧版本快照迟到', function (this: SpecWorld) {
  const s = state(this), original = s.list![0]!; s.list = mergeRooms(s.list!, [{ ...original, archiveVersion: 0 }, { ...original, archived: true, archiveVersion: 1 }]);
});
Then('网页应保留最新归档版本且群聊只属于一个列表', function (this: SpecWorld) {
  const { list } = state(this); assert.equal(list![0]!.archiveVersion, 2); assert.equal(roomList(list!, false).length, 1); assert.equal(roomList(list!, true).length, 0);
});
