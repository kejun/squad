import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { acceptanceCriteria } from '../src/delivery-acceptance.js';
import type { InputIntentSpec } from '../src/types.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';

export const websiteTask = '创建一个个人网站';
export const websiteObjective = '交付可浏览的个人网站';
export const websiteIntent: InputIntentSpec = {
  action: 'request', objective: websiteObjective, constraints: [], expectedOutputs: [], acceptanceCriteria: [],
  references: [], confidence: 0.95, clarification: null,
  okr: { keyResults: [{ text: '访客能从首页打开作品详情', status: 'pending' }] },
};

export function internalOkrModelGate() {
  const model = new CapacityModel(input => {
    input.message.text = websiteTask;
    input.analyzeRequest = true;
    input.goal = { text: websiteTask, constraints: [], criteria: [], requiredArtifacts: 0 };
  });
  model.claim(); model.consume(); assert(model.interpret(websiteIntent).ok);
  assert.equal(model.pending('owner').length, 1);
  assert.deepEqual(model.context.inputAnalyses?.[0]?.spec, websiteIntent);
  assert.deepEqual(acceptanceCriteria(model.context).map(item => item.text), [websiteObjective]);

  assert(model.send({ type: 'USER_INPUT', text: 'KR1 已达成' }).ok);
  const pending = model.pending('interpretation')[0]!;
  assert(pending);
  assert(model.send({ type: 'CLAIM', intentId: pending.id }).ok);
  const claimed = model.context.intents.find(work => work.id === pending.id)!;
  assert(model.send({ type: 'CONSUME', intentId: claimed.id, fence: claimed, attempt: claimed.attempt }).ok);
  const updated: InputIntentSpec = { ...websiteIntent, action: 'supplement',
    okr: { keyResults: [{ text: websiteIntent.okr!.keyResults[0]!.text, status: 'achieved' }] } };
  assert(model.send({ type: 'INTERPRETATION_RESULT', workId: claimed.id, fence: claimed, attempt: claimed.attempt,
    inputId: (claimed.payload.input as { id: string }).id, spec: updated }).ok);
  assert.equal(model.context.goalVersion, 1);
  assert.deepEqual(model.context.inputAnalyses?.at(-1)?.spec, updated);
  assert.equal(model.pending('owner').length, 1);
  assert.deepEqual(acceptanceCriteria(model.context).map(item => item.text), [websiteObjective]);

  const map = new CapacityModel(), spec = { ...capacityModelIntent(), okr: websiteIntent.okr! };
  map.claim(); map.consume(); assert(map.interpret(spec).ok);
  assert.equal(map.pending('assistance').length, spec.decomposition!.partitions.length);
  assert.equal(map.pending('owner').length, 0);
  assert.deepEqual((map.pending('assistance')[0]!.payload.inputIntents as { spec: InputIntentSpec }[])[0]?.spec, spec);

  const legacy = new CapacityModel();
  const ordinary = capacityModelIntent(); delete ordinary.decomposition;
  legacy.claim(); legacy.consume(); assert(legacy.interpret(ordinary).ok);
  assert.equal(legacy.pending('owner').length, 1);

  const forged = new CapacityModel();
  forged.claim(); forged.consume();
  const invented = { kind: 'artifact' as const, id: 'unavailable', taskId: 'previous' };
  assert.equal(forged.interpret({ ...spec, references: [invented] }).ok, false);
  assert.equal(forged.pending('owner').length, 0);
  assert.equal(forged.pending('assistance').length, 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) internalOkrModelGate();
