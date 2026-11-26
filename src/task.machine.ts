import { createActor, setup, types, type ActorRefFrom, type SnapshotFrom, type StateValue, type TypeSchema } from 'xstate';
import { restoreActor } from 'xstate/persist';
import type { Phase, TaskContext, TaskEvent, TaskInput } from './types.js';
import { taskActions } from './task/actions.js';
import { createTaskContext } from './task/context.js';
import { taskGuards } from './task/guards.js';
import { incompatibleExecution } from './task/facts.js';
import { taskLifecycle, type TaskRule, type TaskRules, type TaskRuleState } from './task/lifecycle.js';
import { executionId, executionMachine, executionTicket, isTerminalExecutionState, type ExecutionTicket } from './task/execution.machine.js';
import { persistTaskWire, restorePersistedTaskActor } from './task/persistence.js';

export { workLaneAvailable } from './task/facts.js';
export { assistanceRetryProblem } from './task/assistance.js';
export { executionId } from './task/execution.machine.js';

type TaskEventSchemas = { [E in TaskEvent as E['type']]: TypeSchema<Omit<E, 'type'>> };
const eventNames = new Set([
  ...Object.keys(taskLifecycle.on), ...Object.values(taskLifecycle.states).flatMap(state => Object.keys(state.on)),
  'EXECUTION_START', 'EXECUTION_RECONCILE', 'BOUNDARY', 'DISCUSSION_HANDOFF',
]);
eventNames.delete('*');
const taskEventSchemas = Object.fromEntries([...eventNames].map(name => [name, types()])) as TaskEventSchemas;
const executionChildSchemas: Record<ReturnType<typeof executionId>, TypeSchema<ActorRefFrom<typeof executionMachine>>> = {};
const taskSetup = setup({
  schemas: { context: types<TaskContext>(), input: types<TaskInput>(), events: taskEventSchemas, children: executionChildSchemas },
  actors: { execution: executionMachine },
});

export interface TaskRuleObservation {
  source: string; event: string; order: number; guard: string | null; passed: boolean;
  context: TaskContext; value: StateValue;
}
type ObserveRule = (rule: TaskRuleObservation) => void;
type TaskActorEvent = TaskEvent | { type: 'xstate.done.actor' } | { type: 'xstate.error.actor' };
interface TaskRef { send(event: TaskEvent): void }
interface TaskTransitionEffects {
  spawn(source: 'execution', options: { id: string; input: ExecutionTicket }): unknown;
  sendTo(target: TaskRef, event: TaskEvent): void;
}

function isRuleList(rules: TaskRules): rules is readonly TaskRule[] { return Array.isArray(rules); }

function compileRules(source: string, eventName: string, rules: TaskRules, observeRule: ObserveRule | undefined) {
  const ordered = isRuleList(rules) ? rules : [rules];
  return ({ context, event, self, value }: { context: TaskContext; event: TaskActorEvent; self: TaskRef; value: StateValue }, enq: TaskTransitionEffects) => {
    if (event.type === 'xstate.done.actor' || event.type === 'xstate.error.actor') return;
    for (const [order, rule] of ordered.entries()) {
      const name = typeof rule.guard === 'string' ? rule.guard : null;
      const guard = typeof rule.guard === 'string' ? taskGuards[rule.guard] : rule.guard;
      const passed = guard?.({ context, event }) ?? true;
      observeRule?.({ source, event: eventName, order, guard: name, passed, context, value });
      if (!passed) continue;
      const actions = typeof rule.actions === 'string' ? [rule.actions] : rule.actions ?? [];
      let next = context;
      for (const name of actions) {
        next = { ...next, ...taskActions[name]({ context: next, event }) };
        if (name === 'apply' && event.type === 'CLAIM' && next.reply.ok) {
          const work = next.intents.find(work => work.id === event.intentId && work.status === 'inflight');
          if (work) enq.spawn('execution', { id: executionId(work.id, work.attempt), input: executionTicket(next.taskId, work) });
        }
        if (String(event.type) !== 'xstate.init') enq.sendTo(self, { type: 'EXECUTION_RECONCILE', id: event.id, at: event.at });
      }
      return { ...(rule.target === undefined ? {} : { target: rule.target }), ...(next === context ? {} : { context: next }) };
    }
    // Refusal leaves ancestor and wildcard candidates eligible.
    return undefined;
  };
}

type TaskHandler = ReturnType<typeof compileRules>;
type CompiledTaskNode<State extends TaskRuleState> = {
  on: { [Event in keyof NonNullable<State['on']>]-?: TaskHandler };
  always?: TaskHandler;
};

function compileNode<State extends TaskRuleState>(source: string, state: State, observeRule: ObserveRule | undefined): CompiledTaskNode<State> {
  const on = Object.fromEntries(
    Object.entries(state.on ?? {}).map(([event, rules]) => [event, compileRules(source, event, rules, observeRule)]),
  ) as CompiledTaskNode<State>['on'];
  return {
    on,
    ...(state.always ? { always: compileRules(source, '@always', state.always, observeRule) } : {}),
  };
}

