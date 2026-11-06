import { describe, expect, it } from 'vitest';
import { deliveryEvidence } from '../src/task/evidence.js';
import { skillResourceModel } from './skill-resource-evidence-fixture.js';
describe('skill resource delivery evidence', () => {
  it('[BT_F22] gives the check the actual complete resource and its provenance', () => {
    const { evidence } = skillResourceModel();
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]).toMatchObject({ stdout: '{"total":62500}', metadata: {
      status: 'succeeded', completeness: 'complete', sourceMember: 'A', resourceId: 'local:source:references/orders.json', resourceVersion: 'version1',
    } });
  });
  it.each(['paged', 'failed'] as const)('[BT_F22] does not present %s reading as complete content', mode => {
    const { evidence } = skillResourceModel(mode);
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]?.metadata.completeness).not.toBe('complete');
    expect(evidence.sources[0]?.stdout).toBeUndefined();
  });
  it('[BT_F22] rejects changed content after the candidate fixed its evidence', () => {
    const { model, check } = skillResourceModel();
    model.c.intents[0]!.localOperations![0]!.result!.data.content = 'changed';
    expect(deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)).toBeUndefined();
  });
  it('[BT_F22] excludes reading from an older goal', () => {
    const { model, check } = skillResourceModel();
    model.c.intents[0]!.goalVersion = 0;
    expect(deliveryEvidence(model.c, check)?.sources).toEqual([]);
  });
});
