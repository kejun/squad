import assert from 'node:assert/strict';
import { WorkRunner } from '../src/runner.js';
import { LocalFixture, unavailableNativeSandbox } from './local-tools-fixture.js';
import { MapCapacityFixture, documentUrls, groupedIntent } from './map-capacity-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { hostUntil } from './host-approval-fixture.js';

export async function capabilityFactAcceptance(discovery: string) {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    fixture.replies.push(discovery === '技能目录' ? { type: 'listSkills' } : { type: 'discoverHost', commands: ['node'] },
      { type: 'help', requestId: 'peer-source', target: 'B', question: '独立读取另一份资料', expected: '真实读取回执' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const owner = fixture.h.context().intents.find(work => work.kind === 'owner')!;
    const original = owner.localOperations![0]!;
    const peer = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(work => work.kind === 'assistance')!;
    fixture.replies.push({ type: 'runCli', executable: 'node', args: ['-e', 'console.log("independent-source")'] },
      { type: 'answer', text: '独立来源读取完成', status: 'success' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task, peer.id);
    const request = fixture.requests[2]!;
    const knowledge = request.messages.find(message => message.content.includes('"type":"shared_tool_knowledge"'));
    assert(knowledge);
    const data = JSON.parse(knowledge.content) as { methods: { sourceOperationId: string; observation: Record<string, unknown>; observationOnly: boolean }[] };
    assert.equal(data.methods[0]!.sourceOperationId, original.id); assert.equal(data.methods[0]!.observationOnly, true);
    assert(discovery === '技能目录' ? data.methods[0]!.observation.skills : data.methods[0]!.observation.cli);
    assert(request.messages[0]!.content.includes('Reuse verified discovery and skill-catalog metadata'));
    const completed = fixture.h.context().intents.find(work => work.id === peer.id)!;
    assert.deepEqual(completed.localOperations!.map(operation => operation.action.type), ['runCli']);
    assert.equal(completed.localOperations![0]!.result!.data.stdout, 'independent-source\n');
    assert.equal(fixture.backend.calls.length, 1);
    assert.notEqual(completed.localOperations![0]!.id, original.id);
    return data.methods;
  } finally { await fixture.close(); }
}

export async function sandboxFactAcceptance() {
  const fixture = await LocalFixture.create('方案师', true, false, { backend: await unavailableNativeSandbox() });
  try {
    fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'] },
      { type: 'help', requestId: 'peer-source', target: 'B', question: '核查可用执行环境', expected: '真实执行' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const original = fixture.h.context().intents.find(work => work.kind === 'owner')!.localOperations![0]!;
    assert.equal(original.result!.code, 'CLI_SANDBOX_UNAVAILABLE');
    const peer = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(work => work.kind === 'assistance')!;
    fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'], execution: 'host', reason: '沙箱不可用，需核查运行时版本' });
    const running = fixture.runner().runOne(fixture.h.room, fixture.h.task, peer.id);
    const operation = await hostUntil(() => fixture.h.context().intents.find(work => work.id === peer.id)!.localOperations?.[0],
      operation => operation?.status === 'awaitingApproval');
    assert(operation);
    const request = fixture.requests[2]!;
    const knowledge = request.messages.find(message => message.content.includes('"type":"shared_tool_knowledge"'));
    assert(knowledge); assert(knowledge.content.includes(original.id));
    assert(knowledge.content.includes('"sandbox":{"available":false}')); assert(!knowledge.content.includes('stdout'));
    assert.equal(operation.status, 'awaitingApproval'); assert.equal(operation.approval!.status, 'pending');
    assert.equal(fixture.backend.calls.length, 0);
    fixture.replies.push({ type: 'answer', text: '宿主审批未获批准，保留未执行范围', status: 'partial' });
    assert(fixture.h.event({ type: 'LOCAL_APPROVAL_DECISION', intentId: peer.id, operationId: operation.id,
      approvalId: operation.approval!.id, decision: 'deny', fence: peer }).ok);
    fixture.runtime.notifyWorkspace(`approval:${operation.id}`); await running;
    return { operation, knowledge: knowledge.content };
  } finally { await fixture.close(); }
}

export async function fullPartitionAcceptance(capacity: number) {
  const fixture = new MapCapacityFixture();
  fixture.config.limits.assists = capacity;
  const originalReply = fixture.response!;
  fixture.response = request => request.kind === 'interpretation'
    ? modelResponse({ type: 'interpretation', spec: groupedIntent(capacity) }) : originalReply(request);
  let peak = 0;
  const originalBefore = fixture.beforeResponse;
  fixture.beforeResponse = request => {
    originalBefore?.(request);
    peak = Math.max(peak, fixture.context().intents.filter(work => work.kind === 'assistance' && work.status === 'inflight').length);
  };
  try {
    await fixture.recognize();
    const request = fixture.requests[0]!;
    assert.equal(request.context.maxPartitions, capacity); assert.equal(request.context.maxConcurrentPartitions, 4);
    const prompt = request.messages[0]!.content;
    assert(prompt.includes('min(independent source count, context.maxPartitions)'));
    assert(prompt.includes('explicit semantic reason'));
    const plan = fixture.context().inputAnalyses![0]!.spec!.decomposition!;
    assert.equal(plan.partitions.length, capacity);
    const sources = plan.partitions.flatMap(part => part.objective.match(/https:\/\/docs\.fixture\.example\/doc-\d\.md/g) ?? []);
    assert.deepEqual(sources.sort(), [...documentUrls].sort());
    while (fixture.pending('assistance').length) await Promise.all(fixture.pending('assistance').map(work =>
      new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, fixture.sourceTools).runOne(fixture.room, fixture.task, work.id)));
    assert.equal(peak, 4); assert.deepEqual([...fixture.documentReads].sort(), [...documentUrls].sort());
    assert.equal(fixture.pending('discussionSummary').length, 1); assert.equal(await fixture.run(), true);
    assert.equal(fixture.requests.filter(item => item.kind === 'discussionSummary').length, 1);
    assert.equal(fixture.context().discussion!.results.length, capacity);
    return { capacity, peak, plan, sources };
  } finally { fixture.close(); }
}
