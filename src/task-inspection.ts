import { getInitialMicrosteps, getMicrosteps } from 'xstate';
import { createTaskMachine, evaluateTask, persistTask, restoreTask, taskMachine, type TaskSnapshot } from './task.machine.js';
import { ruleId, taskGraph } from './task-structure.js';
import type { TaskContext, TaskEvent, TaskInput, Phase } from './types.js';

export interface GuardObservation {
  ruleId: string; source: string; event: string; guard: string | null; passed: boolean;
}
export interface DebugEvidence {
  schema: 1; definition: string; xstate: '5.33.3' | '6.0.0-beta.5';
  evaluations: GuardObservation[];
  microsteps: { from: Phase | null; phase: Phase; automatic: boolean; changed: string[] }[];
  changed: string[];
}
export interface InspectedTask { snapshot: TaskSnapshot; evidence: DebugEvidence }
/** The same rule selector supplies branch evidence during the pure microstep replay. */
function diagnosticMachine(evaluations: GuardObservation[]) {
  const seen = new WeakMap<TaskContext, Set<string>>();
  return createTaskMachine(({ source, event, order, guard, passed, context, value }) => {
    const id = ruleId(source, event, order);
    const key = JSON.stringify([value, id, passed]);
    let rules = seen.get(context);
    if (!rules) { rules = new Set(); seen.set(context, rules); }
    // v6 may select the same function transition again while computing a microstep.
    if (rules.has(key)) return;
    rules.add(key);
    evaluations.push({ ruleId: id, source, event, guard, passed });
  });
}
const changed = (before: TaskContext | undefined, after: TaskContext) => Object.keys(after).filter(key =>
  JSON.stringify(before?.[key as keyof TaskContext]) !== JSON.stringify(after[key as keyof TaskContext]));

function result(steps: TaskSnapshot[], before: TaskSnapshot | undefined, evaluations: GuardObservation[]): InspectedTask {
  const final = steps.at(-1);
  if (!final) throw new Error('Missing diagnostic snapshot');
  let previous = before;
  const microsteps = steps.map((snapshot, index) => {
    const item = { from: previous?.value as Phase | undefined ?? null, phase: snapshot.value as Phase,
      automatic: index > 0, changed: changed(previous?.context, snapshot.context) };
    previous = snapshot; return item;
  });
  return { snapshot: final,
    evidence: { schema: 1, definition: taskGraph().definition, xstate: '6.0.0-beta.5', evaluations, microsteps,
      changed: changed(before?.context, final.context) } };
}
export function inspectTask(snapshot: TaskSnapshot, event: TaskEvent): InspectedTask {
  const evaluations: GuardObservation[] = [], machine = diagnosticMachine(evaluations);
  const persisted = persistTask(snapshot);
  const steps = getMicrosteps(machine, restoreTask(persisted, machine), event).map(([next]) => activeStep(next));
  // The pure trace observes business branches. The transaction also drains internal actor messages.
  const final = evaluateTask(taskMachine, { snapshot: persisted, event });
  const observed = result(steps.length ? steps : [final], snapshot, evaluations);
  return { ...observed, snapshot: final };
}
export function inspectInitialTask(input: TaskInput): InspectedTask {
  const evaluations: GuardObservation[] = [], machine = diagnosticMachine(evaluations);
  const observed = result(getInitialMicrosteps(machine, input).map(([next]) => activeStep(next)), undefined, evaluations);
  return { ...observed, snapshot: restoreTask(persistTask(observed.snapshot)) };
}

function activeStep(snapshot: ReturnType<typeof getInitialMicrosteps<typeof taskMachine>>[number][0]): TaskSnapshot {
  if (snapshot.status === 'error') throw snapshot.error;
  if (snapshot.status !== 'active') throw new Error('Unexpected diagnostic task status: ' + snapshot.status);
  return snapshot;
}
