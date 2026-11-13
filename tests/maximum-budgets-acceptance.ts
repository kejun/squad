import assert from 'node:assert/strict';
import { createTeamConfig } from '../team.config.js';
import { OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { Harness } from './helpers.js';
import { LocalModel } from './local-model-fixture.js';
import { LocalFixture } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { withToolInventoryReadiness } from '../src/cli-readiness.js';
import type { CliCatalogEntry } from '../src/cli-catalog.js';

const environment = { MODEL_BASE_URL: 'https://budget-model.example/v1', MODEL_NAME: 'deepseek-v4.1-flash', MODEL_NO_AUTH: 'true' };

export async function maximumModelRequests(modelName = environment.MODEL_NAME) {
  const selectedEnvironment = { ...environment, MODEL_NAME: modelName };
  const config = createTeamConfig(selectedEnvironment); config.inputAnalysis = { enabled: false };
  assert.equal(config.models!.services.primary!.contextWindowTokens, 1_048_571);
  const other = createTeamConfig({ ...selectedEnvironment, BUILDER_2_MODEL_NAME: 'different-model', BUILDER_3_MODEL_NAME: 'deepseek-v4.1-flash-preview' });
  assert.equal(other.models!.services['builder-2']!.maxTokens, undefined, 'A different model must not inherit a DeepSeek-specific automatic output maximum');
  assert.equal(other.models!.services['builder-3']!.maxTokens, undefined, 'Similar model IDs must not acquire this version-specific default');
  const roleOverride = createTeamConfig({ ...environment, MODEL_NAME: 'different-model', BUILDER_2_MODEL_NAME: modelName });
  assert.equal(roleOverride.models!.services['builder-2']!.maxTokens, 384_000, 'A role must recognize the provider ID independently of the primary model');
  const explicitOverride = createTeamConfig({ ...selectedEnvironment, MODEL_MAX_TOKENS: '8192' });
  assert.equal(explicitOverride.models!.services.primary!.maxTokens, 8192, 'Explicit output settings must retain priority');
  const completionOverride = createTeamConfig({ ...selectedEnvironment, MODEL_EXTRA_BODY: '{"max_completion_tokens":8192}' });
  assert.equal(completionOverride.models!.services.primary!.maxTokens, undefined, 'An explicit completion limit must not be combined with an automatic max_tokens default');
  assert.equal(completionOverride.models!.services.primary!.extraBody!.max_completion_tokens, 8192);
  for (const member of config.bots) {
    const h = new Harness(config); if (member.id !== 'A') assert(h.event({ type: 'HANDOFF', owner: member.id }).ok);
    let requests = 0;
    const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport: async (_url, init) => {
      requests++; const body = JSON.parse(String(init?.body));
      assert.equal(body.model, modelName, 'ID matching must preserve the provider model ID in actual requests');
      assert.equal(body.max_tokens, 384_000, 'Every actual member request must use the provider maximum output default');
      assert.equal(Object.hasOwn(body, 'enable_thinking'), false, 'Thinking mode must remain provider-controlled unless explicitly configured');
      return modelResponse({ type: 'answer', text: 'maximum budget request accepted' });
    } });
    assert(await new WorkRunner(h.engine, adapter, () => h.now).runOne(h.room, h.task)); assert.equal(requests, 1);
  }
  return { members: 5, context: 1_048_571, output: 384_000 };
}

export function maximumDefaultTask() {
  const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
  for (const key of ['ordinary', 'checks', 'assists', 'replans', 'retries', 'repeatThreshold'] as const)
    assert.equal(config.limits[key], Number.MAX_SAFE_INTEGER);
  assert.equal(config.limits.workTimeoutMs, 2_147_483_647);
  const m = new LocalModel(input => { input.config = config; });
  assert.equal(m.work.deadline, 2_147_483_647);
  assert.equal(m.c.resilience!.window.hardDeadline, 2_147_483_647);
  assert(m.send({ type: 'CONSUME', intentId: m.work.id }).ok); assert.equal(m.c.usage.ordinary, 1);
  assert(m.request({ type: 'runCli', executable: 'node', args: [], execution: 'host', reason: 'read logged-in records' }).ok);
  assert(m.claim().ok); assert.equal(m.started().code, 'HOST_APPROVAL_REQUIRED'); assert.equal(m.op?.startedAt, undefined);
  return { usage: m.c.usage.ordinary, hostStarted: false };
}

