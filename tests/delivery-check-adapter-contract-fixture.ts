import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { observeCalls } from './delivery-contract-observations.js';
import type { CheckMaterials } from '../src/delivery-acceptance.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { resolveModel } from '../src/model-config.js';
import type { WorkScope } from '../src/runner.js';
import type { Intent, ModelService } from '../src/types.js';
import { createTeamConfig } from '../team.config.js';

const criterionId = 'G1:goal:text';
const passed = { type: 'check', criteriaResults: [{ criterionId, status: 'passed' }] };
const completion = (output: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });

function prepareCheck(transport: typeof fetch, settings: Partial<ModelService> = {}) {
  const config = createTeamConfig({});
  config.models = { default: 'review', services: { review: { baseUrl: 'https://review.example/v1', model: 'review', ...settings } } };
  const materials: CheckMaterials = {
    requirements: [{ id: criterionId, text: 'Verify the release claim', goalVersion: 1, sources: [{ kind: 'goal', id: 'input-1' }] }],
    candidate: { revision: 'revision-1', text: 'A release is planned.' },
    artifacts: [{ id: 'draft-1', name: 'report.md', content: 'The release is planned.' }],
    rawInputs: [{ id: 'input-1', text: 'Verify the release claim' }], evidence: [], previousResults: [],
    verification: { id: 'receipt-1', stdout: 'All tests passed.', workspaceRevision: 'workspace-revision' },
  };
  const work: Intent = { id: 'task:E1:check', kind: 'check', target: 'facilitator', status: 'inflight', replay: 'safe', attempt: 1,
    epoch: 1, goalVersion: 1, deadline: null, bucket: 'checks', requestCount: 1, model: resolveModel(config, 'check', 'facilitator')!,
    payload: { checkMaterials: materials, capabilities: { localTools: true }, history: 'unrelated private room history' } };
  const unavailable = async (): Promise<never> => { throw new Error('Checker must not call a tool'); };
  const unauthorized = () => { throw new Error('Checker may only make one request per execution'); };
  const scope = { authorizeAdditionalRequest: observeCalls(unauthorized), regenerateModelOutput: observeCalls(unauthorized), findSkills: observeCalls(unavailable),
    webSearch: observeCalls(unavailable), webFetch: observeCalls(unavailable), localTools: {
      catalog: { catalogVersion: 'test', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: undefined, invoke: observeCalls(unavailable), resume: observeCalls(unavailable),
    } } satisfies WorkScope;
  const adapter = new OpenAICompatibleAdapter(config, { transport, env: {} });
  return { materials, work, scope, run: () => adapter.execute(work, new AbortController().signal, scope) };
}

export async function* sendsTheCompleteFixedInputInOneRequestAndReturnsOnlyTheCriterionResults() {
const transport = observeCalls<typeof fetch>(async () => completion(passed));
const check = prepareCheck(transport);
yield 'prepared';
const result = await check.run();
assert.deepEqual(result, passed);
assert.equal((transport).calls.length, 1);
const body = JSON.parse(String(transport.calls[0]![1]?.body));
yield 'observed';
assert.deepEqual(JSON.parse(body.messages[1].content), { workId: check.work.id, context: check.materials });
assert(!(check.scope.authorizeAdditionalRequest).calls.length);
}

export async function* rejectsMissingCriterionWithoutToolOrRepair() {
const row = { name: 'omitted criterion', output: { type: 'check', criteriaResults: [] } };
const { output } = row;
const transport = observeCalls<typeof fetch>(async () => completion(output));
const check = prepareCheck(transport);
yield 'prepared';
await assert.rejects(check.run(), { transient: true });
yield 'observed';
assert.equal((transport).calls.length, 1);
assert(!(check.scope.regenerateModelOutput).calls.length);
assert(!(check.scope.localTools.invoke).calls.length);
}

export async function* rejectsOverallVerdictWithoutToolOrRepair() {
const row = { name: 'redundant overall verdict', output: { ...passed, passed: true } };
const { output } = row;
const transport = observeCalls<typeof fetch>(async () => completion(output));
const check = prepareCheck(transport);
yield 'prepared';
await assert.rejects(check.run(), { transient: true });
yield 'observed';
assert.equal((transport).calls.length, 1);
assert(!(check.scope.regenerateModelOutput).calls.length);
assert(!(check.scope.localTools.invoke).calls.length);
}

export async function* rejectsUnknownReceiptQuoteWithoutToolOrRepair() {
const row = { name: 'wrong receipt quote', output: { type: 'check', criteriaResults: [
      { criterionId, status: 'failed', reason: 'Contradiction', source: { id: 'receipt-1', quote: 'The release was published.' } },
    ] } };
const { output } = row;
const transport = observeCalls<typeof fetch>(async () => completion(output));
const check = prepareCheck(transport);
yield 'prepared';
assert.deepEqual(await check.run(), row.output);
yield 'observed';
assert.equal((transport).calls.length, 1);
assert(!(check.scope.regenerateModelOutput).calls.length);
assert(!(check.scope.localTools.invoke).calls.length);
}

export async function* rejectsToolActionWithoutToolOrRepair() {
const row = { name: 'tool action', output: { type: 'runCli', executable: 'node', args: ['--version'] } };
const { output } = row;
const transport = observeCalls<typeof fetch>(async () => completion(output));
const check = prepareCheck(transport);
yield 'prepared';
await assert.rejects(check.run(), /Checker must not call a tool/);
yield 'observed';
assert.equal((transport).calls.length, 1);
assert(!(check.scope.regenerateModelOutput).calls.length);
assert.equal(check.scope.localTools.invoke.calls.length, 1);
}

export async function* preservesANegativeResultWhenItsExactQuoteIsPresentInTheNamedReceipt() {
const output = { type: 'check', criteriaResults: [{ criterionId, status: 'failed', reason: 'Tests alone do not prove a release',
      source: { id: 'receipt-1', quote: 'All tests passed.' } }] };
const check = prepareCheck(async () => completion(output));
yield 'prepared';
await assert.deepEqual(await (check.run()), output);
yield 'observed';

}

export async function* returnsAnExplicitPermanentCapacityErrorWithoutSendingOversizedMaterial() {
const transport = observeCalls<typeof fetch>(async () => completion(passed));
const check = prepareCheck(transport, { contextWindowTokens: 4096, maxTokens: 256 });
check.materials.artifacts[0]!.content = '固定证据'.repeat(1024);
yield 'prepared';
await assert.rejects(check.run(), { transient: false, message: /CHECK_CONTEXT_LIMIT/ });
yield 'observed';
assert(!(transport).calls.length);
}

export async function* mapsAProviderCapacityRejectionToAnUncheckedScopeWithoutStoringItsMessage() {
const check = prepareCheck(async () => Response.json({ error: { code: 'context_length_exceeded', message: 'private provider prompt echo' } }, { status: 400 }));
yield 'prepared';
const failure = await check.run().catch(error => error);
yield 'observed';
assert.equal(failure.transient, false); assert.match(failure.message, { transient: false, message: /CHECK_CONTEXT_LIMIT/ }.message);
assert(!(failure.message).includes('private provider prompt echo'));
}

export async function* disablesProviderSideRetrievalContextCompressionAndFallbacksForAnOpenRouterCheck() {
const transport = observeCalls<typeof fetch>(async () => completion(passed));
const check = prepareCheck(transport, { baseUrl: 'https://openrouter.ai/api/v1', extraBody: {
      plugins: [{ id: 'web' }], truncate_prompt_tokens: 500, provider: { order: ['provider'] },
    } });
yield 'prepared';
await check.run();
const body = JSON.parse(String(transport.calls[0]![1]?.body));
yield 'observed';
assert.deepEqual(body.provider, { order: ['provider'], allow_fallbacks: false });
assert(body.plugins.some((plugin: unknown) => isDeepStrictEqual(plugin, { id: 'web', enabled: false })));
assert(body.plugins.some((plugin: unknown) => isDeepStrictEqual(plugin, { id: 'context-compression', enabled: false })));
assert(!Object.hasOwn(body, 'truncate_prompt_tokens'));
}
