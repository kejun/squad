import { persistTask, restoreTask, taskPhase, workLaneAvailable, type TaskSnapshot } from './task.machine.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from './task-inspection.js';
import { taskGraph } from './task-structure.js';
import { validateConfig, type Phase, type TaskEvent, type TaskInput } from './types.js';
export { taskGraph, stateTransitions, type MachineGraph, type MachineTransition } from './task-structure.js';
export type { DebugEvidence } from './task-inspection.js';

export type DebugEvent = TaskEvent | { type: '@init' | '@baseline'; id: string; at: number };
export interface DebugFrame {
  from: Phase | null; phase: Phase; event: DebugEvent; snapshot: unknown;
  stepId?: string; previousStepId?: string; evidence?: DebugEvidence; transactionId?: string;
}
export interface DebugRecord extends DebugFrame { sequence: number; roomId: string; taskId: string }
export interface DebugFeed {
  sessionId: string; cursor: number; truncated: boolean;
  tasks: { id: string; phase: Phase }[];
  current: { taskId: string; snapshot: unknown } | null;
  records: DebugRecord[];
}
export function debugFrame(snapshot: TaskSnapshot, event: DebugEvent, from: Phase | null, evidence?: DebugEvidence): DebugFrame {
  return { from, phase: taskPhase(snapshot), event: structuredClone(event), snapshot: structuredClone(persistTask(snapshot)),
    ...(evidence ? { evidence: structuredClone(evidence) } : {}) };
}

// Shape checks only. Business permissions, limits, fence checks, and rejection codes remain in taskMachine.
const eventFields: Record<string, Record<string, 'string' | 'boolean' | 'object' | 'array'>> = {
  DISCUSSION_PLAN: { workId: 'string', discussionId: 'string', fence: 'object', decision: 'object' },
  DISCUSSION_RESULT: { workId: 'string', discussionId: 'string', fence: 'object', text: 'string', status: 'string' },
  HELP: { requestId: 'string', caller: 'string', target: 'string', question: 'string', expected: 'string' },
  HELP_RESULT: { requestId: 'string', resultId: 'string', status: 'string', answer: 'string' },
  RECORD_RESULT: { requestId: 'string', resultId: 'string', status: 'string', answer: 'string' },
  RETRY_ASSISTANCE: { requestId: 'string', text: 'string' },
  BLOCKED: { reason: 'string' }, COORDINATE: { decision: 'object' },
  USER_INPUT: { text: 'string' }, HUMAN_DECISION: { text: 'string' }, HANDOFF: { owner: 'string' },
  WAIT_USER: { question: 'string' }, DELIVER: { text: 'string', artifactIds: 'array' },
  CHECK_RESULT: { passed: 'boolean', gaps: 'array', resultId: 'string' },
  SETTLE: { intentId: 'string' }, ACTIVITY: { text: 'string' }, PROGRESS: { detail: 'string', refs: 'array' },
  FAILURE_SIGNAL: { operation: 'string', parameters: 'string', resource: 'string', error: 'string', result: 'string' },
  BOARD_WRITE: { author: 'string', entryId: 'string', text: 'string', kind: 'string', sources: 'array' },
  ARTIFACT: { artifact: 'object' }, CLAIM: { intentId: 'string' }, CONSUME: { intentId: 'string' },
  WORK_FAILED: { intentId: 'string', reason: 'string', transient: 'boolean' }, RECOVER: { config: 'object' },
  EXHAUSTED: { reason: 'string' }, RECONCILE: { intentId: 'string', resolution: 'string', detail: 'string' },
  TOOL: { tool: 'string', replay: 'string', payload: 'object' },
  INTERPRETATION_RESULT: { inputId: 'string', spec: 'object' }, REGENERATE_MODEL_OUTPUT: { intentId: 'string', issue: 'string' },
};
function validateEventShape(body: Record<string, unknown>) {
  for (const [field, kind] of Object.entries(eventFields[String(body.type)] ?? {})) {
    const value = body[field];
    const valid = kind === 'array' ? Array.isArray(value) && value.every(item => typeof item === 'string')
      : kind === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === kind;
    if (!valid) throw new Error('事件参数 ' + field + ' 必须为 ' + kind);
  }
}

