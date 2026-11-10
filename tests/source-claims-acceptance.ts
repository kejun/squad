import assert from 'node:assert/strict';
import { LocalFixture } from './local-tools-fixture.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { fixtureJudgments } from './delivery-protocol-fixture.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';

/** Real process, SQLite, engine, runner and protocol; only model HTTP is controlled. */
export async function sourceClaimsAcceptance() {
  const f = await LocalFixture.create('方案师', true);
  try {
    const adapter = new OpenAICompatibleAdapter(f.h.config, { env: {}, clock: () => f.h.now, transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      f.requests.push(body);
      if (body.messages[0].content.includes('executing check work')) {
        const context = JSON.parse(body.messages[1].content).context;
        return modelResponse(fixtureJudgments(context.requirements as AcceptanceCriterion[]));
      }
      if (f.backend.calls.length === 0) return modelResponse({ type: 'runCli', executable: 'node',
        args: ['-e', 'console.log(JSON.stringify({data:{id:"doc-4",body:"进行中，等待评审。"}}))'] });
      const source = f.h.context().intents.flatMap(work => work.localOperations ?? []).find(op => op.action.type === 'runCli')!;
      return modelResponse({ type: 'deliver', text: '文档工作清单', artifactIds: [], artifacts: [{ name: 'work.md', content: '当前工作项',
        sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId: 'doc-4', sourceEvidenceId: source.id }] }] });
    } });
    const runner = new WorkRunner(f.h.engine, adapter, () => f.h.now, globalThis.fetch, undefined, f.runtime);
    assert(await runner.runOne(f.h.room, f.h.task));
    const artifact = f.h.context().artifacts[0]!;
    assert.equal(artifact.sourceItems?.[0]?.sourceDocId, 'doc-4');
    assert(artifact.content.includes('| D1 | doc-4 | 安排评审 | 进行中 |'));
    const sourceId = artifact.sourceItems![0]!.sourceEvidenceId;
    assert.equal(f.h.context().intents.flatMap(work => work.localOperations ?? []).find(op => op.id === sourceId)?.status, 'succeeded');
    assert(await runner.runOne(f.h.room, f.h.task));
    assert.equal(f.h.context().outcome, 'complete');
    assert.equal(f.h.context().usage.checks, 1);
    assert.equal(f.backend.calls.length, 1);
    assert(f.requests[0]!.messages[0]!.content.includes('sourceItems'));
    return { content: artifact.content, sourceDocId: artifact.sourceItems![0]!.sourceDocId, sourceEvidenceId: sourceId };
  } finally { await f.close(); }
}
