import { createMachine, getInitialMicrosteps, getMicrosteps } from 'xstate';
import { persistTask, restoreTask, taskMachine, type TaskSnapshot } from './task.machine.js';
import { ruleId, taskGraph, type ConfigNode } from './task-structure.js';
import type { TaskContext, TaskEvent, TaskInput, Phase } from './types.js';

export interface GuardObservation {
  ruleId: string; source: string; event: string; guard: string | null; passed: boolean;
}
export interface DebugEvidence {
  schema: 1; definition: string; xstate: '5.33.3';
  evaluations: GuardObservation[];
  microsteps: { from: Phase | null; phase: Phase; automatic: boolean; changed: string[] }[];
  changed: string[];
}
export interface InspectedTask { snapshot: TaskSnapshot; evidence: DebugEvidence }
type GuardArgs = { context: TaskContext; event: TaskEvent };

/** Per-call diagnostic projection. Only wraps guards; actions and context stay original.
 * Rebind snapshots to this machine: XState resolves guards from snapshot.machine.
 * No global collector, actor.start(), send(), or external action execution.
 */
function diagnosticMachine(evaluations: GuardObservation[]) {
  const wrap = (node: ConfigNode, source: string): ConfigNode => {
    if (source !== '*' && node.states) throw new Error('Diagnostic projection requires the flat task model');
    const transitions = (value: unknown, event: string) => (Array.isArray(value) ? value : [value]).map((raw, order) => {
      const original: { guard?: unknown; target?: string } = typeof raw === 'string' ? { target: raw } : (raw ?? {});
      const guard = original.guard;
      const name = typeof guard === 'string' ? guard : null;
      const implementation = name ? taskMachine.implementations.guards[name] : guard;
      if (guard !== undefined && typeof implementation !== 'function') throw new Error('Unsupported diagnostic guard');
      return { ...original, guard: (args: GuardArgs) => {
        const passed = guard === undefined || (implementation as (args: GuardArgs, params: undefined) => boolean)(args, undefined);
        evaluations.push({ ruleId: ruleId(source, event, order), source, event, guard: name, passed });
        return passed;
      } };
    });
    return { ...node,
      ...(node.on ? { on: Object.fromEntries(Object.entries(node.on).map(([event, value]) => [event, transitions(value, event)])) } : {}),
      ...(node.always ? { always: transitions(node.always, '@always') } : {}),
      ...(node.states ? { states: Object.fromEntries(Object.entries(node.states).map(([state, child]) => [state, wrap(child, state)])) } : {}),
    };
  };
  return createMachine(wrap(taskMachine.config as ConfigNode, '*') as typeof taskMachine.config,
    taskMachine.implementations) as typeof taskMachine;
}
const changed = (before: TaskContext | undefined, after: TaskContext) => Object.keys(after).filter(key =>
  JSON.stringify(before?.[key as keyof TaskContext]) !== JSON.stringify(after[key as keyof TaskContext]));

function result(steps: Array<[TaskSnapshot, unknown[]]>, before: TaskSnapshot | undefined, evaluations: GuardObservation[]): InspectedTask {
  const final = steps.at(-1)?.[0];
  if (!final) throw new Error('Missing diagnostic snapshot');
  let previous = before;
  const microsteps = steps.map(([snapshot], index) => {
    const item = { from: previous?.value as Phase | undefined ?? null, phase: snapshot.value as Phase,
      automatic: index > 0, changed: changed(previous?.context, snapshot.context) };
    previous = snapshot; return item;
  });
  return { snapshot: restoreTask(structuredClone(persistTask(final))),
    evidence: { schema: 1, definition: taskGraph().definition, xstate: '5.33.3', evaluations, microsteps,
      changed: changed(before?.context, final.context) } };
}
export function inspectTask(snapshot: TaskSnapshot, event: TaskEvent): InspectedTask {
  const evaluations: GuardObservation[] = [], machine = diagnosticMachine(evaluations);
  const bound = machine.restoreSnapshot(structuredClone(persistTask(snapshot)) as never, {} as never);
  return result(getMicrosteps(machine, bound, event), snapshot, evaluations);
}
export function inspectInitialTask(input: TaskInput): InspectedTask {
  const evaluations: GuardObservation[] = [], machine = diagnosticMachine(evaluations);
  return result(getInitialMicrosteps(machine, input), undefined, evaluations);
}
