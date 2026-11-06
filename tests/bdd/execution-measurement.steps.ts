import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { After, Given, Then, When, type DataTable } from '@cucumber/cucumber';
import { OpenAICompatibleAdapter } from '../../src/model-adapter.js';
import { WorkRunner } from '../../src/runner.js';
import { coveredDuration, type ExecutionObservation, type MeasurementRecord } from '../../src/measurement.js';
import { summarizeMeasurements } from '../../src/measurement-report.js';
import { WebService } from '../../src/web/service.js';
import { fixtureCheck, withFixtureAcceptance } from '../delivery-protocol-fixture.js';
import { Harness } from '../helpers.js';
import { hostUntil } from '../host-approval-fixture.js';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { LocalFixture, localConfig } from '../local-tools-fixture.js';
import { badModelOutput, goodModelOutput, modelResponse, regenerationConfig } from '../model-regeneration-fixture.js';
import { evidenceCommand } from '../task-evidence-fixture.js';
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
  timingRecords?: MeasurementRecord[];
  timingSummary?: ReturnType<typeof summarizeMeasurements>;
  retry?: HostRetryFixture;
  retrySourceId?: string;
  evidenceSourceId?: string;
  retryRecords?: ExecutionObservation[];
  intervals?: readonly (readonly [number, number])[];
}

const states = new WeakMap<SpecWorld, MeasurementState>();
const state = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };

After(async function (this: SpecWorld) {
  const s = states.get(this);
  if (!s) return;
  try { await s.local?.close(); await s.service?.close(); await s.retry?.close(); }
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
      const output = request === 2 ? badModelOutput('空答案') : goodModelOutput('owner');
      const body = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        ...(request === 2 ? { usage: { prompt_tokens: 0, completion_tokens: 42, total_tokens: 'unknown' } } : {}) };
      return Response.json(body);
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
  assert.deepEqual(usage[1], { input: null, output: null, total: null });
});

Then('实际报告为零的输入用量应保留为零且无效总量仍标为未知', function (this: SpecWorld) {
  const usage = state(this).records.flatMap(event => event.phase === 'model.usage' ? [event.usage] : []);
  assert.equal(usage.length, 2); assert.deepEqual(usage[0], { input: 0, output: 42, total: null });
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
  const s = state(this); s.coveredMs = coveredDuration(s.intervals ?? [[0, 30], [10, 40]]);
});

Then('重叠时段只计一次', function (this: SpecWorld) {
  assert.equal(state(this).coveredMs, 40);
});

