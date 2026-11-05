import type { DebugFrame } from './task-debug.js';
import type { DebugEvidence } from './task-inspection.js';
import { guardDescriptions, phaseNames } from './task-debug-view.js';
import type { MachineGraph, MachineTransition } from './task-structure.js';
import type { Phase } from './types.js';

export interface ChartEdge {
  id: string;
  source: string;
  target: string;
  rules: MachineTransition[];
}
export interface ChartStep {
  status: 'recorded' | 'missing' | 'incompatible';
  note: string;
  steps: DebugEvidence['microsteps'];
  rules: MachineTransition[];
}

const eventNames: Record<string, string> = {
  '@init': '任务创建', '@baseline': '复制基线', '@always': '自动处理', '*': '其他事件',
  HELP: '请求协助', HELP_RESULT: '协助结果返回', RECORD_RESULT: '保存协助结果', RETRY_ASSISTANCE: '重试协助',
  CLAIM: '领取工作', CONSUME: '授权一次请求', WORK_FAILED: '工作执行失败',
  WAIT_USER: '请求人工补充', CONTINUE: '继续执行', STOP: '停止任务', SETTLE: '确认在途工作已结算',
  USER_INPUT: '收到补充输入', HUMAN_DECISION: '收到人工决定', HANDOFF: '交接负责人',
  DELIVER: '提交交付', CHECK_RESULT: '检查结果返回', BLOCKED: '报告阻塞', COORDINATE: '协调决定返回',
  TICK: '检查进展', FAILURE_SIGNAL: '记录失败信号', ACTIVITY: '记录活动', PROGRESS: '记录进度',
  BOARD_WRITE: '更新黑板', ARTIFACT: '保存产物', TOOL: '调用工具',
  DISCUSSION_PLAN: '讨论安排返回', DISCUSSION_RESULT: '讨论结果返回',
  INTERPRETATION_RESULT: '输入理解结果返回', REGENERATE_MODEL_OUTPUT: '重新生成模型结果',
  RECOVER: '恢复任务', RECONCILE: '确认工作结果', EXHAUSTED: '额度耗尽',
  REQUEST_HOST_RETRY: '申请宿主重试', LOCAL_REQUEST: '申请本地操作', LOCAL_CLAIM: '领取本地操作',
  LOCAL_REJECTED: '本地操作被拒绝', LOCAL_STARTED: '本地操作已开始', LOCAL_RESULT: '本地操作结果返回',
  LOCAL_RECONCILE: '确认本地操作结果', LOCAL_APPROVAL_REQUIRED: '本地操作需要授权',
  LOCAL_APPROVAL_DECISION: '收到本地操作授权决定', LOCAL_APPROVAL_EXPIRED: '本地操作授权已过期',
};
const actionNames: Record<string, string> = {
  apply: '更新任务与操作意图', reject: '拒绝事件', explainCoordinationRejection: '说明协调决策拒绝原因', beginInterpretation: '开始理解输入',
  boundary: '应用执行边界输入', handoffDiscussion: '交接讨论汇总', beginReview: '开始评审协调',
  deferred: '处理延后协调', stopped: '记录本轮已停止',
};

export const phaseLabel = (id: string): string => phaseNames[id as Phase] ?? id;
export const eventLabel = (event: string): string => eventNames[event] ?? event;
const withIdentifier = (label: string, id: string): string => label === id ? id : `${label} · ${id}`;

/** Presentation text never replaces the source identifiers or evaluates a guard. */
export function ruleLabel(rule: MachineTransition): string {
  const event = withIdentifier(eventLabel(rule.event), rule.event);
  const conditions = rule.guards.map(id => withIdentifier(guardDescriptions[id] ?? id, id)).join('、') || '无条件';
  const actions = rule.actions.map(id => withIdentifier(actionNames[id] ?? id, id)).join('、') || '空处理';
  return `${event} [${conditions}] / ${actions}`;
}

/** Local cross-state overview only. Global, internal and self rules stay in the rule index. */
export function chartEdges(graph: MachineGraph, focus?: string): ChartEdge[] {
  const edges = new Map<string, ChartEdge>();
  for (const rule of graph.transitions) {
    if (rule.source === '*' || !rule.target || rule.source === rule.target) continue;
    if (focus !== undefined && rule.source !== focus && rule.target !== focus) continue;
    const id = `${rule.source}:${rule.target}`;
    const edge = edges.get(id) ?? { id, source: rule.source, target: rule.target, rules: [] };
    edge.rules.push(rule);
    edges.set(id, edge);
  }
  return [...edges.values()];
}

/** Only captured, compatible evidence can explain what actually happened in a selected step. */
export function chartStep(graph: MachineGraph, frame?: DebugFrame): ChartStep {
  const evidence = frame?.evidence;
  if (!evidence) return { status: 'missing', note: '此记录未采集', steps: [], rules: [] };
  if (evidence.definition !== graph.definition) {
    return { status: 'incompatible', note: '机器结构版本不同', steps: [], rules: [] };
  }
  const rules = new Map<string, MachineTransition>();
  for (const evaluation of evidence.evaluations) {
    if (!evaluation.passed) continue;
    const rule = graph.transitions.find(candidate => candidate.id === evaluation.ruleId);
    if (rule) rules.set(rule.id, rule);
  }
  return {
    status: 'recorded', note: '当次诊断证据',
    steps: evidence.microsteps.map(step => ({ ...step, changed: [...step.changed] })),
    rules: [...rules.values()],
  };
}
