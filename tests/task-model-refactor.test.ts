import { describe, expect, it } from 'vitest';
import { legacyTaskContract, replayLegacyTrace, restoreLegacyTask, verifyLegacyDiagnostics } from './task-model-contract.js';
import { localModelInput } from './local-model-fixture.js';
import { inspectTask } from '../src/task-inspection.js';
import { initialTask, persistTask, restoreTask, stepTask } from '../src/task.machine.js';
import type { Phase, TaskContext, TaskEvent } from '../src/types.js';

describe('task model compatibility with the frozen pre-refactor XState model', () => {
  it.each(Object.keys(legacyTaskContract.seeds) as Phase[])('[BT_N01] restores the original %s snapshot without changing persisted data', phase => { restoreLegacyTask(phase); });
  it.each(legacyTaskContract.traces.map(trace => trace.name))('[BT_N02] [BT_N03] replays the original %s contract and every persistence boundary', name => {
    replayLegacyTrace(name);
  });
  it('[BT_N04] preserves the graph, ordered guards, initial and automatic microsteps and pure diagnostic results', verifyLegacyDiagnostics);

  it('[BT_X02] records the same stall settlement and guard as the normal step', () => {
    const saved = structuredClone(persistTask(initialTask(localModelInput()))) as { value: Phase; context: TaskContext };
    saved.value = 'checking';
    saved.context.intents[0]!.status = 'done';
    const snapshot = restoreTask(saved);
    const event: TaskEvent = { type: 'TICK', id: 'due', at: snapshot.context.nextCheckAt };

    const inspected = inspectTask(snapshot, event);

    expect(inspected.snapshot.value).toBe('ended');
    expect(persistTask(inspected.snapshot)).toEqual(persistTask(stepTask(snapshot, event)));
    expect(inspected.evidence.evaluations).toContainEqual({
      ruleId: 'checking:TICK:0', source: 'checking', event: 'TICK', guard: 'workflowStalled', passed: true,
    });
  });
});
