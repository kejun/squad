import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CloudflareWebTools } from '../src/web-tools.js';
import { WorkRunner } from '../src/runner.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';
import type { DeliveryEvidenceSource } from '../src/task/evidence.js';
import type { DiscussionRound, InputIntentSpec } from '../src/types.js';
import { savedResourceAcquisitions } from '../src/resource-acquisition.js';
import { InputIntentFixture, intentConfig, parsedIntent, type IntentRequest } from './input-intent-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

const urls = ['https://recovery.example.com/doc-1.md', 'https://recovery.example.com/doc-2.md'];
const bodies = ['WEB_RECOVERY_1_FACT：第一份原文的完整结论', 'WEB_RECOVERY_2_FACT：第二份原文的完整结论'];
interface ToolMessage {
  type?: string; text?: string;
  hostEvidence?: { evidenceId: string; acquisitionId: string; sourceOperationId: string; status: string };
}
function webRecoveryPlan(): InputIntentSpec {
  return parsedIntent('request', { objective: `分别读取并汇总${urls.join(' ')}`, references: [],
    expectedOutputs: ['包含两份原文完整结论和出处的报告'], acceptanceCriteria: ['两份原文的事实与出处均出现'],
    decomposition: { kind: 'mapReduce', synthesis: '保留两份完整原文结论与出处', partitions: urls.map((url, index) => ({
      id: `web-${index + 1}`, objective: `读取并研究${url}`, expectedOutput: '原文结论和精确出处' })) } });
}
function webToolMessages(request: IntentRequest): ToolMessage[] {
  return request.messages.filter(message => message.role === 'user').map(message => JSON.parse(message.content) as ToolMessage)
    .filter(message => message.type === 'web_fetch_result');
}