// Independent receiver for the documented wire format: arrays replace, objects recursively inherit.
function inherit(defaults: any, own: any): any {
  if (!own || typeof own !== 'object' || Array.isArray(own)) return own;
  const result = { ...defaults };
  for (const [key, value] of Object.entries(own)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? inherit(defaults?.[key], value) : value;
  return result;
}
function expandInventory(observation: any) {
  const cli = observation.cli;
  if (!cli.encoding) return observation;
  assert.equal(cli.encoding, 'shared_cli_metadata_v1');
  const { encoding, encodingInstructions, usageGroups, variantDefaults, entries, ...rest } = cli;
  return { ...observation, cli: { ...rest, entries: entries.map((entry: any) => {
    const { usageRef, variants, ...own } = entry;
    assert(Number.isSafeInteger(usageRef) && usageGroups[usageRef]);
    return { ...inherit(usageGroups[usageRef], own), variants: variants.map((variant: any) => inherit(variantDefaults[variant.execution], variant)) };
  }) } };
}

export async function compactMaximumInventory() {
  const entries: CliCatalogEntry[] = Array.from({ length: 2476 }, (_, index) => ({ command: `budget-command-${index}`,
    description: index < 1806 ? '已在有效 PATH 发现可执行命令；用途资料未知。' : `Read complete archive records for workflow ${index}`,
    scenarios: index < 1806 ? ['适用场景未知；先取得具体用法说明，再决定调用。'] : ['Read the named document archive and retain its source'],
    documentation: index < 1806 ? { state: 'unknown', source: 'path', reference: `budget-command-${index}` }
      : { state: 'documented', source: 'npm', reference: `known-package-${index}` },
    discovery: [{ execution: 'sandbox', path: `/fixture/sandbox/budget-command-${index}` }, { execution: 'host', path: `/fixture/host/budget-command-${index}` }] }));
  const f = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: entries } });
  try {
    const before = withToolInventoryReadiness(f.h.context(), f.h.engine.pending(f.h.room, f.h.task)[0]!, f.runtime.toolInventory());
    f.replies.push({ type: 'discoverHost', commands: [entries[0]!.command, entries.at(-1)!.command] }, { type: 'answer', text: 'All catalog entries retained after metadata result' });
    assert(await f.runner().runOne(f.h.room, f.h.task)); assert.equal(f.requests.length, 2);
    const observations = f.requests.map(request => request.messages.filter(message => message.role === 'user')
      .map(message => { try { return JSON.parse(message.content); } catch { return null; } }).find(value => value?.type === 'tool_inventory'));
    assert.equal(observations[0].cli.encoding, 'shared_cli_metadata_v1', 'Repeated placeholder metadata must be shared, not copied thousands of times');
    const expanded = expandInventory(observations[0]);
    assert.deepEqual(expanded.cli.entries, before.cli.entries, 'The wire format must preserve every command, usage, path, version and readiness fact');
    assert.equal(expandInventory(observations[1]).cli.entries.length, 2476);
    assert(f.requests[1]!.messages.some(message => message.content.includes('local_tool_result')));
    assert.equal(f.backend.calls.length, 0);
    const compactBytes = Buffer.byteLength(JSON.stringify(observations[0]));
    const originalBytes = Buffer.byteLength(JSON.stringify({ type: 'tool_inventory', untrusted: true, ...before }));
    assert(compactBytes < originalBytes * 0.65, `Shared metadata must leave material context headroom: ${compactBytes}/${originalBytes}`);
    return { entries: 2476, unknown: 1806, known: 670, originalBytes, compactBytes, modelRequests: 2, executions: 0 };
  } finally { await f.close(); }
}

