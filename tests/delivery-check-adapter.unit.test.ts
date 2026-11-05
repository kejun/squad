import { describe, expect, it, vi } from 'vitest';
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
  const scope = { authorizeAdditionalRequest: vi.fn(unauthorized), regenerateModelOutput: vi.fn(unauthorized), findSkills: vi.fn(unavailable),
    webSearch: vi.fn(unavailable), webFetch: vi.fn(unavailable), localTools: {
      catalog: { catalogVersion: 'test', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: undefined, invoke: vi.fn(unavailable), resume: vi.fn(unavailable),
    } } satisfies WorkScope;
  const adapter = new OpenAICompatibleAdapter(config, { transport, env: {} });
  return { materials, work, scope, run: () => adapter.execute(work, new AbortController().signal, scope) };
}

describe('one-request delivery check adapter', () => {
  it('sends the complete fixed input in one request and returns only the criterion results', async () => {
    const transport = vi.fn<typeof fetch>(async () => completion(passed));
    const check = prepareCheck(transport);

    const result = await check.run();

    expect(result).toEqual(passed);
    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(JSON.parse(body.messages[1].content)).toEqual({ workId: check.work.id, context: check.materials });
    expect(check.scope.authorizeAdditionalRequest).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'omitted criterion', output: { type: 'check', criteriaResults: [] } },
    { name: 'redundant overall verdict', output: { ...passed, passed: true } },
    { name: 'wrong receipt quote', output: { type: 'check', criteriaResults: [
      { criterionId, status: 'failed', reason: 'Contradiction', source: { id: 'receipt-1', quote: 'The release was published.' } },
    ] } },
    { name: 'tool action', output: { type: 'runCli', executable: 'node', args: ['--version'] } },
  ])('reports $name as a technical failure without calling tools or repairing inline', async ({ output }) => {
    const transport = vi.fn<typeof fetch>(async () => completion(output));
    const check = prepareCheck(transport);

    await expect(check.run()).rejects.toMatchObject({ transient: true });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(check.scope.regenerateModelOutput).not.toHaveBeenCalled();
    expect(check.scope.localTools.invoke).not.toHaveBeenCalled();
  });

  it('preserves a negative result when its exact quote is present in the named receipt', async () => {
    const output = { type: 'check', criteriaResults: [{ criterionId, status: 'failed', reason: 'Tests alone do not prove a release',
      source: { id: 'receipt-1', quote: 'All tests passed.' } }] };
    const check = prepareCheck(async () => completion(output));

    await expect(check.run()).resolves.toEqual(output);
  });

  it('returns an explicit permanent capacity error without sending oversized material', async () => {
    const transport = vi.fn<typeof fetch>(async () => completion(passed));
    const check = prepareCheck(transport, { contextWindowTokens: 4096, maxTokens: 256 });
    check.materials.artifacts[0]!.content = '固定证据'.repeat(1024);

    await expect(check.run()).rejects.toMatchObject({ transient: false, message: expect.stringContaining('CHECK_CONTEXT_LIMIT') });

    expect(transport).not.toHaveBeenCalled();
  });

  it('maps a provider capacity rejection to an unchecked scope without storing its message', async () => {
    const check = prepareCheck(async () => Response.json({ error: { code: 'context_length_exceeded', message: 'private provider prompt echo' } }, { status: 400 }));

    const failure = await check.run().catch(error => error);

    expect(failure).toMatchObject({ transient: false, message: expect.stringContaining('CHECK_CONTEXT_LIMIT') });
    expect(failure.message).not.toContain('private provider prompt echo');
  });

  it('disables provider-side retrieval, context compression and fallbacks for an OpenRouter check', async () => {
    const transport = vi.fn<typeof fetch>(async () => completion(passed));
    const check = prepareCheck(transport, { baseUrl: 'https://openrouter.ai/api/v1', extraBody: {
      plugins: [{ id: 'web' }], truncate_prompt_tokens: 500, provider: { order: ['provider'] },
    } });

    await check.run();

    const body = JSON.parse(String(transport.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ provider: { order: ['provider'], allow_fallbacks: false }, plugins: expect.arrayContaining([
      { id: 'web', enabled: false }, { id: 'context-compression', enabled: false },
    ]) });
    expect(body).not.toHaveProperty('truncate_prompt_tokens');
  });
});
