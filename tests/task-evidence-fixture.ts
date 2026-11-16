import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import type { CheckMaterials, CriterionJudgment } from '../src/delivery-acceptance.js';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import { SqliteStore } from '../src/store.js';
import type { Intent } from '../src/types.js';
import { LocalFixture, removeFixture } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { candidateJudgments } from './helpers.js';

export const evidenceCommand: LocalAction = { type: 'runCli', executable: 'node',
  args: ['-e', "process.stdout.write('真实正文🍀 host-model-secret')"] };
export const fixtureBody = '真实正文🍀 [redacted]';
const delivery = { type: 'answer', text: '以原始来源完成候选' };

const readAction = (sourceOperationId: string, cursor?: string): LocalAction => ({ type: 'readEvidence', sourceOperationId, stream: 'stdout',
  ...(cursor ? { cursor } : {}) });
const operations = (fixture: LocalFixture) => fixture.h.context().intents.flatMap(work => work.localOperations ?? []);
const readOperations = (fixture: LocalFixture) => operations(fixture).filter(item => item.action.type === 'readEvidence');
export const latestRead = (fixture: LocalFixture) => {
  const op = readOperations(fixture).at(-1);
  assert(op?.result);
  return op.result;
};

async function runPending(fixture: LocalFixture, ...outputs: unknown[]) {
  fixture.replies.push(...outputs);
  const current = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(item => item.kind !== 'cancel');
  assert(current);
  assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task, current.id));
  return current;
}

export async function acquireEvidence(fixture: LocalFixture, action = evidenceCommand) {
  const work = await runPending(fixture, action, delivery);
  const operation = operations(fixture).find(item => item.id.startsWith(work.id) && item.action.type === 'runCli');
  assert(operation?.result);
  const liveReceipt = fixture.requests.at(-1)?.messages.at(-1)?.content;
  assert(liveReceipt);
  assert.equal((JSON.parse(liveReceipt) as { operationId?: string }).operationId, operation.id);
  assert.equal(fixture.h.view().phase, 'checking');
  return operation;
}

function resumeExecution(fixture: LocalFixture) {
  if (fixture.h.engine.pending(fixture.h.room, fixture.h.task).some(work => work.kind === 'owner')) return;
  assert(fixture.h.event({ type: 'STOP' }).ok);
  assert(fixture.h.event({ type: 'CONTINUE' }).ok);
}

export async function readFromExecution(fixture: LocalFixture, sourceOperationId: string) {
  resumeExecution(fixture);
  const work = await runPending(fixture, readAction(sourceOperationId), delivery);
  assert.equal(work.kind, 'owner');
  return latestRead(fixture);
}

export async function checkEvidence(fixture: LocalFixture, finding?: Omit<Extract<CriterionJudgment, { reason: string }>, 'criterionId'>) {
  const candidate = fixture.h.context().candidate;
  const results = candidateJudgments(candidate, finding ? { index: 0, status: finding.status, reason: finding.reason } : undefined);
  if (finding?.source && results[0]) results[0].source = finding.source;
  const before = fixture.requests.length;
  const work = await runPending(fixture, { type: 'check', criteriaResults: results });
  assert.equal(work.kind, 'check');
  assert.equal(fixture.requests.length, before + 1);
  const body = JSON.parse(fixture.requests.at(-1)!.messages[1]!.content) as { context?: CheckMaterials } & CheckMaterials;
  return body.context ?? body;
}

export async function reviseEvidenceCandidate(fixture: LocalFixture) {
  assert.equal(fixture.h.context().outcome, 'complete');
  assert(fixture.h.context().candidate!.text.includes('未完成或未核实事项：\n- 候选误述证据出处'));
  assert(fixture.h.event({ type: 'CONTINUE' }).ok);
  assert.equal((await runPending(fixture, { ...delivery, text: '修正出处说明，保留原始来源' })).kind, 'owner');
  assert.equal(fixture.h.view().phase, 'checking');
}

export async function refreshEvidence(fixture: LocalFixture) {
  fixture.h.now = 50;
  assert(fixture.h.event({ type: 'USER_INPUT', text: '请重新获取同一资料并保留历史版本' }).ok);
  const operation = await acquireEvidence(fixture);
  assert.equal(fixture.backend.calls.length, 2);
  return operation;
}

export function seedMissingEvidence(fixture: LocalFixture, room = fixture.h.room, task = fixture.h.task): string {
  const owner = fixture.h.engine.pending(room, task).find(work => work.kind === 'owner');
  assert(owner);
  const work = fixture.h.engine.claim(room, task, owner.id)!;
  const op = fixture.h.engine.requestLocal(room, task, work.id, work.attempt, evidenceCommand, [], fixture.runtime.workspaceId(work));
  const claim = fixture.h.engine.claimLocal(room, task, work.id, op.id, work.attempt);
  assert(claim.response.ok);
  assert(fixture.h.engine.send(room, task, { type: 'LOCAL_RESULT', id: 'seed-missing-receipt', at: fixture.h.now,
    intentId: work.id, operationId: op.id, sessionId: claim.operation!.sessionId!,
    result: { ok: true, code: 'legacy-receipt', data: { exitCode: 0 } }, settled: true, effectsKnown: true }).ok);
  assert(fixture.h.engine.send(room, task, { type: 'DELIVER', id: 'seed-candidate', at: fixture.h.now, workId: work.id,
    fence: work, text: '保留旧回执', artifactIds: [] }).ok);
  return op.id;
}

