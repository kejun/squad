import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner, type WorkAdapter } from '../src/runner.js';
import type { LocalAction, LocalMessage } from '../src/local-operation.js';
import { LocalFixture } from './local-tools-fixture.js';
import { originalPrivateToolAction, originalPrivateToolResponse, privateToolResponseProvenance } from './fixtures/live-private-tool-response.js';

class CapturedBeforeExecution extends Error {}

/** Replays the unmodified real first response through production Runner/Adapter.
 * The invocation boundary captures the normalized action before persistence or
 * execution. A second model request and protocol repair are both forbidden. */
export async function originalPrivateToolResponseReplay() {
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: [{ command: 'yuque',
    description: 'Read Yuque private documents using the existing service-host account', domains: ['yuque.com', 'www.yuque.com'], execution: 'host' }] } });
  let captured: LocalAction | undefined;
  let transcript: LocalMessage[] = [];
  let modelRequests = 0, repairRequests = 0;
  try {
    fixture.h.room = 'private-skill-protocol-replay';
    const text = '根据公司语雀中的私有文档 https://www.yuque.com/example-team/october-work 整理十月团队已完成工作，并保留资料来源。';
    const submission = fixture.h.engine.submit(fixture.h.room, { id: 'original-private-response', text,
      goal: { text, constraints: [], criteria: ['使用实际资料完成整理'], requiredArtifacts: 0 } });
    assert(submission.ok && submission.taskId); fixture.h.task = submission.taskId;
    const adapter = new OpenAICompatibleAdapter(fixture.h.config, { clock: () => fixture.h.now, transport: async () => {
      assert.equal(++modelRequests, 1, 'The captured response replay cannot retry the model');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: originalPrivateToolResponse } }] });
    } });
    const captureAdapter: WorkAdapter = { execute(work, signal, scope) {
      assert(scope.localTools);
      const local = Object.create(scope.localTools) as typeof scope.localTools;
      Object.defineProperty(local, 'invoke', { value: async (action: LocalAction, messages: LocalMessage[]) => {
        captured = structuredClone(action); transcript = structuredClone(messages);
        throw new CapturedBeforeExecution('Replay stops before LOCAL_REQUEST and host execution');
      } });
      const intercepted = Object.create(scope) as typeof scope;
      Object.defineProperties(intercepted, {
        localTools: { value: local },
        authorizeAdditionalRequest: { value: () => { throw new Error('REPLAY_SECOND_REQUEST_FORBIDDEN'); } },
        regenerateModelOutput: { value: () => { repairRequests++; throw new Error('REPLAY_PROTOCOL_REPAIR_FORBIDDEN'); } },
      });
      return adapter.execute(work, signal, intercepted);
    } };
    await new WorkRunner(fixture.h.engine, captureAdapter, () => fixture.h.now, globalThis.fetch, undefined, fixture.runtime)
      .runOne(fixture.h.room, fixture.h.task);
    assert(captured, 'The original private-reader response must reach invoke on its first request after omitting only the empty optional skillId');
    const { skillId: _empty, ...expected } = originalPrivateToolAction;
    assert.deepEqual(captured, expected);
    assert.equal(Object.hasOwn(captured, 'skillId'), false);
    assert(transcript.some(message => message.role === 'assistant' && message.content === originalPrivateToolResponse),
      'The raw real response must remain unchanged in the saved model transcript');
    assert.equal(modelRequests, 1); assert.equal(repairRequests, 0); assert.equal(fixture.backend.calls.length, 0);
    assert.equal(fixture.h.context().intents.flatMap(work => work.localOperations ?? []).length, 0);
    return { original: privateToolResponseProvenance, captured, rawResponsePreserved: true,
      modelRequests, repairRequests, executions: fixture.backend.calls.length, persistedOperations: 0,
      boundary: 'offline replay only; invoke intercepted before all execution and authorization' };
  } finally { await fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await originalPrivateToolResponseReplay(), null, 2));
