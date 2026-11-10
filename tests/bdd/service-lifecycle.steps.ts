import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { WebService } from '../../src/web/service.js';
import { LocalRuntime } from '../../src/local-runtime.js';
import { createTeamConfig } from '../../team.config.js';
import { verifyServiceLifecycleModel } from '../service-lifecycle-model-fixture.js';
import type { SpecWorld } from './steps.js';

class LifecycleFixture {
  root = '';
  service!: WebService;
  room = '';
  calls = 0;
  reconciliations = 0;
  readonly config = createTeamConfig({});
  readonly failure = new Error('ControlledRecoveryFailure');
  readonly adapter = { execute: async () => { this.calls++; throw new Error('Unexpected model call'); } };
  constructor() { this.config.inputAnalysis = { enabled: false }; }
  async prepare(failed: boolean) {
    verifyServiceLifecycleModel();
    this.root = await mkdtemp(join(tmpdir(), 'squad-service-lifecycle-'));
    const path = join(this.root, 'service.sqlite');
    this.service = new WebService(this.config, path, this.adapter);
    await this.service.ready();
    this.room = this.service.createRoom().id;
    if (!failed) return;
    const engine = this.service.engine;
    const task = engine.submit(this.room, { id: 'seed', text: '核对未决操作' }).taskId!;
    const work = engine.claim(this.room, task, engine.pending(this.room, task)[0]!.id)!;
    const op = engine.requestLocal(this.room, task, work.id, work.attempt,
      { type: 'runCli', executable: 'node', args: ['-e', '0'] }, [], 'lifecycle-workspace');
    const claimed = engine.claimLocal(this.room, task, work.id, op.id, work.attempt);
    assert(claimed.response.ok && claimed.operation?.sessionId);
    assert(engine.send(this.room, task, { type: 'LOCAL_STARTED', id: 'started', at: Date.now(), intentId: work.id,
      operationId: op.id, sessionId: claimed.operation.sessionId, workspaceRevision: 'controlled', isolated: false }).ok);
    await this.service.close();
    await mkdir(join(this.root, 'source'));
    const runtime = await LocalRuntime.create({ dataRoot: join(this.root, 'runtime'), workspaceRoot: join(this.root, 'source'), skillRoots: [],
      backend: { available: false, async execute() { assert.fail('No command may start'); } } });
    runtime.reconcile = async () => { this.reconciliations++; throw this.failure; };
    this.service = new WebService(this.config, path, this.adapter, undefined, false, runtime);
    // Attach the rejection observer in the same turn as startup.
    await assert.rejects(this.service.ready(), error => error === this.failure);
  }
  assertClosed() {
    assert.throws(() => this.service.rooms(), /not open/);
    assert.throws(() => this.service.engine.store.read(this.room), /not open/);
  }
  async cleanup() { await this.service?.close().catch(() => {}); if (this.root) await rm(this.root, { recursive: true, force: true }); }
}
const runs = new WeakMap<SpecWorld, LifecycleFixture>();
async function prepare(world: SpecWorld, failed: boolean) {
  const f = new LifecycleFixture(); runs.set(world, f); await f.prepare(failed);
}
Given('服务恢复未决本地操作时核对失败', async function (this: SpecWorld) { await prepare(this, true); });
When('用户读取启动结果并关闭失败服务', async function (this: SpecWorld) { await runs.get(this)!.service.close(); });
Then('启动应报告原始错误而关闭应释放两个数据库连接', function (this: SpecWorld) { runs.get(this)!.assertClosed(); });
Then('失败服务不得启动模型或下一条核对', function (this: SpecWorld) {
  assert.equal(runs.get(this)!.calls, 0); assert.equal(runs.get(this)!.reconciliations, 1);
});
Given('服务已就绪且没有在途工作', async function (this: SpecWorld) { await prepare(this, false); });
When('多个调用方同时关闭并在完成后再次关闭', async function (this: SpecWorld) {
  const service = runs.get(this)!.service, first = service.close(), second = service.close();
  // Observe both rejections even on the pre-fix implementation.
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'fulfilled']);
  assert.equal(first, second);
  assert.equal(service.close(), first);
  await service.close();
});
Then('所有关闭调用应共享同一个成功结果且不重复关闭数据库', function (this: SpecWorld) { runs.get(this)!.assertClosed(); });
After(async function (this: SpecWorld) { await runs.get(this)?.cleanup(); runs.delete(this); });
