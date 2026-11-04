import { describe, it } from 'vitest';
import { legacyTaskContract, replayLegacyTrace, restoreLegacyTask, verifyLegacyDiagnostics } from './task-model-contract.js';
import type { Phase } from '../src/types.js';

describe('task model compatibility with the frozen pre-refactor XState model', () => {
  it.each(Object.keys(legacyTaskContract.seeds) as Phase[])('[BT_N01] restores the original %s snapshot without changing persisted data', phase => { restoreLegacyTask(phase); });
  it.each(legacyTaskContract.traces.map(trace => trace.name))('[BT_N02] [BT_N03] replays the original %s contract and every persistence boundary', name => {
    replayLegacyTrace(name);
  });
  it('[BT_N04] preserves the graph, ordered guards, initial and automatic microsteps and pure diagnostic results', verifyLegacyDiagnostics);
});
