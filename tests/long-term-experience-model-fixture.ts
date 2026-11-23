import assert from 'node:assert/strict';
import { mapConfigurationKey } from '../src/task/map-scheduling.js';
import { partitionContract, type LearnedReadRoute } from '../src/task/execution-memory.js';
import { missingResourceAcquisitions } from '../src/resource-acquisition.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import { partitionUrls, ResilientPartitionModel } from './partition-resilience-model-fixture.js';

export function modelReadRoute(config: { version: string; toolVersion: string }): LearnedReadRoute {
  return { pattern: { urlPrefix: 'https://docs.example.com/', executable: 'node', execution: 'sandbox',
    verifier: { id: 'fixture-reader', version: '1' }, binding: 'fixture-binding', accountKnown: true }, id: 'fixture-route', version: 1, origin: 'https://docs.example.com', catalog: 'fixture-catalog',
    configuration: JSON.stringify([config.version, config.toolVersion]), executable: 'node', execution: 'sandbox',
    verifier: { id: 'fixture-reader', version: '1' }, sourceTaskId: 'task:previous', successReceiptId: 'success', successOperationId: 'read-operation',
    failedReceiptId: 'failed', observedAt: 0, matched: 0, applied: 0, successes: 1, failures: 0, disabled: false };
}

export function modelPilot(failure: boolean) {
  const fixture = new ResilientPartitionModel(input => {
    input.config.executionMemory = true;
    const route = modelReadRoute(input.config);
    input.executionMemory = { routes: [route], patterns: [route.pattern!], partitions: [] };
  });
  const [first] = fixture.pending('assistance');
  assert.equal(fixture.pending('assistance').length, 1);
  assert.equal(first?.learnedReadRoute?.id, 'fixture-route');
  const work = fixture.start(first);
  assert.equal(fixture.context.usage.assists, 1);
  fixture.acquire(work, fixture.url(work), failure ? '<title>Login</title>' : '完整正文', false);
  assert.equal(fixture.pending('assistance').length, 3);
  assert(fixture.pending('assistance').every(item => !!item.learnedReadRoute !== failure));
  return fixture;
}

export function modelReuse() {
  const url = partitionUrls[0]!, contentHash = 'a'.repeat(64);
  const goalText = '请逐篇提取文档并保留出处\n' + url + ' sha256:' + contentHash + '\n' + partitionUrls[1];
  const fixture = new CapacityModel(input => {
    input.config.executionMemory = true;
    input.goal.text = input.message.text = goalText;
  });
  const spec = capacityModelIntent();
  spec.decomposition!.partitions = partitionUrls.slice(0, 2).map((resource, index) => ({
    id: 'part-' + (index + 1), objective: '读取' + resource, expectedOutput: '独立正文和出处',
  }));
  fixture.context.executionMemory = { routes: [], partitions: [{
    source: { sourceTaskId: 'task:previous', publicationRevision: 'p1', evidenceId: 'saved-proof', sourcePartitionId: 'prior',
      resource: { kind: 'url', url }, contentHash, contractHash: 'test-only', resultRef: 'r1' },
    contract: partitionContract(fixture.context, spec.decomposition!.partitions[0]!),
    target: 'B', answer: '旧结果有出处', artifacts: [{ id: 'original', name: 'source.md', content: '旧结果有出处', goalVersion: 1 }],
  }] };
  fixture.claim(); fixture.consume(); assert(fixture.interpret(spec).ok);
  const [reused] = fixture.context.discussion!.mapReduce!.queue!;
  assert.equal(reused?.status, 'succeeded');
  assert.equal(reused?.reusedSource?.evidenceId, 'saved-proof');
  assert.equal(fixture.context.usage.assists, 1);
  assert.deepEqual(fixture.context.artifacts[0]?.reusedFrom, { sourceTaskId: 'task:previous', artifactId: 'original' });
  assert.deepEqual(missingResourceAcquisitions(fixture.context).map(requirement => requirement.resource), [{ kind: 'url', url: partitionUrls[1] }]);
  return fixture;
}

export function modelMemoryGate() {
  const tried = modelPilot(false);
  assert.equal(tried.pending('assistance')[0]?.learnedReadRoute?.configuration, mapConfigurationKey(tried.context));
  modelPilot(true);
  modelReuse();
}

const protectedPrefix = 'https://docs.example.com/protected/';
const protectedDocs = [protectedPrefix + 'first', protectedPrefix + 'second'];
const publicDoc = 'https://docs.example.com/public/third';

function matchingModel(boundary: 'matched' | 'account' | 'legacy') {
  return new ResilientPartitionModel(input => {
    input.config.executionMemory = true;
    const pattern = { urlPrefix: protectedPrefix, executable: 'node', execution: 'sandbox' as const,
      verifier: { id: 'fixture-reader', version: '1' }, binding: 'fixture-binding', accountKnown: true };
    const route = modelReadRoute(input.config);
    if (boundary === 'legacy') delete route.pattern;
    else route.pattern = pattern;
    input.goal.resourceRequirements = [...protectedDocs, publicDoc].map(url => ({ resource: { kind: 'url' as const, url }, freshness: 'saved' }));
    input.goal.partitionResources = Object.fromEntries([...protectedDocs, publicDoc].map((url, index) =>
      ['part-' + (index + 1), [{ kind: 'url', url }]]));
    input.executionMemory = { routes: [route], partitions: [],
      patterns: [boundary === 'account' ? { ...pattern, binding: 'changed-account' } : pattern] };
  });
}

export function structuredMemoryModelGate() {
  const fixture = matchingModel('matched');
  const firstBatch = fixture.pending('assistance');
  assert.deepEqual(firstBatch.map(item => ({
    id: (item.payload.partition as { id: string }).id, suggested: !!item.learnedReadRoute,
  })), [
    { id: 'part-1', suggested: true }, { id: 'part-3', suggested: false },
    { id: 'part-4', suggested: false }, { id: 'part-5', suggested: false },
  ]);
  const pilot = fixture.start(firstBatch[0]);
  fixture.acquire(pilot, protectedDocs[0], '经本轮核验的文档正文', false);
  assert(fixture.send({ type: 'DISCUSSION_RESULT', discussionId: pilot.discussionId!, workId: pilot.id,
    attempt: pilot.attempt, fence: pilot, status: 'success', text: '本轮资料结算' }).ok);
  assert(fixture.pending('assistance').some(item => (item.payload.partition as { id: string }).id === 'part-2' && item.learnedReadRoute));
  for (const boundary of ['account', 'legacy'] as const) {
    const changed = matchingModel(boundary);
    assert.equal(changed.pending('assistance').length, 4);
    assert(changed.pending('assistance').every(item => !item.learnedReadRoute), boundary);
  }
}