export async function readTruncatedEvidence(fixture: LocalFixture, sourceOperationId: string) {
  resumeExecution(fixture);
  const adapter = new OpenAICompatibleAdapter(fixture.h.config, { clock: () => fixture.h.now, transport: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as LocalFixture['requests'][number];
    const receipt = request.messages.filter(message => message.role === 'user').map(message => {
      try { return JSON.parse(message.content) as LocalToolResult & { type?: string }; }
      catch { return undefined; }
    }).reverse().find(message => message?.type === 'local_tool_result');
    if (!receipt) return modelResponse(readAction(sourceOperationId));
    const data = receipt.data;
    return modelResponse(typeof data.nextCursor === 'string' ? readAction(sourceOperationId, data.nextCursor) : delivery);
  } });
  const runner = new WorkRunner(fixture.h.engine, adapter, () => fixture.h.now, globalThis.fetch, undefined, fixture.runtime);
  assert(await runner.runOne(fixture.h.room, fixture.h.task));
  return readOperations(fixture).map(item => item.result!);
}

export async function restartEvidenceRead(stage: 'claimed' | 'succeeded') {
  const fixture = await LocalFixture.create('方案师', true);
  let store = fixture.h.store;
  try {
    const source = await acquireEvidence(fixture);
    resumeExecution(fixture);
    const work = fixture.h.claim('owner');
    const action = readAction(source.id);
    const op = fixture.h.engine.requestLocal(fixture.h.room, fixture.h.task, work.id, work.attempt, action,
      [{ role: 'assistant', content: JSON.stringify(action) }]);
    const claim = fixture.h.engine.claimLocal(fixture.h.room, fixture.h.task, work.id, op.id, work.attempt);
    assert(claim.response.ok);
    const sessionId = claim.operation!.sessionId!;
    if (stage === 'succeeded') {
      assert(fixture.h.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId,
        result: { ok: true, code: 'EVIDENCE_PAGE', data: { text: fixtureBody } }, settled: true, effectsKnown: true }).ok);
    }
    const before = fixture.h.context().usage.ordinary;
    store.close();
    store = new SqliteStore(join(fixture.root, 'team.sqlite'));
    fixture.h.engine = new TeamEngine(store, fixture.h.config, () => fixture.h.now);
    fixture.h.engine.recover(fixture.h.room);
    if (stage === 'claimed') {
      const uncertain = readOperations(fixture).find(item => item.id === op.id)!;
      assert.equal(uncertain.status, 'uncertain');
      const reconciliation = await fixture.runtime.reconcile(uncertain);
      assert(reconciliation);
      assert(fixture.h.event({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: op.id, sessionId, ...reconciliation }).ok);
    }

    await runPending(fixture, delivery);

    assert.equal(fixture.h.context().usage.ordinary, before + 1, 'only the resumed model request spends ordinary budget');
    assert.equal(fixture.backend.calls.length, 1);
    assert.deepEqual(readOperations(fixture).map(item => [item.id, item.attempt]), [[op.id, stage === 'claimed' ? 2 : 1]]);
    assert.equal(latestRead(fixture).data.text, fixtureBody);
    assert(fixture.requests.at(-1)?.messages.some(message => message.content.includes(fixtureBody)));
  } finally {
    store.close();
    await fixture.runtime.close();
    await removeFixture(fixture.root);
  }
}

export function evidenceIndexInModel(fixture: LocalFixture): Record<string, unknown>[] {
  const contextMessage = fixture.requests.at(-1)?.messages.find(message => message.role === 'user'
    && typeof (JSON.parse(message.content) as { workId?: unknown }).workId === 'string')?.content;
  assert(contextMessage);
  return (JSON.parse(contextMessage) as { context: { evidenceIndex: Record<string, unknown>[] } }).context.evidenceIndex;
}

export function currentEvidenceReader(fixture: LocalFixture): Intent {
  const work = fixture.h.context().intents.find(item => item.localOperations?.some(op => op.action.type === 'readEvidence'));
  assert(work);
  return work;
}

export async function readHistoricalEvidence(fixture: LocalFixture, sourceOperationId: string) {
  assert(fixture.h.event({ type: 'STOP' }).ok);
  fixture.h.now = 50;
  assert(fixture.h.event({ type: 'CONTINUE' }).ok);
  await runPending(fixture, readAction(sourceOperationId), delivery);
  return latestRead(fixture);
}

export async function checkReadBoundary(fixture: LocalFixture, boundary: string) {
  const source = await acquireEvidence(fixture);
  resumeExecution(fixture);
  const work = fixture.h.claim('owner');
  const before = fixture.h.context().usage.ordinary;
  const op = fixture.h.engine.requestLocal(fixture.h.room, fixture.h.task, work.id, work.attempt, readAction(source.id), []);
  if (boundary === '领取前停止') {
    assert(fixture.h.event({ type: 'STOP' }).ok);
    assert.equal(readOperations(fixture)[0]?.status, 'cancelled');
  } else {
    const rejected = fixture.h.engine.claimLocal(fixture.h.room, fixture.h.task, work.id, op.id, work.attempt);
    assert.equal(rejected.response.code, 'BUDGET_EXHAUSTED');
  }
  assert.equal(fixture.h.context().usage.ordinary, before);
  assert.equal(fixture.backend.calls.length, 1);
}

export async function attemptUnassignedEvidence(fixture: LocalFixture) {
  const owner = await runPending(fixture, evidenceCommand, { type: 'help', target: 'B', question: '提供独立意见', expected: '结论', refs: [] });
  const source = operations(fixture).find(item => item.id.startsWith(owner.id) && item.action.type === 'runCli')!;
  await runPending(fixture, readAction(source.id), { type: 'answer', text: '分工没有授权该来源' });
  return latestRead(fixture);
}