/** Synthetic, offline input. No environment, SQLite, runner, or model adapter is imported. */
export function debugInput(): TaskInput {
  return {
    taskId: 'sandbox', owner: 'A', at: 0,
    message: { id: 'sandbox-input', taskId: 'sandbox', author: 'user', text: '制定方案并核对依据', kind: 'user', at: 0 },
    goal: { text: '制定方案并核对依据', constraints: [], criteria: ['有可检查的结论'], requiredArtifacts: 0 },
    config: {
      version: 'debug-v1', toolVersion: 'debug-tools-v1', defaultBot: 'A',
      bots: [
        { id: 'A', name: '方案师', instructions: '负责交付', tools: ['read', 'writeArtifact'] },
        { id: 'B', name: '核查员', instructions: '核对依据', tools: ['read'] },
      ],
      skillSearch: { enabled: false }, webTools: { enabled: false }, inputAnalysis: { enabled: false },
      limits: { ordinary: 30, checks: 5, assists: 5, replans: 3, retries: 2, workTimeoutMs: 60000, progressIntervalMs: 10000, repeatThreshold: 3 },
    },
  };
}

export interface SandboxOrigin { runId?: string; stepId?: string; taskId: string }
export interface SandboxPreview { headId: string; text: string; frame: DebugFrame }
const sandboxBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const SANDBOX_MAX_BYTES = 4 * 1024 * 1024;
let sandboxSequence = 0;

/** Viewing history never changes the execution head. Forking is explicit. */
export class TaskSandbox {
  readonly id = 'sandbox:' + ++sandboxSequence;
  readonly origin: SandboxOrigin | undefined;
  private frames: DebugFrame[];
  private readonly seed: DebugFrame;
  private sequence = 0;
  private generation = 0;
  index = 0;
  truncated = false;
  static fromInput(text: string): TaskSandbox {
    let input: TaskInput;
    try { input = JSON.parse(text) as TaskInput; } catch { throw new Error('初始输入必须是有效的 JSON'); }
    if (!input || typeof input.taskId !== 'string' || !input.taskId || typeof input.owner !== 'string'
      || !Number.isSafeInteger(input.at) || input.at < 0 || !input.message || !input.goal
      || !Array.isArray(input.goal.constraints) || !Array.isArray(input.goal.criteria)) throw new Error('初始输入缺少有效的 taskId、owner、at、message 或 goal');
    validateConfig(input.config);
    return new TaskSandbox(undefined, undefined, input);
  }
  constructor(snapshot?: unknown, origin?: SandboxOrigin, input = debugInput()) {
    const inspected = snapshot === undefined ? inspectInitialTask(input) : undefined;
    const initial = inspected?.snapshot ?? restoreTask(structuredClone(snapshot));
    if (initial.context?.schemaVersion !== 1 || !taskGraph().states.includes(String(initial.value))) throw new Error('不兼容的任务快照');
    validateConfig(initial.context.config);
    this.origin = snapshot === undefined ? undefined : origin ?? { taskId: initial.context.taskId };
    this.seed = debugFrame(initial, { type: snapshot === undefined ? '@init' : '@baseline', id: 'sandbox-init', at: initial.context.lastActivityAt }, null, inspected?.evidence);
    if (sandboxBytes(this.seed) > SANDBOX_MAX_BYTES) throw new Error('快照超过沙箱4MiB容量');
    this.frames = [{ ...structuredClone(this.seed), stepId: this.id + ':0:0' }];
  }
  get snapshot(): TaskSnapshot { return restoreTask(structuredClone(this.frames.at(-1)!.snapshot)); }
  get selected(): DebugFrame | undefined { return this.frames[this.index]; }
  get headId(): string { return this.frames.at(-1)!.stepId!; }
  get history(): readonly DebugFrame[] { return this.frames; }
  get bytes(): number { return sandboxBytes(this.frames); }
  select(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) throw new Error('历史位置无效');
    this.index = index;
  }
  fork(index = this.index): TaskSandbox {
    const frame = this.frames[index];
    if (!frame) throw new Error('历史位置已不可用');
    return new TaskSandbox(frame.snapshot, { runId: this.id, stepId: frame.stepId!, taskId: this.snapshot.context.taskId });
  }
  preview(text: string): SandboxPreview {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('事件必须是有效的 JSON 对象'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('事件必须是 JSON 对象');
    const body = raw as Record<string, unknown>;
    if (typeof body.type !== 'string' || !body.type.trim() || body.type.startsWith('@')) throw new Error('事件缺少有效的 type');
    validateEventShape(body);
    const previous = this.snapshot;
    const event = { id: 'sandbox-event:' + (this.sequence + 1), at: previous.context.lastActivityAt + 1, ...body } as TaskEvent;
    if (typeof event.id !== 'string' || !event.id || !Number.isSafeInteger(event.at) || event.at < 0) throw new Error('事件 id 必须非空，at 必须是非负整数');
    try {
      const next = inspectTask(previous, event);
      const frame = debugFrame(next.snapshot, event, taskPhase(previous), next.evidence);
      if (sandboxBytes(frame) > SANDBOX_MAX_BYTES) throw new Error('事件结果超过沙箱4MiB容量');
      return { headId: this.headId, text, frame };
    } catch (error) { throw new Error('事件参数无效：' + (error instanceof Error ? error.message : String(error))); }
  }
  isPreviewCurrent(preview: SandboxPreview, text: string) { return preview.headId === this.headId && preview.text === text; }
  send(text: string): TaskSnapshot {
    const { frame } = this.preview(text), follow = this.index === this.frames.length - 1;
    const selectedId = this.selected?.stepId;
    frame.previousStepId = this.headId;
    frame.stepId = `${this.id}:${this.generation}:${++this.sequence}`;
    this.frames = [...this.frames, frame];
    while (this.frames.length > 1 && (this.frames.length > 100 || sandboxBytes(this.frames) > SANDBOX_MAX_BYTES)) {
      this.frames.shift(); this.truncated = true;
    }
    this.index = follow ? this.frames.length - 1 : this.frames.findIndex(item => item.stepId === selectedId);
    return this.snapshot;
  }
  reset() {
    this.generation++; this.sequence = 0; this.index = 0; this.truncated = false;
    this.frames = [{ ...structuredClone(this.seed), stepId: `${this.id}:${this.generation}:0` }];
  }
}

