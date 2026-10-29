import { taskMachine } from './task.machine.js';

export interface MachineTransition {
  id: string; order: number; source: string; target: string | null; event: string;
  guards: string[]; actions: string[];
}
export interface ConfigNode {
  on?: Record<string, unknown>; always?: unknown; states?: Record<string, ConfigNode>;
}
export interface MachineGraph {
  id: string; definition: string; initial: string; states: string[]; transitions: MachineTransition[];
}
export const ruleId = (source: string, event: string, order: number) => `${source}:${event}:${order}`;
function names(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(item =>
    typeof item === 'string' ? item : typeof item === 'function' ? item.name || '匿名函数'
      : item && typeof item === 'object' && 'type' in item ? String(item.type) : '匿名实现');
}
/** A structural fingerprint, not a claim about the source/implementation version. */
function fingerprint(text: string) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}
export function taskGraph(): MachineGraph {
  const config = taskMachine.config as ConfigNode;
  const transitions: MachineTransition[] = [];
  const collect = (node: ConfigNode, source: string) => {
    const entries = [...Object.entries(node.on ?? {}), ...(node.always ? [['@always', node.always] as const] : [])];
    for (const [event, value] of entries) {
      (Array.isArray(value) ? value : [value]).forEach((raw, order) => {
        const t = typeof raw === 'string' ? { target: raw } : (raw ?? {}) as { target?: string | string[]; guard?: unknown; actions?: unknown };
        const targets = t.target === undefined ? [null] : Array.isArray(t.target) ? t.target : [t.target];
        for (const target of targets) transitions.push({ id: ruleId(source, event, order), order, source, event,
          target: target?.replace(/^#botTeamTask\./, '').replace(/^\./, '') ?? null,
          guards: names(t.guard), actions: names(t.actions) });
      });
    }
  };
  collect(config, '*');
  for (const [state, node] of Object.entries(config.states ?? {})) collect(node, state);
  return { id: taskMachine.id, definition: fingerprint(JSON.stringify(transitions)),
    initial: String(taskMachine.config.initial), states: Object.keys(config.states ?? {}), transitions };
}
export function stateTransitions(graph: MachineGraph, state: string): MachineTransition[] {
  const local = graph.transitions.filter(t => t.source === state);
  const overridden = new Set(local.filter(t => t.event !== '@always' && t.guards.length === 0).map(t => t.event));
  return [...local, ...graph.transitions.filter(t => t.source === '*' && !overridden.has(t.event))];
}
