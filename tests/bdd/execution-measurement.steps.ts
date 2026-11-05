import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter } from '../../src/model-adapter.js';
import { WorkRunner } from '../../src/runner.js';
import { coveredDuration, type ExecutionObservation } from '../../src/measurement.js';
import { WebService } from '../../src/web/service.js';
import { Harness } from '../helpers.js';
import { hostUntil } from '../host-approval-fixture.js';
import { LocalFixture, localConfig } from '../local-tools-fixture.js';
import { badModelOutput, goodModelOutput, modelResponse, regenerationConfig } from '../model-regeneration-fixture.js';
import type { SpecWorld } from './steps.js';

interface MeasurementState {
  records: ExecutionObservation[];
  harness?: Harness;
  runner?: WorkRunner;
  local?: LocalFixture;
  coveredMs?: number;
  service?: WebService;
  directory?: string;
  database?: DatabaseSync;
  taskId?: string;
  roomId?: string;
  modelCalls?: number;
}

const states = new WeakMap<SpecWorld, MeasurementState>();
const state = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };

After(async function (this: SpecWorld) {
  const s = states.get(this);
  if (!s) return;
  try { await s.local?.close(); await s.service?.close(); }
  finally {
    s.database?.close();
    s.harness?.store.close();
    if (s.directory) rmSync(s.directory, { recursive: true, force: true });
    states.delete(this);
  }
});

Given('执行记录包含已获额度、传输失败、格式失败和结果提交', function (this: SpecWorld) {
  const h = new Harness(regenerationConfig({ retries: 2 }));
  const records: ExecutionObservation[] = [];
  let request = 0;
  const adapter = new OpenAICompatibleAdapter(h.config, {
    clock: () => h.now,
    transport: async () => {
      request++;
      if (request === 1) throw new Error('私有供应商错误正文');
      return modelResponse(request === 2 ? badModelOutput('空答案') : goodModelOutput('owner'));
    },
  });
  const runner = new WorkRunner(h.engine, adapter, () => h.now, undefined, undefined, undefined, (_context, event) => records.push(event));
  states.set(this, { records, harness: h, runner });
});

When('我检查任务的执行观测记录', async function (this: SpecWorld) {
  const s = state(this);
  await s.runner!.runOne(s.harness!.room, s.harness!.task);
  await s.runner!.runOne(s.harness!.room, s.harness!.task);
});

Then('额度授权、客户端传输、协议和结果采纳应分别统计', function (this: SpecWorld) {
  const records = state(this).records;
  const phases = records.map(event => event.phase);
  assert.equal(phases.filter(phase => phase === 'budget.authorized').length, 3);
  assert.equal(phases.filter(phase => phase === 'model.transport').length, 3);
  assert.equal(phases.filter(phase => phase === 'model.transportFailed').length, 1);
  assert.equal(phases.filter(phase => phase === 'model.response').length, 2);
  assert.deepEqual(records.flatMap(event => event.phase === 'model.protocol' ? [event.valid] : []), [false, true]);
  assert.deepEqual(records.flatMap(event => event.phase === 'work.result' && event.requestId !== null ? [event.accepted] : []), [true]);
  assert(!JSON.stringify(records).includes('私有供应商错误正文'));
});

Then('缺少实际用量的请求应标为未知', function (this: SpecWorld) {
  const usage = state(this).records.flatMap(event => event.phase === 'model.usage' ? [event.usage] : []);
  assert.deepEqual(usage, [{ input: null, output: null, total: null }, { input: null, output: null, total: null }]);
});

Given('两个已结束的观测区间部分重叠并且随后读回原操作回执', async function (this: SpecWorld) {
  const local = await LocalFixture.create();
  const records: ExecutionObservation[] = [];
  states.set(this, { records, local });
  const { h } = local;
  const runner = new WorkRunner(h.engine, {
    execute: async (_work, signal, scope) => {
      const tools = scope.localTools!;
      let operationId: string | undefined;
      const original = await tools.invoke({ type: 'runCli', executable: process.execPath, args: ['-e', 'console.log("evidence")'] },
        [], signal, id => { operationId = id; });
      assert(original.ok);
      assert(operationId);
      assert.deepEqual(await tools.resume(operationId, signal), original);
      return { type: 'answer', text: '已核对原回执' };
    },
  }, () => h.now, undefined, undefined, local.runtime, (_context, event) => records.push(event));
  await runner.runOne(h.room, h.task);
});

When('我计算这些区间实际覆盖的耗时', function (this: SpecWorld) {
  state(this).coveredMs = coveredDuration([[0, 30], [10, 40]]);
});

Then('重叠时段只计一次', function (this: SpecWorld) {
  assert.equal(state(this).coveredMs, 40);
});

Then('原操作回执的读取不计为新进程', function (this: SpecWorld) {
  const s = state(this);
  assert.equal(s.local!.backend.calls.length, 1);
  const started = s.records.find(event => event.phase === 'local.processStarted');
  const finished = s.records.find(event => event.phase === 'local.processFinished');
  const reused = s.records.find(event => event.phase === 'local.receiptRead');
  assert(started && finished && reused && 'operationId' in started && 'operationId' in finished && 'operationId' in reused);
  assert.equal(started.operationId, finished.operationId);
  assert.equal(started.operationId, reused.operationId);
  assert.equal(s.records.filter(event => event.phase === 'local.processStarted').length, 1);
});

Given('执行观测存储不可用', function (this: SpecWorld) {
  const directory = mkdtempSync(join(tmpdir(), 'squad-observation-'));
  const s: MeasurementState = { records: [], directory, modelCalls: 0 };
  states.set(this, s);
  const file = join(directory, 'team.sqlite');
  const config = localConfig();
  const adapter = new OpenAICompatibleAdapter(config, { transport: async () => {
    s.modelCalls!++;
    return modelResponse(s.modelCalls === 1 ? goodModelOutput('owner') : goodModelOutput('check'));
  } });
  s.service = new WebService(config, file, adapter);
  s.database = new DatabaseSync(file);
  s.database.exec(`CREATE TRIGGER unavailable_measurement BEFORE INSERT ON web_events WHEN new.kind = 'measurement'
    BEGIN SELECT RAISE(ABORT, 'controlled observation failure'); END;`);
  s.roomId = s.service.createRoom('观测故障测试').id;
});

When('一个已获准的模型请求正常返回', async function (this: SpecWorld) {
  const s = state(this);
  s.taskId = s.service!.submit(s.roomId!, { id: 'measurement-failure', text: '生成一份完整方案' }).taskId!;
  await hostUntil(() => s.service!.engine.view(s.roomId!, s.taskId)?.context.outcome, outcome => outcome === 'complete');
});

Then('任务应接收并只处理一次合法结果', function (this: SpecWorld) {
  const s = state(this);
  assert.equal(s.modelCalls, 2);
  const context = s.service!.engine.view(s.roomId!, s.taskId)!.context;
  assert.equal(context.outcome, 'complete');
  assert.equal(context.trace.filter(entry => entry.event === 'CHECK_RESULT').length, 1);
  assert.equal(s.database!.prepare("SELECT count(*) AS count FROM web_events WHERE kind = 'measurement'").get()?.count, 0);
});
