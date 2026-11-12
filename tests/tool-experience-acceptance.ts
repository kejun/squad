import assert from 'node:assert/strict';
import { LocalFixture } from './local-tools-fixture.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { sharedToolExperiences, type ToolExperience } from '../src/task/tool-experience.js';
import { toolKnowledgeModelGate } from './shared-tool-knowledge-model-fixture.js';

/** Real persisted runner and reopened runtime; the adapter records its public scope. */
export async function firstRoundToolExperience() {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    fixture.h.reopen();
    const options = fixture.runtime.options;
    await fixture.runtime.close();
    fixture.runtime = await LocalRuntime.create(options);
    fixture.replies.push({ type: 'askUser', question: '配方已观察，本次无需执行' });
    assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task));
    const received = experiencesIn(fixture.requests[0]!);
    assert(received.some(item => item.id === 'workspace-intermediates:v1'), 'Workspace recipe must precede any failed probe');
    assert(received.some(item => item.id === 'ocr-stdin:v1'), 'Conditional OCR recipe must precede any failed probe');
    assert.equal(fixture.backend.calls.length, 0, 'Knowledge observation does not execute commands');
    return received;
  } finally { await fixture.close(); }
}

function experiencesIn(request: LocalFixture['requests'][number]): ToolExperience[] {
  const message = request.messages.find(item => item.content.includes('"type":"shared_tool_experiences"'));
  assert(message, 'The actual first model request must contain actionable tool experiences');
  const parsed = JSON.parse(message.content) as { untrusted: boolean; experiences: ToolExperience[] };
  assert.equal(parsed.untrusted, true);
  assert(Array.isArray(parsed.experiences));
  return parsed.experiences;
}

export function currentActionableExperience(boundary = '成功') {
  let received: ToolExperience[] = [];
  toolKnowledgeModelGate(boundary, (context, peer) => { received = sharedToolExperiences(context, peer); });
  const resource = received.filter(item => item.evidence.kind === 'verified_resource_method');
  if (boundary === '成功') {
    assert.equal(resource.length, 1);
    assert.deepEqual(resource[0]!.condition.resourceScope, { kind: 'url_origin', origin: 'https://example.com',
      catalogVersion: 'v1', catalogOperationId: 'catalog' });
    assert.equal(resource[0]!.evidence.verificationLevel, 'resource_content');
  } else assert.deepEqual(resource, []);
  for (const item of received) {
    assert(item.condition.description.trim()); assert(item.action.description.trim()); assert(item.expectedResult.description.trim());
    assert.equal(item.expectedResult.provesCurrentResource, false); assert.equal(item.expectedResult.requiresVerification, true);
    assert.equal(item.executionAuthority, false); assert.equal(item.requiresIndependentExecution, true);
  }
  assert(!JSON.stringify(received).includes('原始资料正文'));
  return received;
}

