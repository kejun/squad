import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { validInputIntent } from '../src/input-intent.js';
import { initialTask } from '../src/task.machine.js';
import type { InputIntentSpec } from '../src/types.js';
import type { WorkScope } from '../src/runner.js';
import { localModelInput } from './local-model-fixture.js';

function interpreted(count?: number): InputIntentSpec {
  return { action: 'request', objective: '汇总全部八份文档', constraints: ['保留全部来源'], expectedOutputs: ['完整汇总'],
    acceptanceCriteria: ['八份文档均覆盖一次'], references: [], confidence: 1, clarification: null,
    ...(count === undefined ? {} : { decomposition: { kind: 'mapReduce' as const,
      partitions: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, objective: `文档分组${i}`, expectedOutput: '来源与事实' })),
      synthesis: '归并全部原始事实与出处' } }) };
}
const response = (spec: InputIntentSpec) => Response.json({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ type: 'interpretation', spec }) } }] });
function fixture(maxPartitions: number | undefined, replies: InputIntentSpec[]) {
  const input = localModelInput(); input.message.text = '并行汇总八份独立文档'; input.config.inputAnalysis = { enabled: true };
  input.config.models = { default: 'test', services: { test: { baseUrl: 'https://provider.example/v1', model: 'test' } } };
  const work = initialTask(input).context.intents[0]!;
  if (maxPartitions !== undefined) work.payload.maxPartitions = maxPartitions;
  else delete work.payload.maxPartitions;
  const requests: { messages: { content: string }[] }[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init!.body))); const spec = replies.shift();
    if (!spec) throw new Error('unexpected extra provider call'); return response(spec);
  });
  const unavailable = async (): Promise<never> => { throw new Error('interpretation must not use tools'); };
  const scope: WorkScope = { authorizeAdditionalRequest: vi.fn(), regenerateModelOutput: vi.fn(),
    findSkills: unavailable, webFetch: unavailable, webSearch: unavailable };
  const adapter = new OpenAICompatibleAdapter(input.config, { transport, env: {}, clock: () => 0 });
  return { requests, transport, scope, run: () => adapter.execute(work, new AbortController().signal, scope) };
}

describe('MapReduce planning capacity protocol', () => {
  it('[BT_Q07] describes the fixed host ceiling and grouping all documents in the interpretation request', async () => {
    const f = fixture(4, [interpreted(4)]);

    await f.run();

    expect(JSON.parse(f.requests[0]!.messages[1]!.content).context.maxPartitions).toBe(4);
    expect(f.requests[0]!.messages[0]!.content).toContain('context.maxPartitions');
    expect(f.requests[0]!.messages[0]!.content).toContain('multiple documents');
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('[BT_Q10] repairs an eight-part output instead of applying or truncating it at a four-part ceiling', async () => {
    const f = fixture(4, [interpreted(8), interpreted(4)]);

    const output = await f.run();

    expect(output).toMatchObject({ type: 'interpretation', spec: interpreted(4) });
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.scope.regenerateModelOutput).toHaveBeenCalledWith('invalid_input_intent');
    expect(f.scope.authorizeAdditionalRequest).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('[BT_Q09] accepts the complete ordinary intent at capacity %s', async cap => {
    const f = fixture(cap, [interpreted()]);

    const output = await f.run();

    expect(output).toMatchObject({ type: 'interpretation', spec: interpreted() });
    expect(f.scope.regenerateModelOutput).not.toHaveBeenCalled();
  });

  it.each([0, 1, 4])('[BT_Q10] rejects decomposition above the host ceiling %s at the protocol boundary', cap => {
    expect(validInputIntent(interpreted(8), 'request', [], cap)).toBe(false);
  });

  it('[BT_Q12] retains the protocol maximum for historical work without a capacity field', async () => {
    const f = fixture(undefined, [interpreted(8)]);

    expect(await f.run()).toMatchObject({ type: 'interpretation', spec: interpreted(8) });
    expect(validInputIntent(interpreted(8), 'request', [])).toBe(true);
  });
});