/** Real Runner/adapter, SQLite and local HTTP; the scripted owner learns refs solely from returned tool JSON. */
export async function webPartitionRecoveryAcceptance(wrongSource = false) {
  const paths: string[] = [], emittedReferences: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    const index = ['/doc-1.md', '/doc-2.md'].indexOf(request.url!);
    assert(index >= 0); response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); response.end(bodies[index]);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const config = intentConfig({ ordinary: 80, assists: 10, checks: 4, workTimeoutMs: 1000 });
  config.localTools = { enabled: false }; config.webTools = { enabled: true }; config.skillSearch = { enabled: false };
  config.resilience = { automaticTimeoutMs: 100_000 };
  const fixture = new InputIntentFixture(config, true);
  let ownerCalls = 0, checkCalls = 0;
  try {
    fixture.response = request => {
      if (request.kind === 'interpretation') return modelResponse({ type: 'interpretation', spec: webRecoveryPlan() });
      if (request.kind === 'assistance') {
        if ((request.context.partition as { id: string }).id === 'web-2') fixture.now = 1050;
        return modelResponse({ type: 'answer', status: 'failed', text: '成员未取得来源，保留本片缺口' });
      }
      if (request.kind === 'discussionSummary') return modelResponse({ type: 'answer', status: 'partial', text: '两片均缺原文，由负责人继续' });
      if (request.kind === 'owner') {
        ownerCalls++;
        const pages = webToolMessages(request);
        for (const page of pages) {
          assert(page.hostEvidence, 'The owner must receive a host-owned canonical reference through tool JSON');
          assert.equal(page.hostEvidence.status, 'acquired');
          assert.equal(page.hostEvidence.evidenceId, page.hostEvidence.acquisitionId);
          assert.notEqual(page.hostEvidence.evidenceId, page.hostEvidence.sourceOperationId);
          assert(page.text?.length);
        }
        if (pages.length < urls.length) return modelResponse({ type: 'web_fetch', url: urls[pages.length] });
        emittedReferences.push(...pages.map(page => page.hostEvidence!.evidenceId));
        const round = request.context.discussion as DiscussionRound;
        return modelResponse({ type: 'deliver', text: '负责人使用网页原文补齐两片报告', artifactIds: [],
          artifacts: [{ name: 'web-recovery.md', content: pages.map(page => page.text).join('\n\n') }],
          partitionRecoveries: round.mapReduce!.queue!.filter(part => part.status === 'failed').map((part, index) => ({
            discussionId: round.id, partitionId: part.partitionId,
            sourceOperationIds: [pages[wrongSource ? 0 : index]!.hostEvidence!.evidenceId] })) });
      }
      assert.equal(request.kind, 'check'); checkCalls++;
      const requirements = request.context.requirements as AcceptanceCriterion[], evidence = request.context.evidence as DeliveryEvidenceSource[];
      const recoveryCriteria = requirements.filter(criterion => criterion.requiredSourceIds?.length);
      assert.equal(recoveryCriteria.length, 2);
      return modelResponse({ type: 'check', criteriaResults: requirements.map(criterion => {
        if (!criterion.requiredSourceIds?.length) return { criterionId: criterion.id, status: 'passed' };
        const source = evidence.find(source => source.id === criterion.requiredSourceIds![0])!;
        assert(source); assert.equal(source.metadata.command.type, 'webFetch'); assert.equal(source.metadata.exitCode, null);
        assert.equal(source.metadata.completeness, 'complete'); assert(emittedReferences.includes(source.id));
        assert.notEqual(source.id, source.metadata.sourceOperationId);
        const quote = /WEB_RECOVERY_[12]_FACT/.exec(source.stdout!)?.[0]; assert(quote);
        return { criterionId: criterion.id, status: 'passed', source: { id: source.id, quote } };
      }) });
    };
    const tools = new CloudflareWebTools({ env: {}, transport: (url, init) => {
      const remote = new URL(String(url)); assert.equal(remote.origin, 'https://recovery.example.com');
      return globalThis.fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
    } });
    let runner = new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, tools);
    assert(fixture.submit(`分别读取并汇总${urls.join(' ')}`).ok);
    assert(await runner.runOne(fixture.room, fixture.task));
    while (fixture.engine.pending(fixture.room, fixture.task).some(work => work.kind === 'assistance'))
      assert(await runner.runOne(fixture.room, fixture.task, fixture.engine.pending(fixture.room, fixture.task).find(work => work.kind === 'assistance')!.id));
    assert(await runner.runOne(fixture.room, fixture.task));
    const failures = structuredClone(fixture.context().discussion!.results.filter(result => result.status === 'failed'));
    assert.equal(failures.length, 2);
    fixture.now = 1200; // Original partition windows expired, bounded owner continuation remains available.
    assert(await runner.runOne(fixture.room, fixture.task));
    const acquired = savedResourceAcquisitions(fixture.context());
    assert.deepEqual(acquired.map(receipt => receipt.id).sort(), [...emittedReferences].sort());
    assert.deepEqual(paths, ['/doc-1.md', '/doc-2.md']);
    fixture.reopen();
    if (wrongSource) {
      assert.equal(fixture.context().candidate!.deliveryIssue!.code, 'MAP_RECOVERY_RESOURCE_UNVERIFIED');
      assert.equal(fixture.engine.pending(fixture.room, fixture.task).filter(work => work.kind === 'check').length, 0);
      assert(fixture.event({ type: 'EXHAUSTED', reason: '指定网页来源未覆盖第二片，保留待核实报告' }).ok);
      assert.equal(fixture.context().outcome, 'partial');
      assert.equal(fixture.context().discussion!.mapReduce!.queue!.filter(part => part.resolution).length, 0);
    } else {
      runner = new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, tools);
      assert(await runner.runOne(fixture.room, fixture.task)); assert.equal(fixture.context().outcome, 'complete');
      assert.equal(fixture.context().discussion!.mapReduce!.queue!.filter(part => part.resolution).length, 2);
      assert(fixture.context().discussion!.mapReduce!.queue!.every(part => part.resolution?.sourceOperationIds.every(id => emittedReferences.includes(id))));
    }
    assert.equal(ownerCalls, 3); assert.equal(checkCalls, wrongSource ? 0 : 1);
    assert.equal(paths.length, 2, 'SQLite recovery/check must use the original captured Web body without fetching again');
    assert.deepEqual(fixture.context().discussion!.results.filter(result => result.status === 'failed'), failures);
    assert.equal(fixture.context().intents.flatMap(work => work.localOperations ?? []).length, 0);
    return { outcome: fixture.context().outcome, ownerCalls, checkCalls, httpRequests: paths.length,
      cliOperations: 0, originalFailures: failures.length,
      resolutions: fixture.context().discussion!.mapReduce!.queue!.filter(part => part.resolution).length,
      modelReferenceSource: 'web_fetch_result.hostEvidence.evidenceId only',
      boundary: 'Actual SDK/Runner/adapter/SQLite and local HTTP; controlled provider replay and public-identity routing, no public DNS or real model semantic claim' };
  } finally {
    fixture.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ accepted: await webPartitionRecoveryAcceptance(), wrongSource: await webPartitionRecoveryAcceptance(true) }));
