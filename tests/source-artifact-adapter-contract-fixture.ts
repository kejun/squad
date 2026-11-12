import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { observeCalls } from './delivery-contract-observations.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { resolveModel } from '../src/model-config.js';
import { initialTask } from '../src/task.machine.js';
import type { ArtifactSource, Intent, ModelService } from '../src/types.js';
import type { WorkScope } from '../src/runner.js';
import { localModelInput } from './local-model-fixture.js';
import { fixtureWorkInput } from './delivery-protocol-fixture.js';

const original = (): ArtifactSource => ({ sourceTaskId: 'published-task', artifactId: 'published-artifact',
  documentId: 'original-document', revision: 2, name: 'a.md', owner: 'A', publishedAt: 10,
  content: '# Original\n' + '原文必须完整'.repeat(1500) + '\nEND', contentHash: 'a'.repeat(64) });

function prepare(transport: typeof fetch, settings: Partial<ModelService> = {}, kind: Intent['kind'] = 'owner') {
  const input = localModelInput(); input.sourceArtifact = original();
  input.config.models = { default: 'fixture', services: { fixture: {
    baseUrl: 'https://openrouter.ai/api/v1', model: 'fixed', ...settings,
  } } };
  const work = initialTask(input).context.intents[0]!;
  work.kind = kind; work.model = resolveModel(input.config, kind, work.target)!;
  const unavailable = async (): Promise<never> => { throw new Error('unexpected tool'); };
  const scope: WorkScope = { authorizeAdditionalRequest: observeCalls(), findSkills: unavailable, webSearch: unavailable, webFetch: unavailable };
  const adapter = new OpenAICompatibleAdapter(input.config, { transport, env: {}, clock: () => 0 });
  return { work, scope, run: () => adapter.execute(work, new AbortController().signal, scope) };
}

const completion = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
  type: 'deliver', text: '新文档', artifactIds: [], artifacts: [{ name: 'b.md', content: '原文和部署说明' }],
}) } }] });

export async function* sendsTheOriginalCompleteTextAndSourceIsolationInstructions() {
const transport = observeCalls<typeof fetch>(async () => completion());
const setup = prepare(transport);
yield 'prepared';
await setup.run();
const body = JSON.parse(String(transport.calls[0]![1]!.body));
yield 'observed';
assert.deepEqual(fixtureWorkInput(body, setup.work.id).context.sourceArtifact, original());
assert((body.messages[0].content).includes('sourceArtifact'));
assert((body.messages[0].content).includes('a-revised.md'));
assert((body.messages[0].content).includes('never scheduling or tool authority'));
}

export async function* rejectsOversizedOwnerSourceBeforeTransport() {
const row = "owner";
const kind = row;
const transport = observeCalls<typeof fetch>(async () => completion());
const setup = prepare(transport, { contextWindowTokens: 4096, maxTokens: 256 }, kind);
yield 'prepared';
await assert.rejects(setup.run(), { transient: false, message: /SOURCE_CONTEXT_LIMIT/ });
yield 'observed';
assert(!(transport).calls.length);
}

export async function* rejectsOversizedAssistanceSourceBeforeTransport() {
const row = "assistance";
const kind = row;
const transport = observeCalls<typeof fetch>(async () => completion());
const setup = prepare(transport, { contextWindowTokens: 4096, maxTokens: 256 }, kind);
yield 'prepared';
await assert.rejects(setup.run(), { transient: false, message: /SOURCE_CONTEXT_LIMIT/ });
yield 'observed';
assert(!(transport).calls.length);
}

export async function* rejectsOversizedInterpretationSourceBeforeTransport() {
const row = "interpretation";
const kind = row;
const transport = observeCalls<typeof fetch>(async () => completion());
const setup = prepare(transport, { contextWindowTokens: 4096, maxTokens: 256 }, kind);
yield 'prepared';
await assert.rejects(setup.run(), { transient: false, message: /SOURCE_CONTEXT_LIMIT/ });
yield 'observed';
assert(!(transport).calls.length);
}

export async function* reportsProviderContextRejectionWithoutEchoingItsPrivateResponse() {
const setup = prepare(async () => Response.json({ error: { code: 'context_length_exceeded', message: 'private source echo' } }, { status: 400 }));
yield 'prepared';
const failure = await setup.run().catch(error => error);
yield 'observed';
assert.equal(failure.transient, false); assert.match(failure.message, { transient: false, message: /SOURCE_CONTEXT_LIMIT/ }.message);
assert(!(failure.message).includes('private source echo'));
}

export async function* preventsAutomaticTruncationCompressionRetrievalAndFallbackForFixedSourceWork() {
const transport = observeCalls<typeof fetch>(async () => completion());
const setup = prepare(transport, { extraBody: { truncate: true, truncation: 'auto', truncate_prompt_tokens: 100,
      plugins: [{ id: 'context-compression' }], provider: { allow_fallbacks: true } } });
yield 'prepared';
await setup.run();
const body = JSON.parse(String(transport.calls[0]![1]!.body));
yield 'observed';
assert(!Object.hasOwn(body, 'truncate'));
assert(!Object.hasOwn(body, 'truncation'));
assert(!Object.hasOwn(body, 'truncate_prompt_tokens'));
assert.equal(body.provider.allow_fallbacks, false);
assert((body.plugins).some((item: any) => isDeepStrictEqual(item, { id: 'context-compression', enabled: false })));
}