export function debugEventTemplate(snapshot: TaskSnapshot, type: string): Record<string, unknown> {
  const c = snapshot.context;
  const latest = [...c.intents].reverse();
  const work = latest.find(i => i.status === 'inflight' && i.kind !== 'cancel' && !i.discussionId)
    ?? latest.find(i => i.status === 'pending' && i.kind !== 'cancel' && !i.discussionId)
    ?? latest.find(i => i.status === 'inflight' && i.kind !== 'cancel')
    ?? latest.find(i => i.status === 'pending' && i.kind !== 'cancel');
  const help = c.assists.find(h => ['pending', 'running', 'answered'].includes(h.status)) ?? c.assists.at(-1);
  const result = c.results.find(r => !r.consumed);
  const frame = { epoch: c.epoch, goalVersion: c.goalVersion };
  const base = { type, at: c.lastActivityAt + 1 };
  const completion = { ...base, fence: frame, ...(work?.status === 'inflight' ? { workId: work.id } : {}) };
  switch (type) {
    case 'DISCUSSION_PLAN': case 'DISCUSSION_RESULT': {
      const discussionWork = latest.find(item => item.discussionId === c.discussion?.id && !!item.discussionId && item.status === 'inflight'
        && (type === 'DISCUSSION_PLAN' ? item.kind === 'facilitator' : ['assistance', 'discussionSummary'].includes(item.kind)));
      return { ...base, workId: discussionWork?.id ?? '', discussionId: discussionWork?.discussionId ?? c.discussion?.id ?? '',
        fence: discussionWork ? { epoch: discussionWork.epoch, goalVersion: discussionWork.goalVersion } : frame,
        ...(type === 'DISCUSSION_PLAN' ? { decision: { action: 'review', question: '根据已有目标与资料讨论风险和替代方案', expected: '独立意见及来源依据', reason: '用户直接邀请空闲成员讨论' } }
          : { text: discussionWork?.kind === 'discussionSummary' ? '协调员汇总：区分共识、分歧、依据与未完成项。' : `${discussionWork?.target ?? '成员'} 的独立意见与依据。`, status: 'success' }) };
    }
    case 'HELP': return { ...completion, requestId: 'debug-help:' + c.nextSeq, caller: c.owner, target: c.config.bots.find(b => b.id !== c.owner)?.id ?? c.owner, question: '核对恢复风险', expected: '依据和限制' };
    case 'HELP_RESULT': case 'RECORD_RESULT': {
      const helpWork = latest.find(i => i.kind === 'assistance' && i.payload.requestId === help?.id && i.status === 'inflight');
      return { ...base, fence: frame, ...(helpWork ? { workId: helpWork.id } : {}), requestId: help?.id ?? 'debug-help', resultId: result?.resultId ?? 'debug-result:' + c.nextSeq, status: 'success', answer: '已核对，建议补充恢复验证。' };
    }
    case 'CLAIM': return { ...base, intentId: latest.find(i => i.status === 'pending' && i.kind !== 'cancel' && workLaneAvailable(c, i))?.id ?? '' };
    case 'CONSUME': case 'SETTLE': return { ...base, intentId: work?.id ?? '' };
    case 'WORK_FAILED': return { ...completion, intentId: work?.id ?? '', reason: '模拟外部故障', transient: false };
    case 'WAIT_USER': return { ...completion, question: '请选择下一步' };
    case 'USER_INPUT': case 'HUMAN_DECISION': return { ...base, text: '请补充恢复验证' };
    case 'DELIVER': return { ...completion, text: '方案已完成，来源 https://example.com/source', artifactIds: [] };
    case 'CHECK_RESULT': return { ...completion, passed: true, gaps: [], resultId: 'debug-check:' + c.nextSeq };
    case 'COORDINATE': return { ...completion, decision: { action: 'continue', reason: '按原目标继续' } };
    case 'BLOCKED': case 'EXHAUSTED': return { ...completion, reason: '模拟执行边界' };
    case 'HANDOFF': return { ...base, owner: c.config.bots.find(b => b.id !== c.owner)?.id ?? c.owner };
    case 'PROGRESS': return { ...base, detail: '已完成一项核对', refs: [] };
    case 'ACTIVITY': return { ...base, text: '正在核对' };
    case 'ARTIFACT': return { ...completion, artifact: { id: 'debug-artifact:' + c.nextSeq, name: 'plan.md', content: '# 计划\n补充恢复验证。', author: c.owner } };
    case 'BOARD_WRITE': return { ...base, author: c.owner, entryId: 'debug-board:' + c.nextSeq, text: '核对结论', kind: 'evidence', sources: [] };
    case 'FAILURE_SIGNAL': return { ...completion, operation: 'read', parameters: '{}', resource: 'fixture', error: '模拟故障', result: '' };
    case 'TICK': return { ...base, at: c.nextCheckAt };
    case 'RECOVER': return { ...base, config: c.config };
    case 'RETRY_ASSISTANCE': return { ...base, requestId: help?.id ?? '', text: '重试协助' };
    case 'RECONCILE': return { ...base, intentId: work?.id ?? '', resolution: 'notExecuted', detail: '已确认没有外部写入' };
    case 'INTERPRETATION_RESULT': return { ...completion, inputId: c.inputAnalyses?.find(i => i.status === 'pending' || i.status === 'inflight')?.id ?? '',
      spec: { action: 'request', objective: c.goal.text, constraints: c.goal.constraints, expectedOutputs: ['方案'], acceptanceCriteria: c.goal.criteria, references: [], confidence: 1, clarification: null } };
    case 'REGENERATE_MODEL_OUTPUT': return { ...completion, intentId: work?.id ?? '', issue: 'invalid_work_output' };
    default: return base;
  }
}