export async function providerContextMaximum() {
  const config = createTeamConfig(environment); config.inputAnalysis = { enabled: false };
  const h = new Harness(config); let requests = 0;
  // A fixed original is intentionally larger in bytes than its token window. No byte/token equivalence is assumed.
  h.engine.pending(h.room, h.task)[0]!.payload.sourceArtifact = { content: '甲'.repeat(350_000), artifactId: 'fixed-source' };
  const work = h.claim();
  work.payload.sourceArtifact = { content: '甲'.repeat(350_000), artifactId: 'fixed-source' };
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport: async () => {
    requests++; return Response.json({ error: { type: 'invalid_request_error', message: 'Upstream request failed: [invalid_request_error] The prompt is too long: 1578838, model maximum context length: 1048571 PRIVATE_PROVIDER_BODY' } }, { status: 400 });
  } });
  await assert.rejects(adapter.execute(work, new AbortController().signal, { authorizeAdditionalRequest() {} } as any), /(?:SOURCE|MODEL)_CONTEXT_LIMIT/);
  assert.equal(requests, 1, 'Provider-token configuration must not reject using UTF-8 byte counts');
  // Ordinary assistance/owner failures must retain the same diagnostic class.
  delete work.payload.sourceArtifact;
  await assert.rejects(adapter.execute(work, new AbortController().signal, { authorizeAdditionalRequest() {} } as any), error =>
    error instanceof Error && error.message.includes('MODEL_CONTEXT_LIMIT') && !error.message.includes('PRIVATE_PROVIDER_BODY'));
  return { requests, leakedProviderBody: false };
}

export async function maximumResponseBody() {
  const config = createTeamConfig(environment); config.inputAnalysis = { enabled: false };
  const h = new Harness(config), work = h.claim();
  const transport = async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'answer', text: 'large response accepted' }) } }], padding: 'x'.repeat(8 * 1024 * 1024 + 32) });
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport });
  assert.equal((await adapter.execute(work, new AbortController().signal, { authorizeAdditionalRequest() {} } as any)).type, 'answer');
  config.models!.services.primary!.maxResponseBytes = 1024;
  const limited = new Harness(config), limitedWork = limited.claim();
  await assert.rejects(new OpenAICompatibleAdapter(config, { clock: () => limited.now, transport }).execute(limitedWork, new AbortController().signal, { authorizeAdditionalRequest() {} } as any), /MODEL_RESPONSE_TOO_LARGE/);
  return { greaterThanOld8MB: true, explicitLimitEnforced: true };
}

export async function maximumCommandBudget() {
  const f = await LocalFixture.create();
  const defaults = createTeamConfig({});
  f.h.store.close();
  f.h = new Harness({ ...f.h.config, limits: defaults.limits, ...(defaults.resilience ? { resilience: defaults.resilience } : {}) });
  try {
    f.replies.push({ type: 'runCli', executable: 'node', args: ['-e', 'console.log("MAX-CLI")'], timeoutMs: 2_147_483_647 },
      { type: 'runCli', executable: 'node', args: ['-e', 'console.log("DEFAULT-CLI")'] },
      { type: 'answer', text: 'Long command budgets preserved' });
    assert(await f.runner().runOne(f.h.room, f.h.task));
    assert.equal(f.backend.calls.length, 2);
    assert.equal(f.backend.calls[0]!.timeoutMs, 2_147_483_647);
    assert.equal(f.backend.calls[1]!.timeoutMs, 2_147_483_647);
    assert(f.h.context().intents[0]!.localOperations?.every(operation => operation.status === 'succeeded'));
    return { commands: 2, timeoutMs: 2_147_483_647 };
  } finally { await f.close(); }
}
