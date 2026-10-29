import { describe, expect, it } from 'vitest';
import { debugInput, debugEventTemplate } from '../src/task-debug.js';
import { initialTask, persistTask, stepTask, taskMachine } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask } from '../src/task-inspection.js';
import { plannedSandbox } from './discussion-debug-fixture.js';
import type { TaskEvent } from '../src/types.js';

describe('same-computation task diagnostics', () => {
  it('[BT_V16] keeps initial snapshots and STOP automatic microsteps equivalent', () => {
    const input = debugInput(), initial = initialTask(input), diagnosed = inspectInitialTask(input);
    expect(persistTask(diagnosed.snapshot)).toEqual(persistTask(initial));
    expect(diagnosed.snapshot.machine).toBe(taskMachine);
    const event: TaskEvent = { type: 'STOP', id: 'stop', at: 1 };
    const stopped = inspectTask(initial, event);
    expect(persistTask(stopped.snapshot)).toEqual(persistTask(stepTask(initial, event)));
    expect(stopped.evidence.microsteps.map(s => s.phase)).toEqual(['stopping', 'ended']);
    expect(stopped.evidence.microsteps.map(s => s.automatic)).toEqual([false, true]);
  });
  it('[BT_V16] captures rejection and local failure followed by a global discussion claim', () => {
    const initial = initialTask(debugInput());
    const help = { ...debugEventTemplate(initial, 'HELP'), id: 'self', target: 'A' } as TaskEvent;
    const rejected = inspectTask(initial, help);
    expect(persistTask(rejected.snapshot)).toEqual(persistTask(stepTask(initial, help)));
    expect(rejected.snapshot.context.reply.code).toBe('SELF_DEPENDENCY');
    expect(rejected.evidence.evaluations).toContainEqual(expect.objectContaining({ ruleId: 'running:HELP:0', passed: false }));
    const sandbox = plannedSandbox(), snapshot = sandbox.snapshot;
    // The facilitator is already inflight; create a fresh pending discussion from original input.
    const ownerClaim = stepTask(initial, { type: 'CLAIM', id: 'owner', at: 1, intentId: initial.context.intents[0]!.id });
    const discussion = stepTask(ownerClaim, { type: 'USER_INPUT', id: 'invite', at: 2, text: '所有人都参与讨论一下', reviewTargets: ['B'] });
    const event = { ...debugEventTemplate(discussion, 'CLAIM'), id: 'discussion', at: 3 } as TaskEvent;
    const observed = inspectTask(discussion, event);
    expect(persistTask(observed.snapshot)).toEqual(persistTask(stepTask(discussion, event)));
    expect(observed.evidence.evaluations.filter(e => e.event === 'CLAIM').map(e => [e.guard, e.passed]))
      .toEqual([['claimOwner', false], ['claimDiscussion', true]]);
    expect(snapshot.context.owner).toBe('A');
  });
  it('[BT_V17] stops evaluating retry branches after a match and captures explicit empty handling', () => {
    const initial = initialTask(debugInput());
    const help = stepTask(initial, { ...debugEventTemplate(initial, 'HELP'), id: 'help' } as TaskEvent);
    const failed = stepTask(help, { ...debugEventTemplate(help, 'RECORD_RESULT'), id: 'saved', at: 2 } as TaskEvent);
    const retryEvent = { ...debugEventTemplate(failed, 'RETRY_ASSISTANCE'), id: 'retry', at: 3 } as TaskEvent;
    const retry = inspectTask(failed, retryEvent);
    expect(persistTask(retry.snapshot)).toEqual(persistTask(stepTask(failed, retryEvent)));
    const evaluations = retry.evidence.evaluations.filter(e => e.event === 'RETRY_ASSISTANCE');
    expect(evaluations.map(e => [e.guard, e.passed])).toEqual([['retryReviewContinues', false], ['retryHasResult', true]]);
    expect(evaluations.some(e => e.ruleId === '*:RETRY_ASSISTANCE:2')).toBe(false);
    const stopped = stepTask(initial, { type: 'STOP', id: 'stop', at: 1 });
    stopped.context.reply = { ok: false, code: 'OLD_REJECTION', detail: 'previous event' };
    const empty = inspectTask(stopped, { type: 'STOP', id: 'again', at: 2 });
    expect(empty.evidence.evaluations.filter(e => e.event === 'STOP')).toEqual([
      { ruleId: 'ended:STOP:0', source: 'ended', event: 'STOP', guard: null, passed: true },
    ]);
    expect(empty.evidence.changed).toEqual([]);
  });
  it('[BT_V16] preserves budgets, stale fences, recovery and every step of a discussion', () => {
    const sandbox = plannedSandbox();
    for (const type of ['DISCUSSION_PLAN', 'CLAIM', 'DISCUSSION_RESULT', 'CLAIM', 'DISCUSSION_RESULT', 'DELIVER', 'CLAIM', 'DELIVER', 'CLAIM', 'CHECK_RESULT']) {
      const before = sandbox.snapshot, event = { ...debugEventTemplate(before, type), id: 'diagnose:' + type + ':' + before.context.nextSeq } as TaskEvent;
      const next = inspectTask(before, event);
      expect(persistTask(next.snapshot), type).toEqual(persistTask(stepTask(before, event)));
      sandbox.send(JSON.stringify(event));
    }
    const input = debugInput(); input.config.limits.ordinary = 0;
    const limited = initialTask(input);
    for (const event of [
      { ...debugEventTemplate(limited, 'CLAIM'), id: 'budget' },
      { ...debugEventTemplate(limited, 'HELP_RESULT'), id: 'stale', fence: { epoch: 99, goalVersion: 99 } },
      { ...debugEventTemplate(limited, 'RECOVER'), id: 'recover' },
    ]) expect(persistTask(inspectTask(limited, event as TaskEvent).snapshot)).toEqual(persistTask(stepTask(limited, event as TaskEvent)));
  });
});
