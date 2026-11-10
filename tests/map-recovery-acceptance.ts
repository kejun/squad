import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRuntime } from '../src/local-runtime.js';
import { WorkRunner } from '../src/runner.js';
import type { DeliveryEvidenceSource } from '../src/task/evidence.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';
import type { DiscussionRound } from '../src/types.js';
import { InputIntentFixture, intentConfig, type IntentRequest } from './input-intent-fixture.js';
import { ControlledProcessBackend, localFixtureCommandEnv } from './local-tools-fixture.js';
import { documentRequest, documentUrls, groupedIntent } from './map-capacity-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

/** Actual engine/SQLite, adapter, runner and Node process; only model HTTP is controlled. */
async function runMapRecoveryIntegration(wrongDocument: boolean, wrongOutput = false) {
  const config = intentConfig({ ordinary: 100, checks: 5, assists: 20 });
  config.inputAnalysis = { enabled: true };
  const fixture = new InputIntentFixture(config, true);
  const sourceRoot = join(fixture.directory!, 'source'), runtimeRoot = join(fixture.directory!, 'runtime');
  const backend = new ControlledProcessBackend();
  let runtime: LocalRuntime | undefined;
  let ownerCalls = 0, checkCalls = 0, wrongOutputSubmitted = false;
  const documents = documentUrls.map((url, index) => ({ id: `doc-${index + 1}`, url, body: `DOC_${index + 1}_FACT：完整文档正文` }));
  const returnedDocuments = wrongDocument ? [documents[1]!] : documents;
  try {
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'read-docs.mjs'), `console.log(${JSON.stringify(JSON.stringify(returnedDocuments))});\n`);
    runtime = await LocalRuntime.create({ dataRoot: runtimeRoot, workspaceRoot: sourceRoot, skillRoots: [],
      commandEnv: localFixtureCommandEnv, backend, clock: () => fixture.now });
    backend.before = () => {
      const operation = fixture.context().intents.flatMap(work => work.localOperations ?? []).find(item => item.status === 'running');
      assert(operation, 'A real process must follow persisted LOCAL_STARTED');
      assert.equal(operation.action.type, 'runCli');
    };
    fixture.response = (request: IntentRequest) => {
      if (request.kind === 'interpretation') return modelResponse({ type: 'interpretation', spec: groupedIntent(8) });
      if (request.kind === 'assistance') {
        const partition = request.context.partition as { id: string };
        return modelResponse({ type: 'answer', status: partition.id === 'group-2' ? 'success' : 'failed',
          text: partition.id === 'group-2' ? `${documentUrls[1]} DOC_2_FACT` : '未能取到正文，保留该片未完成' });
      }
      if (request.kind === 'discussionSummary') return modelResponse({ type: 'answer', status: 'partial', text: '八篇仅读到doc-2，其余七片尚未完成。' });
      if (request.kind === 'owner') {
        ownerCalls++;
        const receipt = fixture.context().intents.flatMap(work => work.localOperations ?? [])
          .find(operation => operation.action.type === 'runCli' && operation.status === 'succeeded');
        if (!receipt) return modelResponse({ type: 'runCli', executable: 'node', args: ['read-docs.mjs'] });
        const resultMessages = request.messages.filter(message => message.role === 'user')
          .map(message => JSON.parse(message.content) as { type?: string; operationId?: string; ok?: boolean });
        assert(resultMessages.some(message => message.type === 'local_tool_result' && message.operationId === receipt.id && message.ok === true));
        const discussion = request.context.discussion as DiscussionRound;
        assert.equal(discussion.mapReduce!.queue!.filter(part => part.status === 'failed').length, 7);
        assert(request.messages[0]!.content.includes('partitionRecoveries'));
        const wrongProtocol = wrongOutput && !wrongOutputSubmitted;
        wrongOutputSubmitted ||= wrongProtocol;
        return modelResponse({ type: wrongProtocol ? 'answer' : 'deliver', text: '已补齐八篇并完成汇总。', artifactIds: [],
          artifacts: [{ name: 'recovered-documents.md', content: documents.map(document => `${document.url}\n${document.body}`).join('\n\n') }],
          partitionRecoveries: discussion.mapReduce!.queue!.filter(part => part.status === 'failed').map(part => ({
            discussionId: discussion.id, partitionId: part.partitionId, sourceOperationIds: [receipt.id] })) });
      }
      assert.equal(request.kind, 'check'); checkCalls++;
      const requirements = request.context.requirements as AcceptanceCriterion[];
      const evidence = request.context.evidence as DeliveryEvidenceSource[];
      const recoveries = requirements.filter(criterion => criterion.requiredSourceIds?.length);
      assert.equal(recoveries.length, 7);
      assert(request.messages[0]!.content.includes('A passed recovery judgment MUST include source.id'));
      const originalPlan = groupedIntent(8).decomposition!;
      for (const criterion of recoveries) {
        const partition = originalPlan.partitions.find(part => criterion.id.endsWith(`:${part.id}`))!;
        assert(partition, 'Each recovery is tied to an original partition');
        assert(criterion.text.includes(partition.objective));
        assert(criterion.text.includes(partition.expectedOutput));
        assert(criterion.text.includes(originalPlan.synthesis));
        assert.equal(criterion.requiredSourceIds!.length, 1);
        const source = evidence.find(source => source.id === criterion.requiredSourceIds![0])!;
        assert(source && source.metadata.status === 'succeeded' && source.metadata.completeness === 'complete');
        assert.equal(source.metadata.exitCode, 0);
        assert.deepEqual(JSON.parse(source.stdout!), returnedDocuments);
      }
      return modelResponse({ type: 'check', criteriaResults: requirements.map(criterion => {
        if (!criterion.requiredSourceIds?.length) return { criterionId: criterion.id, status: 'passed' };
        const number = /:group-(\d+)$/.exec(criterion.id)![1]!;
        return wrongDocument
          ? { criterionId: criterion.id, status: 'failed', reason: '来源只有doc-2，不能证明该分片目标已补齐',
            source: { id: criterion.requiredSourceIds[0], quote: 'DOC_2_FACT' } }
          : { criterionId: criterion.id, status: 'passed', source: { id: criterion.requiredSourceIds[0], quote: `DOC_${number}_FACT` } };
      }) });
    };
    const runner = new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, undefined, runtime);
    assert(fixture.submit(documentRequest).ok);
    assert(await runner.runOne(fixture.room, fixture.task));
    assert.equal(fixture.context().discussion!.mapReduce!.queue!.length, 8);
    while (fixture.engine.pending(fixture.room, fixture.task).some(work => work.kind === 'assistance'))
      assert(await runner.runOne(fixture.room, fixture.task,
        fixture.engine.pending(fixture.room, fixture.task).find(work => work.kind === 'assistance')!.id));
    assert.equal(fixture.context().discussion!.results.filter(result => result.status === 'failed').length, 7);
    assert(await runner.runOne(fixture.room, fixture.task));
    assert.equal(fixture.context().discussion!.status, 'delivered');
    const failureHistory = structuredClone(fixture.context().discussion!.results.filter(result => result.status === 'failed'));
    assert(await runner.runOne(fixture.room, fixture.task));
    assert.equal(fixture.engine.pending(fixture.room, fixture.task).filter(work => work.kind === 'check').length, 1);
    assert(await runner.runOne(fixture.room, fixture.task));
    const context = fixture.context(), queue = context.discussion!.mapReduce!.queue!;
    assert.equal(ownerCalls, wrongOutput ? 3 : 2); assert.equal(checkCalls, 1); assert.equal(backend.calls.length, 1);
    if (wrongOutput) {
      assert.equal(context.usage.retries, 1);
      assert.equal(context.trace.filter(event => event.event === 'MODEL_OUTPUT_REPAIR').length, 1);
      assert(fixture.requests.filter(request => request.kind === 'owner').at(-1)!.messages.some(message => message.content.includes('model_output_validation_error')));
    }
    assert.equal(context.usage.checks, 1);
    assert.deepEqual(context.discussion!.results.filter(result => result.status === 'failed'), failureHistory);
    assert.equal(queue.filter(part => part.status === 'failed').length, 7);
    if (wrongDocument) {
      assert.notEqual(context.outcome, 'complete'); assert.equal(context.publishedDelivery, undefined);
      assert.equal(queue.filter(part => part.resolution).length, 0);
      assert.equal(context.intents.filter(work => work.kind === 'check').at(-1)!.criteriaResults!.filter(item => item.status === 'failed').length, 7);
    } else {
      assert.equal(context.outcome, 'complete'); assert.equal(context.publishedDelivery!.revision, context.candidate!.revision);
      const receipt = context.intents.flatMap(work => work.localOperations ?? []).find(operation => operation.action.type === 'runCli')!;
      assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.result!.data.exitCode, 0);
      assert.equal(queue.filter(part => part.resolution).length, 7);
      for (const part of queue.filter(part => part.resolution)) {
        assert.equal(part.resolution!.candidateRevision, context.candidate!.revision);
        assert.deepEqual(part.resolution!.sourceOperationIds, [receipt.id]);
        assert.equal(part.resolution!.owner, context.owner);
      }
      assert.equal(context.discussion!.incomplete, undefined);
    }
    return { outcome: context.outcome, checkCalls, ownerCalls, cliCalls: backend.calls.length,
      historicalFailures: failureHistory.length, resolutions: queue.filter(part => part.resolution).length,
      criteria: context.candidate!.acceptance!.criteria.length, formatRepairs: context.usage.retries };
  } finally { await runtime?.close(); fixture.close(); }
}
export async function verifyMapRecoveryIntegration() { return runMapRecoveryIntegration(false); }
export async function verifyMapRecoveryRejectedContentIntegration() { return runMapRecoveryIntegration(true); }

export async function verifyMapRecoveryWrongOutputIntegration() { return runMapRecoveryIntegration(false, true); }
