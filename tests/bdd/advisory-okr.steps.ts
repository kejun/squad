import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter } from '../../src/model-adapter.js';
import type { DeliveryAcceptance } from '../../src/delivery-acceptance.js';
import type { RoomSnapshot } from '../../src/web/contracts.js';
import { createWebServer } from '../../src/web/http.js';
import { WebService } from '../../src/web/service.js';
import { intentConfig, parsedIntent } from '../input-intent-fixture.js';
import { modelResponse } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

const objective = { id: 'objective-1', action: 'objective', title: '缩短交付等待' } as const;
const result = { id: 'kr-1', action: 'keyResult', objectiveId: objective.id, title: '交付耗时降到 90 秒' } as const;
const link = { objective: objective.title, keyResult: result.title, keyResultId: result.id };
const task = { id: 'task-message', text: '写对照报告；保留出处；最后交付摘要。' };
const plan = parsedIntent('request', { objective: task.text, constraints: [], expectedOutputs: ['摘要'], acceptanceCriteria: ['保留出处'] });

class OkrFixture {
  directory = '';
  room = '';
  url = '';
  server: Server | undefined;
  service: WebService | undefined;
  readonly calls: { system: string; context: Record<string, unknown> }[] = [];
  readonly config = intentConfig();
  get database() { return join(this.directory, 'team.sqlite'); }

