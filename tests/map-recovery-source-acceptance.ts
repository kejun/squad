import assert from 'node:assert/strict';
import { PartitionResilienceEngineFixture } from './partition-resilience-acceptance.js';
import { recoverySourcePreparation, recoverySourceInput, submitRecoverySource,
  assertRecoverySourceRejected } from './map-recovery-source-model-fixture.js';

/** Real public Engine and SQLite transactions; physical results are controlled host observations. */
export function recoverySourceEngineAcceptance(kind: string) {
  const fixture = new PartitionResilienceEngineFixture(recoverySourceInput(kind));
  try {
    const scenario = recoverySourcePreparation(kind, false, false, fixture);
    submitRecoverySource(scenario); assertRecoverySourceRejected(scenario);
    const sources = fixture.context.intents.flatMap(work => work.hostAcquisitions ?? []);
    assert(sources.some(source => source.operationId === scenario.actualSources[0]!.operation.id));
    assert(!sources.some(source => source.operationId === scenario.unrelated.id));
    fixture.reopen(); fixture.reopen();
    assertRecoverySourceRejected(scenario);
    assert.deepEqual(fixture.context.intents.flatMap(work => work.hostAcquisitions ?? []), sources);
    return { resourceKind: kind, issue: fixture.context.candidate!.deliveryIssue!.code,
      checkCalls: 0, resolutions: 0, persistence: 'SQLite reopened twice',
      boundary: 'Actual Engine with distinct complete CLI observations; OS process integration is separate' };
  } finally { fixture.close(); }
}
