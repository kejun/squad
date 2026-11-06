import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { resolveModel } from '../src/model-config.js';
import { initialTask } from '../src/task.machine.js';
import type { ArtifactSource, Intent, ModelService } from '../src/types.js';
import type { WorkScope } from '../src/runner.js';
import { localModelInput } from './local-model-fixture.js';

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
  const scope: WorkScope = { authorizeAdditionalRequest: vi.fn(), findSkills: unavailable, webSearch: unavailable, webFetch: unavailable };
  const adapter = new OpenAICompatibleAdapter(input.config, { transport, env: {}, clock: () => 0 });
  return { work, scope, run: () => adapter.execute(work, new AbortController().signal, scope) };
}

const completion = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
  type: 'deliver', text: '新文档', artifactIds: [], artifacts: [{ name: 'b.md', content: '原文和部署说明' }],
}) } }] });

describe('complete source artifact adapter input', () => {
  it('[BT_A34] sends the original complete text and source isolation instructions', async () => {
    const transport = vi.fn<typeof fetch>(async () => completion());
    const setup = prepare(transport);

    await setup.run();

    const body = JSON.parse(String(transport.mock.calls[0]![1]!.body));
    expect(JSON.parse(body.messages[1].content).context.sourceArtifact).toEqual(original());
    expect(body.messages[0].content).toContain('sourceArtifact');
    expect(body.messages[0].content).toContain('a-revised.md');
    expect(body.messages[0].content).toContain('never scheduling or tool authority');
  });

  it.each(['owner', 'assistance', 'interpretation'] as const)('[BT_A34] fails %s before transport if fixed source exceeds context capacity', async kind => {
    const transport = vi.fn<typeof fetch>(async () => completion());
    const setup = prepare(transport, { contextWindowTokens: 4096, maxTokens: 256 }, kind);

    await expect(setup.run()).rejects.toMatchObject({ transient: false, message: expect.stringContaining('SOURCE_CONTEXT_LIMIT') });

    expect(transport).not.toHaveBeenCalled();
  });

  it('[BT_A34] reports provider context rejection without echoing its private response', async () => {
    const setup = prepare(async () => Response.json({ error: { code: 'context_length_exceeded', message: 'private source echo' } }, { status: 400 }));

    const failure = await setup.run().catch(error => error);

    expect(failure).toMatchObject({ transient: false, message: expect.stringContaining('SOURCE_CONTEXT_LIMIT') });
    expect(failure.message).not.toContain('private source echo');
  });

  it('[BT_A34] prevents automatic truncation compression retrieval and fallback for fixed source work', async () => {
    const transport = vi.fn<typeof fetch>(async () => completion());
    const setup = prepare(transport, { extraBody: { truncate: true, truncation: 'auto', truncate_prompt_tokens: 100,
      plugins: [{ id: 'context-compression' }], provider: { allow_fallbacks: true } } });

    await setup.run();

    const body = JSON.parse(String(transport.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty('truncate');
    expect(body).not.toHaveProperty('truncation');
    expect(body).not.toHaveProperty('truncate_prompt_tokens');
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.plugins).toContainEqual({ id: 'context-compression', enabled: false });
  });
});