  async start() {
    const adapter = new OpenAICompatibleAdapter(this.config, { transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = request.messages[0]!.content;
      const { context } = JSON.parse(request.messages[1]!.content) as { context: Record<string, unknown> };
      this.calls.push({ system, context });
      if (system.includes('executing interpretation work')) return modelResponse({ type: 'interpretation', spec: plan });
      if (system.includes('executing check work')) return modelResponse({ type: 'check',
        criteriaResults: (context.requirements as DeliveryAcceptance['criteria']).map(({ id }) => ({ criterionId: id, status: 'passed' })) });
      assert.match(system, /executing owner work/);
      return modelResponse({ type: 'deliver', text: '已交付简短对照报告。', artifactIds: [] });
    } });
    this.service = new WebService(this.config, this.database, adapter);
    await this.service.ready();
    this.server = createWebServer(this.service);
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    if (this.server) {
      const closed = new Promise<void>(resolve => this.server!.close(() => resolve()));
      this.server.closeAllConnections();
      await closed;
      this.server = undefined;
    }
    await this.service?.close();
    this.service = undefined;
  }
  request(path: string, data?: object) {
    return fetch(`${this.url}/api${path}`, { signal: AbortSignal.timeout(2000), ...(data ? {
      method: 'POST', headers: { 'content-type': 'application/json', origin: this.url }, body: JSON.stringify(data),
    } : {}) });
  }
  async createRoom() {
    const response = await this.request('/rooms', {});
    assert.equal(response.status, 201);
    return (await response.json() as { id: string }).id;
  }
  async snapshot(): Promise<RoomSnapshot> {
    const response = await this.request(`/rooms/${this.room}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<RoomSnapshot>;
  }
  async change(data: object) {
    const response = await this.request(`/rooms/${this.room}/okr`, data);
    assert.equal(response.status, 200, await response.text());
  }
  async completed() {
    const deadline = Date.now() + 4000;
    do {
      const snapshot = await this.snapshot();
      const completed = snapshot.tasks.find(item => item.outcome === 'complete');
      if (completed) return { completed, snapshot };
      await delay(20);
    } while (Date.now() < deadline);
    assert.fail('预期任务应完成');
  }
}

const fixtures = new WeakMap<SpecWorld, OkrFixture>();
const fixture = (world: SpecWorld) => fixtures.get(world)!;
async function prepare(world: SpecWorld, seeded: boolean) {
  const run = new OkrFixture();
  fixtures.set(world, run);
  run.directory = await mkdtemp(join(tmpdir(), 'squad-okr-'));
  await run.start();
  run.room = await run.createRoom();
  if (seeded) { await run.change(objective); await run.change(result); }
}
After(async function (this: SpecWorld) {
  const run = fixtures.get(this);
  if (!run) return;
  try { await run.stop(); }
  finally { if (run.directory) await rm(run.directory, { recursive: true, force: true }); }
});

Given('一个尚无目标的群聊已打开', async function (this: SpecWorld) {
  await prepare(this, false);
  assert.equal((await fixture(this).snapshot()).objectives, undefined);
});
Given('群聊有一个待推进的关键结果', async function (this: SpecWorld) { await prepare(this, true); });
When('用户新增目标并为它添加一个关键结果', async function (this: SpecWorld) {
  const run = fixture(this);
  await run.change(objective);
  await run.change(result);
  await run.change(result);
});
Then('群聊应显示该目标及待推进的关键结果', async function (this: SpecWorld) {
  assert.deepEqual((await fixture(this).snapshot()).objectives, [
    { id: objective.id, title: objective.title, keyResults: [{ id: result.id, title: result.title, status: 'pending' }] },
  ]);
});
When('用户把关键结果标记为「进行中」并重启服务', async function (this: SpecWorld) {
  const run = fixture(this);
  const earlier = { id: 'status-old', action: 'status', keyResultId: result.id, status: 'pending' };
  await run.change(earlier);
  await run.change({ ...earlier, id: 'status-new', status: 'inProgress' });
  await run.stop();
  await run.start();
  await run.change(earlier);
});
Then('群聊应继续显示该关键结果为「进行中」', async function (this: SpecWorld) {
  assert.equal((await fixture(this).snapshot()).objectives?.[0]?.keyResults[0]?.status, 'inProgress');
});
When('用户选择该关键结果并发送一个新任务', async function (this: SpecWorld) {
  const run = fixture(this);
  const response = await run.request(`/rooms/${run.room}/messages`, { ...task, keyResultId: result.id });
  assert.equal(response.status, 200, await response.text());
  await run.completed();
});
Then('执行成员应收到目标及关键结果作为参考', function (this: SpecWorld) {
  const calls = fixture(this).calls;
  const owner = calls.find(call => call.system.includes('executing owner work'));
  const interpretation = calls.find(call => call.system.includes('executing interpretation work'));
  for (const call of [interpretation, owner]) {
    assert(call);
    assert.match(call.system, /as advisory background/);
    assert.deepEqual((call.context.goal as { okr: unknown }).okr, link);
  }
});
Then('核检只采用本次任务原有的验收判据', function (this: SpecWorld) {
  const check = fixture(this).calls.find(call => call.system.includes('executing check work'));
  assert(check);
  assert.deepEqual((check.context.requirements as DeliveryAcceptance['criteria']).map(item => item.text),
    [task.text, 'Answer the user request', '摘要', '保留出处']);
  assert(!JSON.stringify(check.context).includes(result.title));
});
Then('任务应正常完成并保留关联且关键结果仍待推进', async function (this: SpecWorld) {
  const run = fixture(this);
  const { completed, snapshot } = await run.completed();
  assert.deepEqual(completed.okr, link);
  assert.equal(snapshot.objectives?.[0]?.keyResults[0]?.status, 'pending');
  await run.stop();
  await run.start();
  assert.deepEqual((await run.snapshot()).tasks.find(item => item.id === completed.id)?.okr, link);
});
When('用户直接发送一条没有选择关键结果的新任务', async function (this: SpecWorld) {
  const run = fixture(this);
  const response = await run.request(`/rooms/${run.room}/messages`, task);
  assert.equal(response.status, 200, await response.text());
});
Then('任务应正常完成且没有关联', async function (this: SpecWorld) {
  assert.equal((await fixture(this).completed()).completed.okr, undefined);
});
When('用户在另一个群聊提交该关键结果的关联和状态变化', async function (this: SpecWorld) {
  const run = fixture(this);
  const other = await run.createRoom();
  const send = await run.request(`/rooms/${other}/messages`, { ...task, keyResultId: result.id });
  assert.equal(send.status, 404);
  const update = await run.request(`/rooms/${other}/okr`, { action: 'status', id: 'outside', keyResultId: result.id, status: 'achieved' });
  assert.equal(update.status, 404);
  const snapshot = await run.request(`/rooms/${other}`);
  assert.deepEqual((await snapshot.json() as RoomSnapshot).tasks, []);
});
Then('两个请求均应被拒绝且原群关键结果状态保持待推进', async function (this: SpecWorld) {
  assert.equal((await fixture(this).snapshot()).objectives?.[0]?.keyResults[0]?.status, 'pending');
});
When('用户归档并删除该群聊', async function (this: SpecWorld) {
  const run = fixture(this);
  const archive = await run.request(`/rooms/${run.room}/archive`, { id: 'archive' });
  assert.equal(archive.status, 200, await archive.text());
  const remove = await run.request(`/rooms/${run.room}/delete`, { id: 'delete' });
  assert.equal(remove.status, 202, await remove.text());
});
Then('已删除群聊的目标和关键结果应从存储清除', async function (this: SpecWorld) {
  const run = fixture(this);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = await run.request(`/rooms/${run.room}`);
    if (response.status === 410) break;
    await delay(20);
  }
  assert.equal((await run.request(`/rooms/${run.room}`)).status, 410);
  const db = new DatabaseSync(run.database, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT 1 FROM rooms WHERE id=?').get(run.room), undefined);
    assert.equal(db.prepare('SELECT 1 FROM receipts WHERE room_id=?').get(run.room), undefined);
  } finally { db.close(); }
});
