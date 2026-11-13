import { createActor, setup, type InspectionEvent, type SnapshotFrom } from 'xstate';
import type { Phase, TaskContext, TaskEvent, TaskInput } from './types.js';
import { taskActions } from './task/actions.js';
import { createTaskContext } from './task/context.js';
import { taskGuards } from './task/guards.js';
import { incompatibleExecution } from './task/facts.js';
import { taskLifecycle } from './task/lifecycle.js';
import { restoreDeliveryStage } from './task/delivery-cycle.js';
import { restoreMapQueue } from './task/map-queue.js';
import { executionId, executionMachine, executionTicket, type ExecutionEvent } from './task/execution.machine.js';

export { workLaneAvailable } from './task/facts.js';
export { assistanceRetryProblem } from './task/assistance.js';
export { executionId } from './task/execution.machine.js';

const actorSetup = setup({
  types: { context: {} as TaskContext, events: {} as TaskEvent, input: {} as TaskInput },
  actors: { execution: executionMachine },
});
const spawnExecution = actorSetup.assign(({ context, event, spawn }) => {
  if (event.type !== 'CLAIM' || !context.reply.ok) return {};
  const work = context.intents.find(work => work.id === event.intentId && work.status === 'inflight');
  if (work) spawn('execution', { id: executionId(work.id, work.attempt), input: executionTicket(context.taskId, work) });
  return {};
});
const reconcileExecutions = actorSetup.enqueueActions(({ context, event, self, enqueue }) => {
  // No execution actors can exist before the initial task transition.
  if (String(event.type) === 'xstate.init') return;
  const children = self.getSnapshot().children;
  const ids = new Set(Object.keys(children).filter(id => children[id]?.getSnapshot().status === 'active'));
  for (const id of ids) {
    const ticket = children[id]?.getSnapshot().context;
    const work = ticket ? context.intents.find(work => work.id === ticket.intentId)
      : context.intents.find(work => executionId(work.id, work.attempt) === id);
    if (work) enqueue.sendTo(id, { type: 'PARENT_FACTS', status: work.status, attempt: work.attempt, stopped: context.stopped || context.outcome !== null || incompatibleExecution(context),
      fence: { epoch: context.epoch, goalVersion: context.goalVersion } } satisfies ExecutionEvent);
  }
});
// Every business update remains pure. Only declared internal actor messages are drained here.
const actions = Object.fromEntries(Object.entries(taskActions).map(([name, action]) => [name,
  actorSetup.enqueueActions(({ enqueue, event }) => {
    enqueue(action);
    if (name === 'apply') enqueue(spawnExecution);
    if (String(event.type) !== 'xstate.init') enqueue.sendTo(({ self }) => self, { type: 'EXECUTION_RECONCILE', id: event.id, at: event.at });
  }),
])) as { [K in keyof typeof taskActions]: ReturnType<typeof actorSetup.enqueueActions> };

export const taskMachine = actorSetup.extend({
  actions: { ...actions, reconcileExecutions, startExecution: actorSetup.enqueueActions(({ context, event, enqueue }) => {
    if (event.type !== 'EXECUTION_START') return;
    const work = context.intents.find(work => work.id === event.intentId)!;
    enqueue.sendTo(executionId(work.id, event.attempt), { type: 'START', ticket: executionTicket(context.taskId, work) } satisfies ExecutionEvent);
  }) },
  guards: { ...taskGuards, executionCurrent: ({ context, event }) => event.type === 'EXECUTION_START'
    && context.intents.some(work => work.id === event.intentId && work.attempt === event.attempt && work.status === 'inflight'
      && work.epoch === context.epoch && work.goalVersion === context.goalVersion && (work.kind === 'cancel' || !context.stopped && context.outcome === null && !incompatibleExecution(context))
      && (work.deadline === null || event.at < work.deadline)) },
}).createMachine({
  ...taskLifecycle,
  context: ({ input }) => createTaskContext(input),
  on: { ...taskLifecycle.on, ...{ ['xstate.done.actor.*']: {} }, EXECUTION_START: { guard: 'executionCurrent', actions: 'startExecution' }, EXECUTION_RECONCILE: { actions: 'reconcileExecutions' } },
});

export type TaskSnapshot = SnapshotFrom<typeof taskMachine>;
export function persistTask(snapshot: TaskSnapshot): unknown { return taskMachine.getPersistedSnapshot(snapshot); }
/** Dormant restore constructs native child refs but cannot start work or external I/O. */
export function restoreTask(value: unknown): TaskSnapshot {
  const snapshot = createActor(taskMachine, { snapshot: value as never, input: undefined as never }).getSnapshot();
  restoreDeliveryStage(snapshot.context);
  restoreMapQueue(snapshot.context);
  return snapshot;
}
export function taskPhase(snapshot: TaskSnapshot): Phase { return snapshot.value as Phase; }

/** Transaction-local actor system: no promises/timers/I/O actors; persist only after its mailbox drains. */
export function evaluateTask(machine: typeof taskMachine, seed: { input: TaskInput } | { snapshot: unknown; event: TaskEvent }, inspect?: (event: InspectionEvent) => void): TaskSnapshot {
  const actor = createActor(machine, { ...('input' in seed ? { input: seed.input } : { snapshot: seed.snapshot as never, input: undefined as never }), ...(inspect ? { inspect } : {}) });
  let failure: unknown;
  actor.subscribe({ error: error => { failure = error; } });
  try {
    actor.start();
    if ('event' in seed) actor.send(seed.event);
    if (failure) throw failure;
    const saved = actor.getPersistedSnapshot();
    return restoreTask(saved);
  } finally { actor.stop(); }
}
export function initialTask(input: TaskInput): TaskSnapshot { return evaluateTask(taskMachine, { input }); }
export function stepTask(snapshot: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  // A check already in flight before removal may still include retired per-partition judgments.
  const current = event.type === 'CHECK_RESULT' && Array.isArray(event.criteriaResults)
    ? { ...event, criteriaResults: event.criteriaResults.filter(item => typeof item?.criterionId !== 'string' || !item.criterionId.startsWith('map-recovery:')) } : event;
  return evaluateTask(taskMachine, { snapshot: persistTask(snapshot), event: current });
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