Given('已结束的观测区间按以下顺序到达', function (this: SpecWorld, table: DataTable) {
  states.set(this, { records: [], intervals: table.hashes().map(row => [Number(row.开始), Number(row.结束)] as const) });
});
Then('重叠与分离的全部时段合计应为{int}', function (this: SpecWorld, expected: number) { assert.equal(state(this).coveredMs, expected); });

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
  const adapter = new OpenAICompatibleAdapter(config, { transport: async (_url, init) => {
    s.modelCalls!++;
    return modelResponse(withFixtureAcceptance(s.modelCalls === 1 ? goodModelOutput('owner') : goodModelOutput('check'), init?.body));
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

function measurementRecord(runId: string, monotonicMs: number, observation: ExecutionObservation): MeasurementRecord {
  return {
    roomId: 'test-room', taskId: 'test-task', workId: 'test-work', agentId: 'A', epoch: 1, goalVersion: 1, attempt: 1,
    run: { runId, commit: null, dirty: null, dataset: 'fixed-clock', executionVersion: 'fixture', toolVersion: 'fixture',
      timezone: 'UTC', configDigest: 'fixture', measurementVersion: 1 },
    at: (runId === 'first-run' ? 1000 : 2000) + monotonicMs,
    monotonicMs, observation,
  };
}

Given('模型传输与人工决定等待在同一次运行中重叠', function (this: SpecWorld) {
  const operation = { operationId: 'test-operation', action: 'runCli', approvalId: 'test-approval' };
  const timingRecords = [
    measurementRecord('first-run', 0, { phase: 'model.transport', requestId: 'request-1', serviceId: 'fixture', model: 'fixture' }),
    measurementRecord('first-run', 10, { phase: 'local.approvalRequired', ...operation, sessionApproved: false }),
    measurementRecord('first-run', 30, { phase: 'model.responseBody', requestId: 'request-1', durationMs: 30 }),
    measurementRecord('first-run', 40, { phase: 'local.approvalDecision', ...operation, decisionId: 'decision-1', decision: 'approve' }),
  ];
  states.set(this, { records: [], timingRecords });
});

Given('重启时另一个请求只保留开始和结束各一端', function (this: SpecWorld) {
  state(this).timingRecords!.push(
    measurementRecord('first-run', 60, { phase: 'model.transport', requestId: 'request-2', serviceId: 'fixture', model: 'fixture' }),
    measurementRecord('second-run', 10, { phase: 'model.responseBody', requestId: 'request-2', durationMs: 10 }),
  );
});

When('我汇总两次运行的观测时段', function (this: SpecWorld) {
  const s = state(this);
  s.timingSummary = summarizeMeasurements(s.timingRecords!);
});

Then('应按阶段列出完整区间和缺失端点', function (this: SpecWorld) {
  const [first, second] = state(this).timingSummary!;
  assert.deepEqual(first?.durations.modelTransport, { coveredMs: 30, complete: 1, missingStart: 0, missingEnd: 1 });
  assert.deepEqual(first?.durations.humanDecision, { coveredMs: 30, complete: 1, missingStart: 0, missingEnd: 0 });
  assert.deepEqual(second?.durations.modelTransport, { coveredMs: null, complete: 0, missingStart: 1, missingEnd: 0 });
});

Then('同一次运行的观测并集只覆盖一次已知时段', function (this: SpecWorld) {
  const [first, second] = state(this).timingSummary!;
  assert.equal(first?.observedWindowMs, 60);
  assert.equal(first?.observedIntervalUnionMs, 40);
  assert.equal(first?.unclassifiedInWindowMs, 20);
  assert.equal(second?.observedWindowMs, null);
  assert.equal(second?.observedIntervalUnionMs, null);
  assert.equal(second?.unclassifiedInWindowMs, null);
});

Given('任务读取原回执并处理已接受的宿主续办与交付检查', async function (this: SpecWorld) {
  const s: MeasurementState = { records: [] }; states.set(this, s);
  const local = await LocalFixture.create(); s.local = local;
  const { h } = local;
  assert(h.event({ type: 'USER_INPUT', text: '必须交付一份报告', goal: { ...h.context().goal, requiredArtifacts: 1 } }).ok);
  const runner = new WorkRunner(h.engine, {
    execute: async (work, signal, scope) => {
      if (work.kind === 'check') return fixtureCheck(work.payload.candidate);
      const tools = scope.localTools!;
      if (!s.evidenceSourceId) {
        const result = await tools.invoke(evidenceCommand, [], signal, id => { s.evidenceSourceId = id; });
        assert(result.ok);
        return { type: 'deliver', text: '暂未附报告', artifactIds: [] };
      }
      const read = await tools.invoke({ type: 'readEvidence', sourceOperationId: s.evidenceSourceId, stream: 'stdout' }, [], signal);
      assert(read.ok);
      return { type: 'deliver', text: '已核验来源并附报告', artifactIds: [], artifacts: [{ name: 'sources.md', content: '真实正文' }] };
    },
  }, () => h.now, undefined, undefined, local.runtime, (_context, event) => s.records.push(event));
  for (let i = 0; i < 3; i++) assert(await runner.runOne(h.room, h.task));
  assert.equal(h.context().outcome, 'complete');
  const retry = new HostRetryFixture(); s.retry = retry;
  await retry.pauseAfterTwoFailures();
  const request = retry.retryData(); s.retrySourceId = request.operationId;
  assert.equal((await retry.requestRetry(request)).status, 200);
  assert.equal((await retry.requestRetry(request)).status, 200);
  retry.hostCommands = 1;
  retry.resumeMain();
  const approval = await retry.approval();
  assert.equal((await retry.request(retry.decisionData(approval, 'approve'))).status, 200);
  assert.equal((await retry.complete()).tasks.at(-1)?.outcome, 'complete');
});

When('我核对观测中的业务关联', function (this: SpecWorld) {
  const s = state(this), retry = s.retry!;
  const db = new DatabaseSync(join(retry.root, 'team.sqlite'), { readOnly: true });
  try {
    s.retryRecords = db.prepare("SELECT detail FROM web_events WHERE taskId = ? AND kind = 'measurement' ORDER BY id").all(retry.taskId)
      .map(row => (JSON.parse(String(row.detail)) as MeasurementRecord).observation);
  } finally { db.close(); }
});

Then('应能由证据读取追溯原操作并由宿主执行追溯续办请求', function (this: SpecWorld) {
  const s = state(this);
  const evidence = s.records.find(event => event.phase === 'local.receiptRead' && event.readKind === 'evidencePage');
  assert(evidence?.phase === 'local.receiptRead');
  assert.equal(evidence.sourceOperationId, s.evidenceSourceId);
  assert.notEqual(evidence.operationId, evidence.sourceOperationId);
  assert.equal(s.records.filter(event => event.phase === 'local.processStarted').length, 1);
  const requests = s.retryRecords!.filter(event => event.phase === 'local.retryQueued');
  const [request] = requests;
  assert.equal(requests.length, 1);
  assert.equal(request!.sourceOperationId, s.retrySourceId);
  const process = s.retryRecords!.find(event => event.phase === 'local.processStarted' && event.retryRequestId === request!.retryRequestId);
  assert(process && 'operationId' in process && process.batchId);
  assert.notEqual(process.operationId, request!.sourceOperationId);
});

Then('交付观测应区分预检缺口、候选检查和最终发布', function (this: SpecWorld) {
  const s = state(this), records = s.records;
  const preflight = records.find(event => event.phase === 'delivery.preflightRejected');
  const checked = records.find(event => event.phase === 'delivery.checked');
  const published = records.find(event => event.phase === 'delivery.published');
  assert(preflight && checked && published?.phase === 'delivery.published');
  assert(preflight.gaps.some(gap => gap.criterionId === null && gap.kind === 'missing_requirement'));
  assert.notEqual(preflight.candidateRevision, checked.candidateRevision);
  assert.equal(checked.candidateRevision, published.candidateRevision);
  assert.equal(checked.passed, true);
  assert(checked.judgments.length && checked.judgments.every(item => item.status === 'passed'));
  assert(!JSON.stringify(records).includes('真实正文'));
});