/** Business rule selection stays synchronous; actor messages are drained before commit. */
export function createTaskMachine(observeRule?: ObserveRule) {
  const root = compileNode('*', taskLifecycle, observeRule);
  const states = Object.fromEntries(
    Object.entries(taskLifecycle.states).map(([phase, state]) => [phase, compileNode(phase, state, observeRule)]),
  ) as { [P in Phase]: CompiledTaskNode<(typeof taskLifecycle.states)[P]> };
  return taskSetup.createMachine({
    id: taskLifecycle.id, initial: taskLifecycle.initial,
    context: ({ input }) => createTaskContext(input),
    ...root,
    states,
    on: {
      ...root.on,
      'xstate.done.actor': {},
      EXECUTION_START: ({ context, event, children }, enq) => {
        const work = context.intents.find(work => work.id === event.intentId && work.attempt === event.attempt && work.status === 'inflight'
          && work.epoch === context.epoch && work.goalVersion === context.goalVersion
          && (work.kind === 'cancel' || !context.stopped && context.outcome === null && !incompatibleExecution(context))
          && (work.deadline === null || event.at < work.deadline));
        if (!work) return;
        const child = children[executionId(work.id, event.attempt)];
        if (!child) throw new Error('Missing execution permit for claimed work');
        enq.sendTo(child, { type: 'START', ticket: executionTicket(context.taskId, work) });
      },
      EXECUTION_RECONCILE: ({ context, children }, enq) => {
        for (const child of Object.values(children)) {
          const permit = child?.getSnapshot();
          if (!child || !permit || permit.status !== 'active' || isTerminalExecutionState(permit.value)) continue;
          const work = context.intents.find(work => work.id === permit.context.intentId);
          if (work) enq.sendTo(child, { type: 'PARENT_FACTS', status: work.status, attempt: work.attempt,
            stopped: context.stopped || context.outcome !== null || incompatibleExecution(context),
            fence: { epoch: context.epoch, goalVersion: context.goalVersion } });
        }
        return {};
      },
    },
  });
}

export const taskMachine = createTaskMachine();
export type TaskSnapshot = Extract<SnapshotFrom<typeof taskMachine>, { status: 'active' }>;
export function persistTask(snapshot: TaskSnapshot): unknown { return persistTaskWire(taskMachine.getPersistedSnapshot(snapshot)); }
/** Dormant restore constructs native child refs but cannot start work or external I/O. */
export function restoreTask(value: unknown, machine: typeof taskMachine = taskMachine): TaskSnapshot {
  const snapshot = restorePersistedTaskActor(machine, value).getSnapshot();
  if (snapshot.status !== 'active') throw new Error('Task snapshot must remain resumable');
  return snapshot;
}
export function taskPhase(snapshot: TaskSnapshot): Phase { return snapshot.value as Phase; }

/** Drain a transaction-local mailbox before detaching the result from its actor system. */
export function evaluateTask(seed: { input: TaskInput } | { snapshot: TaskSnapshot; event: TaskEvent }): TaskSnapshot {
  // Snapshots produced by the machine or checked at storage ingress are already canonical.
  const actor = 'input' in seed
    ? createActor(taskMachine, { input: seed.input })
    : restoreActor(taskMachine, taskMachine.getPersistedSnapshot(seed.snapshot));
  let failure: unknown;
  actor.subscribe({ error: error => { failure = error; } });
  try {
    actor.start();
    if ('event' in seed) actor.send(seed.event);
    if (failure) throw failure;
    const detached = restoreActor(taskMachine, actor.getPersistedSnapshot()).getSnapshot();
    if (detached.status !== 'active') throw new Error('Task snapshot must remain resumable');
    return detached;
  } finally { actor.stop(); }
}
export function initialTask(input: TaskInput): TaskSnapshot { return evaluateTask({ input }); }
export function stepTask(snapshot: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  // A check already in flight before removal may still include retired per-partition judgments.
  const current = event.type === 'CHECK_RESULT' && Array.isArray(event.criteriaResults)
    ? { ...event, criteriaResults: event.criteriaResults.filter(item => typeof item?.criterionId !== 'string' || !item.criterionId.startsWith('map-recovery:')) } : event;
  return evaluateTask({ snapshot, event: current });
}
export function executionState(snapshot: TaskSnapshot, intentId: string, attempt: number) {
  return snapshot.children[executionId(intentId, attempt)]?.getSnapshot().value;
}
/** Evaluate a one-use permit in the model; the engine must commit `snapshot` before returning `allowed`. */
export function startTaskExecution(snapshot: TaskSnapshot, intentId: string, attempt: number, at: number, step: typeof stepTask = stepTask): { snapshot: TaskSnapshot; allowed: boolean } {
  if (executionState(snapshot, intentId, attempt) !== 'authorized') return { snapshot, allowed: false };
  const next = step(snapshot, { type: 'EXECUTION_START', id: `start:${intentId}:${attempt}`, intentId, attempt, at });
  return { snapshot: next, allowed: executionState(next, intentId, attempt) === 'running' };
}