export async function historicalToolExperience(boundary: string) {
  if (boundary === '多历史任务不放大读取') return (await historicalExperienceReadAmplification()).history;
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: [
    { command: 'node', description: 'Run workspace scripts', execution: 'sandbox' },
  ] } });
  try {
    fixture.runtime.options.redact = ['host-model-secret', 'private-source-key'];
    if (boundary === '未结算') {
      const work = fixture.h.claim('owner');
      fixture.h.engine.requestLocal(fixture.h.room, fixture.h.task, work.id, work.attempt,
        { type: 'discoverHost', commands: ['node'] }, []);
    } else {
      fixture.replies.push({ type: 'discoverHost', commands: ['node'] },
        ...(boundary === '重复能力快照' ? [{ type: 'discoverHost', commands: ['node'] }] : []),
        { type: 'askUser', question: '等待新的任务' });
      await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    }
    assert(fixture.h.event({ type: 'STOP' }).ok);
    if (boundary === '未结算') {
      const original = fixture.h.context().intents.find(work => work.kind === 'owner')!;
      assert(fixture.h.engine.executionNotStarted(fixture.h.room, fixture.h.task, original, 'Fixture never began the queued discovery').ok);
    }
    if (boundary === '配置变化') fixture.h.config.toolVersion = 'new-tools';
    if (boundary === '工具目录变化') {
      fixture.runtime.options.cliCatalog = [{ command: 'node', description: 'Changed workspace script protocol', execution: 'sandbox' }];
      await fixture.runtime.refreshToolInventory();
    }
    if (boundary === '其他会话') fixture.h.room = 'another-room';
    const result = fixture.h.engine.submit(fixture.h.room, { id: 'new-experience-task', text: '使用当前可用的工具', intent: 'new' });
    assert(result.ok && result.taskId, JSON.stringify(result)); fixture.h.task = result.taskId;
    fixture.h.reopen();
    fixture.requests.length = 0;
    fixture.replies.push({ type: 'askUser', question: '已观察经验' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const values = experiencesIn(fixture.requests[0]!);
    const history = values.filter(item => item.id.startsWith('history:'));
    assert.equal(history.length > 0, ['同会话同配置同能力', '重复能力快照'].includes(boundary), 'Only matching same-room durable capability receipts may transfer');
    if (boundary === '重复能力快照') {
      assert.equal(history.length, 1); assert.equal(history[0]!.evidence.sources!.length, 2);
      assert.notEqual(history[0]!.evidence.sources![0]!.sourceOperationId, history[0]!.evidence.sources![1]!.sourceOperationId);
    }
    for (const item of history) {
      const cli = item.action.observation!.cli as { catalog: { entries?: unknown } };
      assert.equal(cli.catalog.entries, undefined, 'Complete CLI entries are already present once in tool_inventory');
      assert.equal(item.action.metadataReference!.cliMatchesCurrent, true);
    }
    assert(!JSON.stringify(values).includes('private-source-key'));
    assert(values.every(item => item.expectedResult.provesCurrentResource === false));
    return history;
  } finally { await fixture.close(); }
}

/** Compare the whole persisted runner request, not a private getter or an engine call sequence. */
export async function historicalExperienceReadAmplification() {
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: [
    { command: 'node', description: 'Run workspace scripts', execution: 'sandbox' },
  ] } });
  const submit = (id: string) => {
    const result = fixture.h.engine.submit(fixture.h.room, { id, text: '使用当前可用的工具', intent: 'new' });
    assert(result.ok && result.taskId, JSON.stringify(result)); fixture.h.task = result.taskId;
  };
  const recordCapability = async () => {
    fixture.replies.push({ type: 'discoverHost', commands: ['node'] }, { type: 'askUser', question: '等待新的任务' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    assert(fixture.h.event({ type: 'STOP' }).ok);
  };
  const request = async (id: string) => {
    submit(id); fixture.requests.length = 0;
    fixture.replies.push({ type: 'askUser', question: '已观察经验' });
    const store = fixture.h.store, original = store.read;
    let reads = 0;
    store.read = function (roomId) { if (roomId === fixture.h.room) reads++; return original.call(this, roomId); };
    try { await fixture.runner().runOne(fixture.h.room, fixture.h.task); }
    finally { store.read = original; }
    const history = experiencesIn(fixture.requests[0]!).filter(item => item.id.startsWith('history:'));
    assert(fixture.h.event({ type: 'STOP' }).ok);
    return { reads, history };
  };
  try {
    await recordCapability();
    const small = await request('single-history-request');
    for (let index = 0; index < 7; index++) { submit(`additional-history-${index}`); await recordCapability(); }
    const large = await request('many-history-request');
    assert(large.reads <= small.reads, `Historical task count must not amplify full-room reads per model request: ${small.reads} -> ${large.reads}`);
    assert.equal(large.history.length, 1);
    assert.equal(large.history[0]!.evidence.sources!.length, 8, 'Batch reading must retain every distinct source operation');
    return { baselineReads: small.reads, manyHistoryReads: large.reads, history: large.history };
  } finally { await fixture.close(); }
}
