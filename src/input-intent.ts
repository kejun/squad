import { z } from 'zod';
import type { Goal, InputAction, InputAnalysis, TaskContext } from './types.js';

const text = z.string().trim().min(1).max(32_000);
const list = z.array(text).max(64);
export const inputReferenceSchema = z.strictObject({ kind: z.enum(['message', 'artifact', 'board', 'task']), id: text, taskId: text });
/** One contract is used at the HTTP protocol, worker and state-machine boundaries. */
export const inputIntentSchema = z.strictObject({
  action: z.enum(['request', 'supplement', 'decision', 'review']), objective: text,
  constraints: list, expectedOutputs: list, acceptanceCriteria: list,
  references: z.array(inputReferenceSchema).max(64), confidence: z.number().min(0).max(1),
  clarification: text.nullable(),
}).refine(spec => spec.confidence >= 0.65 || spec.clarification !== null);
export const inputIntentJsonSchema = z.toJSONSchema(inputIntentSchema);
export type InputReference = z.infer<typeof inputReferenceSchema>;
export type InputIntentSpec = z.infer<typeof inputIntentSchema>;

/** Anchoring the whole direct message prevents quoted or incidental words becoming commands. */
export function inputControl(text: string): 'stop' | 'continue' | undefined {
  const direct = text.trim();
  if (/^(?:请\s*)?(?:停止|停下|暂停|stop|pause)[。.!！]?$/i.test(direct)) return 'stop';
  if (/^(?:请\s*)?(?:继续|继续执行|继续任务|continue|resume)[。.!！]?$/i.test(direct)) return 'continue';
  return undefined;
}

/** The host may supply selected mentions; only a leading, unquoted @id is inferred from text. */
export function leadingInputMention(text: string): string | undefined {
  return /^\s*@([\w-]+)(?=\s|$)/.exec(text)?.[1];
}

export function needsInputAnalysis(text: string): boolean {
  return text.length >= 120 || (text.match(/[;；\n]/g)?.length ?? 0) >= 2
    || /(?:上面|上次|之前|刚才|这个|那个|它|改为|改成|沿用|不要|必须|至少|最多|只能|同时|分别|如果|否则|再试一次|\b(?:above|previous|that|it|must|unless|instead|at least|at most)\b)/i.test(text);
}

export function createInputAnalysis(c: Pick<TaskContext, 'config' | 'epoch' | 'goalVersion'>,
  id: string, rawText: string, action: InputAction, goal: Goal, force = false): InputAnalysis {
  const deep = c.config.inputAnalysis?.enabled !== false && !!c.config.models && (force || needsInputAnalysis(rawText));
  return { id, rawText, action, epoch: c.epoch, goalVersion: c.goalVersion,
    source: deep ? 'model' : 'rule', status: deep ? 'pending' : 'resolved',
    ...(deep ? {} : { spec: { action, objective: rawText, constraints: [...goal.constraints], expectedOutputs: [],
      acceptanceCriteria: [...goal.criteria], references: [], confidence: 1, clarification: null } }) };
}

export function inputReferences(c: TaskContext): InputReference[] {
  const refs: InputReference[] = [
    { kind: 'task', id: c.taskId, taskId: c.taskId },
    ...(c.history?.tasks ?? []).map(task => ({ kind: 'task' as const, id: task.taskId, taskId: task.taskId })),
    ...[...(c.history?.messages ?? []), ...c.messages].map(message => ({ kind: 'message' as const, id: message.id, taskId: message.taskId })),
    ...c.artifacts.map(artifact => ({ kind: 'artifact' as const, id: artifact.id, taskId: c.taskId })),
    ...(c.history?.artifacts ?? []).map(artifact => ({ kind: 'artifact' as const, id: artifact.id, taskId: artifact.taskId })),
    ...c.board.map(entry => ({ kind: 'board' as const, id: entry.id, taskId: c.taskId })),
    ...(c.history?.board ?? []).map(entry => ({ kind: 'board' as const, id: entry.id, taskId: entry.taskId })),
  ];
  return refs;
}

/** Schema validity alone grants no scheduling authority or reference identity. */
export function validInputIntent(value: unknown, action: unknown, references: readonly InputReference[]): value is InputIntentSpec {
  const parsed = inputIntentSchema.safeParse(value);
  return parsed.success && parsed.data.action === action && parsed.data.references.every(ref =>
    references.some(allowed => allowed.kind === ref.kind && allowed.id === ref.id && allowed.taskId === ref.taskId));
}
