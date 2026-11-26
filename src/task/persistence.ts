import { isMachineSnapshot, type AnyStateMachine, type InspectionEvent, type Snapshot } from 'xstate';
import { restoreActor } from 'xstate/persist';
import type { Intent, TaskContext } from '../types.js';
import { restoreDeliveryStage } from './delivery-cycle.js';
import { executionId, executionLifecycle, executionTicket, isTerminalExecutionState } from './execution.machine.js';
import { restoreMapQueue } from './map-queue.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTaskContext(value: unknown): value is TaskContext {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.taskId === 'string' && !!value.taskId && Array.isArray(value.intents);
}

function taskCheckpoint(value: unknown) {
  if (!isRecord(value) || value.status !== 'active' || !isRecord(value.children)
    || !isTaskContext(value.context)) {
    throw new Error('Incompatible task snapshot');
  }
  return { ...value, value: value.value, historyValue: value.historyValue, children: value.children, context: value.context,
    status: 'active' as const, output: undefined, error: undefined };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validExecutionTicket(ticket: Record<string, unknown>, id: string, taskId: string, intents: Map<string, Intent>, terminal: boolean) {
  const work = typeof ticket.intentId === 'string' ? intents.get(ticket.intentId) : undefined;
  const attempt = ticket.attempt;
  if (!work || !positiveInteger(attempt) || !positiveInteger(work.attempt) || attempt > work.attempt
    || (!terminal && attempt !== work.attempt) || id !== executionId(work.id, attempt)
    || typeof ticket.target !== 'string' || !ticket.target || typeof ticket.kind !== 'string'
    || !positiveInteger(ticket.epoch) || !positiveInteger(ticket.goalVersion)) return false;
  const expected = executionTicket(taskId, { ...work, attempt });
  return Object.entries(expected).every(([key, value]) => ticket[key] === value);
}

function executionCheckpoint(child: unknown, id: string, taskId: string, intents: Map<string, Intent>, native: boolean) {
  if (!isRecord(child) || child.src !== 'execution' || child.remote === true
    || !isRecord(child.snapshot) || !isRecord(child.snapshot.context) || !isRecord(child.snapshot.children)
    || typeof child.snapshot.value !== 'string' || !Object.hasOwn(executionLifecycle.states, child.snapshot.value)) {
    throw new Error(`Incompatible task execution snapshot: ${id}`);
  }
  const snapshot = child.snapshot;
  const terminal = isTerminalExecutionState(snapshot.value);
  const expectedStatus = terminal ? 'done' : 'active';
  // XState v6 keeps terminal children inert so their completed state is still addressable.
  const validStatus = snapshot.status === expectedStatus || (native && terminal && snapshot.status === 'active');
  if (!validStatus || !validExecutionTicket(child.snapshot.context, id, taskId, intents, terminal))
    throw new Error(`Incompatible task execution snapshot: ${id}`);
  return snapshot;
}

function executionCheckpoints(saved: ReturnType<typeof taskCheckpoint>, native = false) {
  const intents = new Map(saved.context.intents.map(work => [work.id, work]));
  return Object.entries(saved.children).map(([id, child]) =>
    [id, executionCheckpoint(child, id, saved.context.taskId, intents, native)] as const);
}

export function restorePersistedTaskActor<TMachine extends AnyStateMachine>(
  machine: TMachine, value: unknown, inspect?: (event: InspectionEvent) => void,
) {
  const saved = taskCheckpoint(value);
  const children = executionCheckpoints(saved);
  // Existing read migrations must run before XState takes ownership of the context.
  const context = structuredClone(saved.context);
  restoreDeliveryStage(context);
  restoreMapQueue(context);
  const checkpoint = { ...saved, context };
  const actor = restoreActor(machine, checkpoint, inspect ? { inspect } : undefined);
  const snapshot: unknown = actor.getSnapshot();
  if (!isMachineSnapshot(snapshot)) throw new Error('Incompatible task snapshot');
  if (snapshot.status === 'error') throw new Error('Incompatible task snapshot', { cause: snapshot.error });
  for (const [id] of children) {
    const child = snapshot.children[id]?.getSnapshot();
    if (!child || child.status === 'error') throw new Error(`Incompatible task execution snapshot: ${id}`, { cause: child?.error });
  }
  return actor;
}

/** Task clocks are stored in context and every execution child has an explicit ID. */
export function persistTaskWire(value: Snapshot<unknown>): unknown {
  const saved = taskCheckpoint(value);
  return {
    status: saved.status,
    value: saved.value,
    historyValue: saved.historyValue,
    context: saved.context,
    children: Object.fromEntries(executionCheckpoints(saved, true).map(([id, snapshot]) =>
      [id, { src: 'execution', snapshot: {
        status: isTerminalExecutionState(snapshot.value) ? 'done' : snapshot.status,
        value: snapshot.value,
        historyValue: snapshot.historyValue,
        context: snapshot.context,
        children: snapshot.children,
        output: snapshot.output,
        error: snapshot.error,
      } }])),
  };
}
