import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { validInputIntent } from '../src/input-intent.js';
import { initialTask } from '../src/task.machine.js';
import type { InputIntentSpec } from '../src/types.js';
import type { WorkScope } from '../src/runner.js';
import { localModelInput } from './local-model-fixture.js';

function interpreted(count?: number): InputIntentSpec {
  return { action: 'request', objective: '汇总全部八份文档', constraints: ['保留全部来源'], expectedOutputs: ['完整汇总'],
    acceptanceCriteria: ['八份文档均覆盖一次'], references: [], confidence: 1, clarification: null,
    ...(count === undefined ? {} : { decomposition: { kind: 'mapReduce',
      partitions: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, objective: `文档分组${index}`, expectedOutput: '来源与事实' })),
      synthesis: '归并全部原始事实与出处' } }) };
}

/** One controlled adapter call sequence, prepared in Given and executed in When. */
export class CapacityAdapterScenario {
  readonly accepted: InputIntentSpec;
  readonly requests: { messages: { content: string }[] }[] = [];
  readonly repairs: string[] = []; readonly additional: string[] = [];
  readonly adapter: OpenAICompatibleAdapter; readonly work: ReturnType<typeof initialTask>['context']['intents'][number];
  readonly scope: WorkScope; output?: Awaited<ReturnType<OpenAICompatibleAdapter['execute']>>;
  aboveAccepted?: boolean; legacyAccepted?: boolean;
  constructor(readonly capacity: number | undefined, readonly repair = false) {
    const input = localModelInput(); input.message.text = '并行汇总八份独立文档'; input.config.inputAnalysis = { enabled: true };
    input.config.models = { default: 'test', services: { test: { baseUrl: 'https://provider.example/v1', model: 'test' } } };
    this.work = initialTask(input).context.intents[0]!;
    if (capacity === undefined) delete this.work.payload.maxPartitions; else this.work.payload.maxPartitions = capacity;
    this.accepted = interpreted(capacity === undefined ? 8 : capacity < 2 ? undefined : capacity);
    const replies = repair ? [interpreted(8), this.accepted] : [this.accepted];
    const unavailable = async (): Promise<never> => { throw new Error('interpretation must not use tools'); };
    this.scope = { authorizeAdditionalRequest: id => { this.additional.push(id); }, regenerateModelOutput: issue => { this.repairs.push(issue); }, findSkills: unavailable, webFetch: unavailable, webSearch: unavailable };
    this.adapter = new OpenAICompatibleAdapter(input.config, { env: {}, clock: () => 0, transport: async (_url, init) => {
      this.requests.push(JSON.parse(String(init!.body))); const spec = replies.shift(); assert(spec, 'Unexpected provider request');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'interpretation', spec }) } }] });
    } });
  }
  async run() { this.aboveAccepted = validInputIntent(interpreted(8), 'request', [], this.capacity); this.legacyAccepted = validInputIntent(interpreted(8), 'request', []); this.output = await this.adapter.execute(this.work, new AbortController().signal, this.scope); }
  assertResult() {
    assert.deepEqual(this.output, { type: 'interpretation', spec: this.accepted });
    assert.equal(this.requests.length, this.repair ? 2 : 1); assert.deepEqual(this.repairs, this.repair ? ['invalid_input_intent'] : []);
    assert.equal(this.additional.length, this.repair ? 1 : 0);
    assert.equal(JSON.parse(this.requests[0]!.messages[1]!.content).context.maxPartitions, this.capacity);
    if (this.repair) assert.equal(this.aboveAccepted, false);
    if (this.capacity === undefined) assert.equal(this.legacyAccepted, true);
  }
}
