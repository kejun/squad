import { describe, expect, it } from 'vitest';
import { debugInput, debugEventTemplate } from '../src/task-debug.js';
import { initialTask, persistTask, stepTask } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask } from '../src/task-inspection.js';
import type { TaskEvent } from '../src/types.js';

describe('same-computation diagnostic API', () => {
  it('[BT_V16] returns the original initial snapshot when collecting initialization evidence', () => {
    const input = debugInput();
    const diagnosed = inspectInitialTask(input);
    expect(persistTask(diagnosed.snapshot)).toEqual(persistTask(initialTask(input)));
  });

  it('[BT_V16] reports automatic STOP microsteps without altering the business result', () => {
    const initial = initialTask(debugInput());
    const event: TaskEvent = { type: 'STOP', id: 'stop', at: 1 };
    const stopped = inspectTask(initial, event);
    expect(persistTask(stopped.snapshot)).toEqual(persistTask(stepTask(initial, event)));
    expect(stopped.evidence.microsteps.map(s => [s.phase, s.automatic])).toEqual([
      ['stopping', false], ['ended', true],
    ]);
  });

  it('[BT_V16] reports a rejected self-assistance request without changing its outcome', () => {
    const initial = initialTask(debugInput());
    const event = { ...debugEventTemplate(initial, 'HELP'), id: 'self', target: 'A' } as TaskEvent;
    const rejected = inspectTask(initial, event);
    expect(persistTask(rejected.snapshot)).toEqual(persistTask(stepTask(initial, event)));
    expect(rejected.snapshot.context.reply.code).toBe('SELF_DEPENDENCY');
    expect(rejected.evidence.evaluations).toContainEqual(expect.objectContaining({ passed: false }));
  });

  it('[BT_V16] reports a local claim rejection followed by the applicable discussion claim', () => {
    const initial = initialTask(debugInput());
    const owner = stepTask(initial, { type: 'CLAIM', id: 'owner', at: 1, intentId: initial.context.intents[0]!.id });
    const discussion = stepTask(owner, { type: 'USER_INPUT', id: 'invite', at: 2, text: '大家讨论', reviewTargets: ['B'] });
    const event = { ...debugEventTemplate(discussion, 'CLAIM'), id: 'discussion', at: 3 } as TaskEvent;
    const observed = inspectTask(discussion, event);
    expect(persistTask(observed.snapshot)).toEqual(persistTask(stepTask(discussion, event)));
    expect(observed.evidence.evaluations.filter(e => e.event === 'CLAIM').map(e => [e.guard, e.passed]))
      .toEqual([['claimOwner', false], ['claimDiscussion', true]]);
  });

  it('[BT_V17] stops evaluating retry alternatives after a branch matches', () => {
    const initial = initialTask(debugInput());
    const help = stepTask(initial, { ...debugEventTemplate(initial, 'HELP'), id: 'help' } as TaskEvent);
    const failed = stepTask(help, { ...debugEventTemplate(help, 'RECORD_RESULT'), id: 'saved', at: 2 } as TaskEvent);
    const event = { ...debugEventTemplate(failed, 'RETRY_ASSISTANCE'), id: 'retry', at: 3 } as TaskEvent;
    const retry = inspectTask(failed, event);
    expect(persistTask(retry.snapshot)).toEqual(persistTask(stepTask(failed, event)));
    expect(retry.evidence.evaluations.filter(e => e.event === 'RETRY_ASSISTANCE').map(e => [e.guard, e.passed]))
      .toEqual([['retryReviewContinues', false], ['retryHasResult', true]]);
  });

  it('[BT_V17] reports a repeated STOP as no change instead of reusing an old rejection', () => {
    const stopped = stepTask(initialTask(debugInput()), { type: 'STOP', id: 'stop', at: 1 });
    stopped.context.reply = { ok: false, code: 'OLD_REJECTION', detail: 'previous event' };
    const empty = inspectTask(stopped, { type: 'STOP', id: 'again', at: 2 });
    expect(empty.evidence.evaluations.filter(e => e.event === 'STOP')).toEqual([
      { ruleId: 'ended:STOP:0', source: 'ended', event: 'STOP', guard: null, passed: true },
    ]);
    expect(empty.evidence.changed).toEqual([]);
  });
});
