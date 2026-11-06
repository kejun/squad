import { assert, describe, expect, it } from 'vitest';
import { deliveryEvidence } from '../src/task/evidence.js';
import { skillResourceModel } from './skill-resource-evidence-fixture.js';
describe('skill resource delivery evidence', () => {
  it('[BT_F22] gives the check the actual complete resource and its provenance', () => {
    const { evidence } = skillResourceModel();
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]).toMatchObject({ stdout: '{"total":62500}', metadata: {
      status: 'succeeded', completeness: 'complete', sourceMember: 'A', resourceId: 'local:source:references/orders.json', resourceVersion: 'version1',
      capturedContentHash: 'a'.repeat(64), stdoutBytes: 15,
    } });
  });
  it.each(['paged', 'failed'] as const)('[BT_F22] does not present %s reading as complete content', mode => {
    const { evidence } = skillResourceModel(mode);
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]?.metadata.completeness).not.toBe('complete');
    expect(evidence.sources[0]?.stdout).toBeUndefined();
    expect(evidence.sources[0]?.metadata.capturedContentHash).toBeNull();
  });
  it('[BT_F22] rejects changed content after the candidate fixed its evidence', () => {
    const { model, check } = skillResourceModel();
    model.c.intents[0]!.localOperations![0]!.result!.data.content = '{"total":62501}';
    expect(deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)).toBeUndefined();
  });
  it('[BT_F22] excludes reading from an older goal', () => {
    const { model, check } = skillResourceModel();
    model.c.intents[0]!.goalVersion = 0;
    expect(deliveryEvidence(model.c, check)?.sources).toEqual([]);
  });
  it('[BT_F22] rejects a legacy resource reference without its frozen receipt snapshot', () => {
    const { model, check } = skillResourceModel();
    const reference = model.c.deliveryCycle?.evidence?.[0];
    assert(reference);
    const legacy = { id: reference.id, stdoutHash: reference.stdoutHash, stderrHash: reference.stderrHash };
    expect(deliveryEvidence(model.c, check, [legacy])).toBeUndefined();
  });
  it.each([
    ['hash', 'b'.repeat(64)],
    ['skillVersion', 'version2'],
    ['nextOffset', 15],
  ])('[BT_F22] rejects a changed %s in a frozen resource receipt', (field, value) => {
    const { model, check } = skillResourceModel();
    model.c.intents[0]!.localOperations![0]!.result!.data[field as string] = value;
    expect(deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)).toBeUndefined();
  });
});
