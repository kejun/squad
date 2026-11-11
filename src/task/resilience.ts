/** Pure task supervision, durable human gates, frozen delivery and physical custody. */
import type { Fence, Intent, Outcome, Phase, TaskContext, TaskEvent } from '../types.js';
import { cancelLocalOperations, heldLocalResourceLeases, localPhysicalPending, localWorkspaceWaiting, taskResourceWaiting } from '../local-operation.js';
import { cancelWork, coordinate, message, owner, release, intent } from './operations.js';
import { cancelHostRetries } from '../host-retry.js';
import { settleDeliveryCycle } from './delivery-cycle.js';
import { permissionProblem } from './policy.js';
import { recordInput } from './input.js';
import { activeHelp, discussionActive } from './facts.js';
import { requestBudgetProblem } from './budget.js';
import { artifactVerification, savedResourceAcquisitions } from '../resource-acquisition.js';
import { unconfinedEffectsKey } from '../local-resource-policy.js';
import { advanceMapQueue, skipCurrentPartition } from './map-queue.js';

export interface ResiliencePolicy {
  automaticTimeoutMs?: number;
  repairTimeoutMs?: number;
  repairLimit?: number;
  cancelGraceMs?: number;
  allowMissingContent?: boolean;
}
export interface ProcessingWindow {
  id: string;
  openedAt: number;
  hardDeadline: number;
  repairUsed: number;
  repairLimit: number;
  repairDeadline?: number;
  /** The user command that explicitly authorized a replacement window. */
  authorizationId?: string;
}
export interface HumanGate extends Fence {
  id: string;
  windowId: string;
  scope: 'task' | 'cleanup';
  kind: 'decision' | 'clarification' | 'authorization' | 'recovery' | 'content';
  question: string;
  status: 'open' | 'answered' | 'skipped' | 'cancelled';
  createdAt: number;
  required: boolean;
  workId?: string;
  operationId?: string;
  approvalId?: string;
  cause?: 'incompatibleExecution';
  decisions?: ('reply' | 'skip' | 'stop' | 'newWindow')[];
  resolvedAt?: number;
  responseId?: string;
  response?: string;
}
export interface ContentSkip extends Fence {
  id: string;
  windowId: string;
  targetKind: 'work' | 'partition' | 'gate';
  targetId: string;
  reason: string;
  at: number;
  authorization: 'policy' | 'human';
  gateId?: string;
}
export interface CleanupCustody {
  kind: 'local' | 'legacyWork';
  id: string;
  owner: 'cleanup';
  workId: string;
  operationId: string;
  sessionId?: string;
  resourceKeys: string[];
  state: 'pending' | 'settled';
  adoptedAt: number;
  nextCheckAt: number;
  gateId?: string;
  settledAt?: number;
}
export interface FrozenTaskDelivery extends Fence {
  id: string;
  windowId: string;
  at: number;
  outcome: Outcome;
  verification: 'complete' | 'incomplete';
  text: string;
  reportArtifactId: string;
  artifactIds: string[];
  items: { artifactId: string; status: 'verified' | 'unverified'; reason?: string }[];
  skippedIds: string[];
  cleanupIds: string[];
  sourceReceiptIds: string[];
}
export interface TaskResilience {
  window: ProcessingWindow;
  gates: HumanGate[];
  skips: ContentSkip[];
  cleanup: CleanupCustody[];
  frozen?: FrozenTaskDelivery;
  frozenHistory?: FrozenTaskDelivery[];
  lastSupervisedAt?: number;
  nextSupervisionAt: number | null;
}
export type ResilienceEvent =
  | { type: 'SUPERVISE'; trigger?: 'timer' | 'recover' | 'workerFailure' | 'hostFailure'; reason?: string }
  | { type: 'EXECUTION_NOT_STARTED'; intentId: string; reason: string }
  | { type: 'HUMAN_GATE_DECISION'; gateId: string; decision: 'reply' | 'skip' | 'stop' | 'newWindow'; text?: string; newWindowMs?: number };

export const defaultResiliencePolicy = { automaticTimeoutMs: 15 * 60_000, repairTimeoutMs: 30_000,
  repairLimit: 2, cancelGraceMs: 5_000, allowMissingContent: true } as const;
export const resiliencePolicy = (c: Pick<TaskContext, 'config'>) => ({ ...defaultResiliencePolicy, ...c.config.resilience });
export function initialResilience(c: Pick<TaskContext, 'taskId' | 'config' | 'messages' | 'lastActivityAt'>): TaskResilience {
  const openedAt = c.messages[0]?.at ?? c.lastActivityAt;
  const policy = resiliencePolicy(c);
  return { window: { id: `${c.taskId}:window:initial`, openedAt, hardDeadline: openedAt + policy.automaticTimeoutMs,
    repairUsed: 0, repairLimit: policy.repairLimit }, gates: [], skips: [], cleanup: [], nextSupervisionAt: openedAt + policy.repairTimeoutMs };
}
export function processingWindow(c: TaskContext): ProcessingWindow { return (c.resilience ?? initialResilience(c)).window; }
export function ensureResilience(c: TaskContext): TaskResilience { return c.resilience ??= initialResilience(c); }
export const taskHumanGates = (c: TaskContext) => c.resilience?.gates.filter(g => g.scope === 'task' && g.required && g.status === 'open'
  && g.epoch === c.epoch && g.goalVersion === c.goalVersion) ?? [];
export const taskHumanGate = (c: TaskContext) => taskHumanGates(c)[0];
export const otherTaskHumanGate = (c: TaskContext, id: string) => taskHumanGates(c).find(g => g.id !== id);
export function windowExpired(c: TaskContext, at: number): boolean { return at >= processingWindow(c).hardDeadline; }
/** A direct answer records intent; execution permissions remain checked by the original approval model. */
export function directTaskGate(c: TaskContext, e: TaskEvent): HumanGate | undefined {
  const gate = taskHumanGate(c);
  if (!gate || gate.approvalId || gate.decisions && !gate.decisions.includes('reply')) return undefined;
  if (e.type === 'USER_INPUT') {
    const busyReview = e.reviewTargets?.length && !e.goal && (gate.kind === 'authorization' || discussionActive(c)
      || c.intents.some(work => !work.discussionId && work.status === 'inflight' && work.epoch === c.epoch && work.goalVersion === c.goalVersion));
    return busyReview ? undefined : gate;
  }
  if (e.type === 'RETRY_ASSISTANCE') {
    const source = c.intents.find(work => work.id === gate.workId);
    const associatedConfiguration = gate.kind === 'authorization' && source?.kind === 'assistance' && source.payload.requestId === e.requestId;
    return associatedConfiguration || ['decision', 'recovery'].includes(gate.kind) ? gate : undefined;
  }
  return e.type === 'HUMAN_DECISION' ? gate : undefined;
}
export function answerTaskGate(c: TaskContext, e: TaskEvent): HumanGate | undefined {
  const gate = directTaskGate(c, e);
  if (!gate || !('text' in e)) return undefined;
  gate.status = 'answered'; gate.responseId = e.id; gate.response = e.text; gate.resolvedAt = e.at;
  ensureResilience(c).nextSupervisionAt = Math.min(processingWindow(c).hardDeadline, e.at + resiliencePolicy(c).repairTimeoutMs);
  return gate;
}

export function openHumanGate(c: TaskContext, e: Pick<TaskEvent, 'id' | 'at'>, options: {
  question: string; scope?: HumanGate['scope']; kind?: HumanGate['kind']; workId?: string; operationId?: string; approvalId?: string; cause?: HumanGate['cause']; decisions?: HumanGate['decisions'];
}): HumanGate {
  const r = ensureResilience(c), scope = options.scope ?? 'task';
  const existing = r.gates.find(g => g.scope === scope && g.status === 'open' && g.epoch === c.epoch && g.goalVersion === c.goalVersion
    && g.question === options.question && g.workId === options.workId && g.operationId === options.operationId && g.approvalId === options.approvalId);
  if (existing) return existing;
  if (scope === 'task') for (const gate of r.gates.filter(g => g.scope === 'task' && g.status === 'open'
    && (options.approvalId ? g.workId === options.workId && g.operationId === options.operationId : !g.approvalId))) {
    gate.status = 'cancelled'; gate.resolvedAt = e.at;
  }
  const gate: HumanGate = { id: `${c.taskId}:gate:${e.id}:${scope}`, windowId: r.window.id, scope,
    kind: options.kind ?? 'decision', question: options.question, status: 'open', required: true, createdAt: e.at,
    epoch: c.epoch, goalVersion: c.goalVersion,
    ...(options.workId ? { workId: options.workId } : {}), ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    ...(options.cause ? { cause: options.cause } : {}), ...(options.decisions ? { decisions: [...options.decisions] } : {}) };
  r.gates.push(gate); if (scope === 'task') r.nextSupervisionAt = null; return gate;
}
export function workInCleanup(c: TaskContext, work: Intent): boolean {
  const pending = work.localOperations?.filter(op => ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) ?? [];
  if (work.replay === 'unsafe' && c.resilience?.cleanup.some(item => item.kind === 'legacyWork' && item.workId === work.id)) return true;
  return pending.length > 0 && pending.every(op => c.resilience?.cleanup.some(item => item.operationId === op.id && item.workId === work.id));
}
export function adoptCleanup(c: TaskContext, at: number, onlyWorkId?: string): void {
  const r = ensureResilience(c), policy = resiliencePolicy(c);
  for (const work of c.intents) for (const op of work.localOperations ?? []) {
    if (onlyWorkId && work.id !== onlyWorkId) continue;
    if (!['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) continue;
    if (r.cleanup.some(item => item.workId === work.id && item.operationId === op.id)) continue;
    const gate = openHumanGate(c, { id: `cleanup:${op.id}`, at }, { scope: 'cleanup', kind: 'recovery',
      question: `核对操作 ${op.id} 的实际执行效果；跳过内容不代表该操作已结算。`, workId: work.id, operationId: op.id });
    r.cleanup.push({ kind: 'local', id: `${c.taskId}:cleanup:${op.id}`, owner: 'cleanup', workId: work.id, operationId: op.id,
      ...(op.sessionId ? { sessionId: op.sessionId } : {}), resourceKeys: [...new Set(heldLocalResourceLeases(op).map(lease => lease.key))],
      state: 'pending', adoptedAt: at, nextCheckAt: at + policy.cancelGraceMs, gateId: gate.id });
    work.status = 'uncertain';
  }
  for (const work of c.intents.filter(work => (!onlyWorkId || work.id === onlyWorkId) && work.replay === 'unsafe'
    && ['inflight', 'uncertain'].includes(work.status) && !localPhysicalPending(work))) {
    if (r.cleanup.some(item => item.kind === 'legacyWork' && item.workId === work.id)) continue;
    const gate = openHumanGate(c, { id: `cleanup-work:${work.id}`, at }, { scope: 'cleanup', kind: 'recovery', workId: work.id,
      question: `旧工具 ${work.id} 的实际效果未知；没有 CLI 操作记录，需要提供方可信核对，普通回复不能结算。` });
    r.cleanup.push({ kind: 'legacyWork', id: `${c.taskId}:cleanup-work:${work.id}`, owner: 'cleanup', workId: work.id,
      operationId: work.id, resourceKeys: [unconfinedEffectsKey], state: 'pending', adoptedAt: at,
      nextCheckAt: at + policy.cancelGraceMs, gateId: gate.id });
    work.status = 'uncertain';
  }
}
export function settleCleanup(c: TaskContext, at: number, reconciledLegacyWorkId?: string): void {
  for (const item of c.resilience?.cleanup ?? []) {
    if (item.state === 'settled') continue;
    const work = c.intents.find(w => w.id === item.workId), op = work?.localOperations?.find(o => o.id === item.operationId);
    if (item.kind === 'legacyWork') {
      if (!work || work.id !== reconciledLegacyWorkId || !['done', 'cancelled'].includes(work.status)) continue;
    } else if (!op || !['succeeded', 'failed', 'cancelled'].includes(op.status)) continue;
    item.state = 'settled'; item.settledAt = at;
    const gate = c.resilience?.gates.find(g => g.id === item.gateId);
    if (gate?.status === 'open') { gate.status = 'answered'; gate.resolvedAt = at; gate.response = '操作已通过可信回执结算'; }
    if (work && !localPhysicalPending(work) && (c.outcome !== null || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion)) work.status = 'done';
  }
  if (c.outcome !== null && c.resilience?.cleanup.every(item => item.state === 'settled')) c.resilience.nextSupervisionAt = null;
}
export function syncLocalApprovalGate(c: TaskContext, e: TaskEvent): void {
  if ((e.type === 'RECOVER' || e.type.startsWith('LOCAL_') && e.type !== 'LOCAL_APPROVAL_REQUIRED') && c.outcome === null && !c.stopped) {
    for (const work of c.intents) for (const op of work.localOperations ?? []) {
      if (!op.approval || op.approval.status !== 'pending' || op.status !== 'awaitingApproval' || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) continue;
      const gate = taskHumanGates(c).find(g => g.workId === work.id && g.operationId === op.id && !!g.approvalId);
      if (gate) gate.approvalId = op.approval.id;
      else openHumanGate(c, { id: `${e.id}:${work.id}:${op.id}`, at: e.at }, { kind: 'authorization', workId: work.id,
        operationId: op.id, approvalId: op.approval.id, question: `宿主命令需要明确授权：${op.approval.plan.reason}。授权令牌过期不代表已经回复。` });
    }
  }
  if (e.type === 'LOCAL_APPROVAL_REQUIRED') {
    const op = c.intents.find(work => work.id === e.intentId)?.localOperations?.find(op => op.id === e.operationId);
    if (op?.approval?.status === 'pending') openHumanGate(c, e, { kind: 'authorization', workId: e.intentId, operationId: e.operationId, approvalId: e.approval.id,
      question: `宿主命令需要明确授权：${e.approval.plan.reason}。请批准、拒绝或明确跳过；授权令牌过期不代表已经回复。` });
  }
  if (e.type !== 'LOCAL_APPROVAL_DECISION') return;
  for (const gate of taskHumanGates(c).filter(g => !!g.approvalId)) {
    const op = c.intents.find(work => work.id === gate.workId)?.localOperations?.find(op => op.id === gate.operationId);
    if (!op?.approval || op.approval.id !== gate.approvalId || !['approved', 'denied'].includes(op.approval.status)) continue;
    gate.status = 'answered'; gate.responseId = e.id; gate.response = e.decision; gate.resolvedAt = e.at;
  }
  if (taskHumanGate(c)) { ensureResilience(c).nextSupervisionAt = null; return; }
  if (windowExpired(c, e.at)) freezeIncomplete(c, e, '人类已明确答复宿主授权，原自动处理窗口已耗尽');
  else ensureResilience(c).nextSupervisionAt = Math.min(processingWindow(c).hardDeadline, e.at + resiliencePolicy(c).repairTimeoutMs);
}
export function recordApprovalExplanation(c: TaskContext, e: TaskEvent): boolean {
  const gate = taskHumanGate(c);
  if (!gate || !(gate.approvalId || gate.decisions && !gate.decisions.includes('reply')) || !('text' in e)
    || gate.approvalId && e.type === 'USER_INPUT' && (e.goal || e.reviewTargets?.length)) return false;
  gate.responseId = e.id; gate.response = e.text ?? ''; message(c, e, 'user', e.text ?? '', 'user');
  return true;
}
export function freezeIncomplete(c: TaskContext, e: Pick<TaskEvent, 'id' | 'at'>, reason: string, forced?: 'stopped'): void {
  const r = ensureResilience(c);
  if (r.frozen) { settleCleanup(c, e.at); return; }
  if (taskHumanGate(c) && forced !== 'stopped') { r.nextSupervisionAt = null; return; }
  adoptCleanup(c, e.at);
  const selection = c.candidate?.goalVersion === c.goalVersion ? new Set(c.candidate.artifactIds) : undefined;
  const hostReports = new Set((r.frozenHistory ?? []).map(publication => publication.reportArtifactId));
  const drafts = c.artifacts.filter(a => a.goalVersion === c.goalVersion && a.content.trim()
    && !hostReports.has(a.id) && (!selection || selection.has(a.id)));
  const currentDraft = c.candidate?.goalVersion === c.goalVersion ? c.candidate.text.trim() : '';
  if (currentDraft && !drafts.some(a => a.content.trim() === currentDraft)) {
    const artifact = { id: `${r.window.id}:unverified-draft:${r.frozenHistory?.length ?? 0}`, name: 'unverified-draft.md', content: currentDraft, goalVersion: c.goalVersion };
    c.artifacts = [...c.artifacts, artifact]; drafts.push(artifact);
  }
  const outcome = forced ?? (drafts.length ? 'partial' : 'failed');
  const reportId = `${r.window.id}:report:${r.frozenHistory?.length ?? 0}`;
  const items = drafts.map(a => ({ artifactId: a.id, ...artifactVerification(c, a) }));
  const finalId = `${r.window.id}:final:${r.frozenHistory?.length ?? 0}`;
  const acquisitions = savedResourceAcquisitions(c);
  const text = [`# 任务处理报告`, `任务：${c.taskId}；固定交付：${finalId}`, `状态：${outcome}；核验未完成`, `目标版本：${c.goalVersion}；执行轮次：${c.epoch}`,
    `目标：${c.goal.text}`, `结束原因：${reason}`, '', '## 已保存材料（未核验材料不构成完成证明）',
    ...(drafts.length ? drafts.map(a => `- ${JSON.stringify(a.name)}：${items.find(i => i.artifactId === a.id)?.status === 'verified' ? '已核验' : '未核验'}`) : ['- 没有可用的业务成果']),
    '', '## 已取得的源材料（取得正文不等于草稿已独立核验）',
    ...(acquisitions.length ? acquisitions.map(a => `- 资源 ${JSON.stringify(a.resource)}；凭证 ${a.id}；操作 ${a.operationId}；内容哈希 ${a.contentHash}；采集轮次 ${a.epoch}/${a.goalVersion}/${a.attempt}`) : ['- 无匹配的已取得正文凭证']),
    '', '## 失败', `- ${reason}`, '', '## 跳过和缺口', ...r.skips.map(s => `- ${s.targetKind} ${s.targetId}：${s.reason}`),
    ...(c.discussion?.incomplete ? [`- ${c.discussion.incomplete}`] : []),
    '', '## 未决物理效果', ...r.cleanup.filter(i => i.state === 'pending').map(i => `- ${i.operationId}：由独立清理继续核对，资源未据此释放`)].join('\n');
  r.frozen = { id: finalId, windowId: r.window.id, at: e.at, outcome, verification: 'incomplete', text,
    reportArtifactId: reportId, artifactIds: [reportId, ...drafts.map(a => a.id)],
    items, skippedIds: r.skips.map(s => s.id),
    cleanupIds: r.cleanup.filter(i => i.state === 'pending').map(i => i.id), sourceReceiptIds: acquisitions.map(a => a.id), epoch: c.epoch, goalVersion: c.goalVersion };
  c.artifacts = [...c.artifacts, { id: reportId, name: 'task-report.md', content: text, goalVersion: c.goalVersion }];
  cancelWork(c, { type: 'STOP', ...e }, true); cancelHostRetries(c, reason);
  c.outcome = outcome; c.stopped = forced === 'stopped'; c.reason = reason; c.hostSession = undefined;
  settleDeliveryCycle(c, outcome, reason);
  for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'clarification', 'failed'].includes(input.status)) input.status = 'cancelled';
  for (const help of c.assists) if (['pending', 'running', 'answered'].includes(help.status)) help.status = 'cancelled';
  if (c.review) c.review.status = forced === 'stopped' ? 'cancelled' : 'complete';
  for (const gate of r.gates.filter(g => g.scope === 'task' && g.status === 'open')) { gate.status = 'cancelled'; gate.resolvedAt = e.at; }
  message(c, { type: 'STOP', ...e }, 'facilitator', text, 'final', { artifactIds: [...r.frozen.artifactIds] });
  r.nextSupervisionAt = r.cleanup.some(item => item.state === 'pending') ? e.at + resiliencePolicy(c).cancelGraceMs : null;
}
export function humanGateProblem(c: TaskContext, e: Extract<TaskEvent, { type: 'HUMAN_GATE_DECISION' }>): string | null {
  const gate = c.resilience?.gates.find(g => g.id === e.gateId);
  if (!gate) return 'HUMAN_GATE_NOT_FOUND';
  if (gate.responseId === e.id) return null;
  if (gate.status !== 'open' || gate.epoch !== c.epoch || gate.goalVersion !== c.goalVersion) return 'STALE_HUMAN_GATE';
  if (!['reply', 'skip', 'stop', 'newWindow'].includes(e.decision)) return 'INVALID_HUMAN_DECISION';
  if (gate.decisions && !gate.decisions.includes(e.decision)) return 'HUMAN_GATE_DECISION_NOT_ALLOWED';
  if (e.decision === 'newWindow' && (!Number.isSafeInteger(e.newWindowMs) || e.newWindowMs! <= 0 || !Number.isSafeInteger(e.at + e.newWindowMs!))) return 'INVALID_PROCESSING_WINDOW';
  if (gate.scope === 'cleanup' && e.decision !== 'reply') return 'CLEANUP_REQUIRES_RECONCILIATION';
  if (gate.approvalId && e.decision === 'newWindow') return 'HOST_APPROVAL_DECISION_REQUIRED';
  return null;
}
export function replaceProcessingWindow(c: TaskContext, e: Pick<TaskEvent, 'id' | 'at'>, duration: number): void {
  const r = ensureResilience(c);
  r.window = { id: `${c.taskId}:window:${e.id}`, openedAt: e.at, hardDeadline: e.at + duration,
    repairUsed: 0, repairLimit: resiliencePolicy(c).repairLimit, authorizationId: e.id };
  archiveFrozen(c); r.nextSupervisionAt = e.at + resiliencePolicy(c).repairTimeoutMs;
}
export function archiveFrozen(c: TaskContext): void {
  const r = ensureResilience(c);
  if (r.frozen) { (r.frozenHistory ??= []).push(structuredClone(r.frozen)); delete r.frozen; }
}
export function executionNotStartedEnds(c: TaskContext, e: Extract<TaskEvent, { type: 'EXECUTION_NOT_STARTED' }>): boolean {
  const work = c.intents.find(w => w.id === e.intentId), window = processingWindow(c);
  return c.stopped || c.outcome !== null || !!c.resilience?.frozen || !work || work.kind === 'check' || windowExpired(c, e.at) || window.repairUsed >= window.repairLimit
    || c.usage.ordinary >= c.config.limits.ordinary || c.usage.retries >= c.config.limits.retries || window.repairDeadline !== undefined && e.at >= window.repairDeadline;
}
export function executionNotStarted(c: TaskContext, e: Extract<TaskEvent, { type: 'EXECUTION_NOT_STARTED' }>): void {
  const work = c.intents.find(w => w.id === e.intentId)!;
  c.trace.push({ event: 'EXECUTION_NOT_STARTED_CONFIRMED', detail: `${work.id}:${work.attempt}:${e.reason}`, at: e.at });
  if (c.outcome !== null || c.resilience?.frozen) { release(c, work.id); return; }
  if (c.stopped) { release(c, work.id); freezeIncomplete(c, e, '已停止尝试经可信宿主确认从未启动', 'stopped'); return; }
  if (executionNotStartedEnds(c, e)) { work.status = 'done'; freezeIncomplete(c, e, `执行未启动：${e.reason}`); return; }
  requeueSafeWork(c, work, e.at);
}
export const authorizationFailure = (reason: string) => /HTTP[_ ](?:401|403)|Unauthorized|Forbidden|api.?key|not configured|未配置|权限.*(?:拒绝|关闭)|配置模型|SKILL_SEARCH_DISABLED|LOCAL_TOOLS_DISABLED|WEB_TOOLS_DISABLED/i.test(reason);
export function requiredHumanFailure(c: TaskContext, e: TaskEvent): boolean {
  if (e.type !== 'WORK_FAILED' || c.stopped || c.outcome !== null || c.resilience?.frozen || e.at >= processingWindow(c).hardDeadline) return false;
  const work = c.intents.find(item => item.id === e.intentId);
  if (!work || work.kind === 'cancel' || work.discussionId || work.replay === 'unsafe'
    || work.deadline !== null && e.at >= work.deadline) return false;
  return authorizationFailure(e.reason);
}
export function safeFailureRetry(c: TaskContext, e: TaskEvent): boolean {
  if (e.type === 'WORK_FAILED' && authorizationFailure(e.reason)) return false;
  if (e.type !== 'WORK_FAILED' || !/SKILL_SEARCH_HTTP_5|HTTP[_ ]50[234]|ECONNRESET|ETIMEDOUT|temporary|暂时|网络/.test(e.reason) || e.resultUncertain || c.stopped || c.outcome !== null) return false;
  const work = c.intents.find(w => w.id === e.intentId), window = processingWindow(c);
  return !!work && !work.discussionId && !['cancel', 'check'].includes(work.kind) && work.replay !== 'unsafe'
    && !localPhysicalPending(work) && e.at < window.hardDeadline && (window.repairDeadline === undefined || e.at < window.repairDeadline)
    && window.repairUsed < window.repairLimit && c.usage.ordinary < c.config.limits.ordinary && c.usage.retries < c.config.limits.retries
    && !requestBudgetProblem(c, work);
}
export function requeueSafeWork(c: TaskContext, work: Intent, at: number): void {
  const window = ensureResilience(c).window;
  window.repairUsed++; c.usage.retries++; window.repairDeadline ??= Math.min(window.hardDeadline, at + resiliencePolicy(c).repairTimeoutMs);
  work.status = 'pending'; work.deadline = Math.min(window.hardDeadline, window.repairDeadline, at + c.config.limits.workTimeoutMs);
  if (work.kind === 'interpretation') {
    const input = c.inputAnalyses?.find(i => i.workId === work.id);
    if (input) input.status = 'pending';
  }
  ensureResilience(c).nextSupervisionAt = Math.min(work.deadline, window.repairDeadline);
}
export function decideHumanGate(c: TaskContext, e: Extract<TaskEvent, { type: 'HUMAN_GATE_DECISION' }>): void {
  const r = ensureResilience(c), gate = r.gates.find(g => g.id === e.gateId)!;
  if (gate.responseId === e.id) return;
  gate.responseId = e.id; gate.resolvedAt = e.at; gate.response = e.text ?? e.decision;
  if (gate.approvalId && e.decision === 'reply') return;
  if (gate.scope === 'cleanup') { gate.response = `${gate.response}（待可信核对结算）`; return; }
  gate.status = e.decision === 'skip' ? 'skipped' : 'answered';
  if (e.decision === 'skip' && gate.cause === 'incompatibleExecution') {
    r.skips.push({ id: `${gate.id}:skip`, windowId: r.window.id, targetKind: 'gate', targetId: gate.id, reason: '用户明确跳过不兼容配置下的剩余业务',
      at: e.at, authorization: 'human', gateId: gate.id, epoch: c.epoch, goalVersion: c.goalVersion });
    for (const pending of taskHumanGates(c)) { pending.status = 'cancelled'; pending.resolvedAt = e.at; }
    freezeIncomplete(c, e, '当前宿主不能继续旧执行协议；用户明确跳过剩余业务，保留已有成果与缺口'); return;
  }
  if (e.decision === 'stop') { freezeIncomplete(c, e, '用户明确停止', 'stopped'); return; }
  if (e.decision === 'skip') {
    if (gate.kind === 'clarification') {
      for (const input of c.inputAnalyses ?? []) if (input.workId === gate.workId && input.status === 'clarification') {
        input.status = 'cancelled'; input.error = 'HUMAN_CONTENT_SKIPPED';
        for (const note of c.inputs.filter(note => note.id === input.id)) note.applied = true;
      }
    }
    if (gate.approvalId && gate.workId) {
      const work = c.intents.find(item => item.id === gate.workId);
      if (work) {
        const wasInflight = work.status === 'inflight';
        cancelLocalOperations(work); release(c, work.id);
        if (wasInflight) intent(c, e.at, 'cancel', work.target, { intentId: work.id });
        const help = c.assists.find(h => h.id === work.payload.requestId);
        if (help && ['pending', 'running', 'answered'].includes(help.status)) { help.status = 'cancelled'; help.consumed = true; help.answer = '用户明确跳过待授权内容'; }
        const round = c.discussion;
        if (round && work.discussionId === round.id) {
          round.incomplete = '用户明确跳过待授权内容';
          if (skipCurrentPartition(c, work.id, '用户明确跳过待授权内容')) advanceMapQueue(c, e);
          else round.skipped.push({ target: work.target, reason: '用户明确跳过待授权内容' });
        }
      }
    }
    r.skips.push({ id: `${gate.id}:skip`, windowId: r.window.id, targetKind: 'gate', targetId: gate.id,
      reason: e.text ?? '用户明确跳过此内容', at: e.at, authorization: 'human', gateId: gate.id, epoch: c.epoch, goalVersion: c.goalVersion });
    for (const work of c.intents.filter(w => w.status === 'uncertain')) adoptCleanup(c, e.at, work.id);
    skipOptionalStalls(c, e);
    if (c.discussion && !['cancelled', 'delivered'].includes(c.discussion.status)
      && !c.intents.some(w => w.discussionId === c.discussion!.id && ['pending', 'inflight'].includes(w.status))) {
      c.discussion.incomplete = '用户明确跳过当前阻塞内容；未决效果继续核对'; c.discussion.status = 'cancelled';
    }
  }
  if (e.decision === 'newWindow') replaceProcessingWindow(c, e, e.newWindowMs!);
  if (gate.kind === 'clarification' && e.decision !== 'skip') {
    const superseded = c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status));
    for (const help of superseded) { help.status = 'cancelled'; help.consumed = true; help.answer = '当前明确澄清替代旧输入，待负责人按最新输入重新评估该请求'; }
    cancelWork(c, e); c.inputs.push({ id: e.id, text: e.text ?? '', applied: false });
    message(c, e, 'user', e.text ?? '', 'user'); recordInput(c, e.id, e.text ?? '', 'supplement');
    c.trace.push({ event: 'HUMAN_CLARIFICATION_INPUT', at: e.at, detail: JSON.stringify({ gateId: gate.id, inputId: e.id, supersededHelpIds: superseded.map(h => h.id) }) });
  }
  if (taskHumanGate(c)) { r.nextSupervisionAt = null; return; }
  if (windowExpired(c, e.at)) { freezeIncomplete(c, e, '人类已回复，原自动处理窗口已耗尽'); return; }
  c.reason = ''; c.stopped = false; c.outcome = null;
  r.nextSupervisionAt = Math.min(r.window.hardDeadline, e.at + resiliencePolicy(c).repairTimeoutMs);
  if (gate.kind === 'clarification' && (e.decision !== 'skip' || activeHelp(c))) return;
  owner(c, { ...e, type: 'BOUNDARY' }, { humanGateId: gate.id, humanResponse: gate.response, skippedContent: structuredClone(r.skips) });
}
const phaseKinds: Partial<Record<Phase, Intent['kind'][]>> = { interpreting: ['interpretation'], running: ['owner', 'tool'],
  waitingAssistance: ['assistance'], coordinating: ['facilitator'], checking: ['check'] };
export function effectiveWork(c: TaskContext, phase: Phase, at: number): Intent[] {
  return c.intents.filter(w => w.kind !== 'cancel' && !localWorkspaceWaiting(w) && w.epoch === c.epoch && w.goalVersion === c.goalVersion
    && (!!w.discussionId && w.discussionId === c.discussion?.id && !['cancelled', 'delivered'].includes(c.discussion!.status) || !w.discussionId && phaseKinds[phase]?.includes(w.kind))
    && (w.status === 'inflight' && w.deadline !== null && at < w.deadline && !workInCleanup(c, w)
      || w.status === 'pending' && !permissionProblem(c, { type: 'CLAIM', id: 'supervisor-probe', at, intentId: w.id })));
}
export type SupervisionDecision = 'none' | 'human' | 'resources' | 'repair' | 'freeze' | 'stopped' | 'settled';
export function supervisionDecision(c: TaskContext, phase: Phase, at: number): SupervisionDecision {
  if (c.outcome !== null || c.resilience?.frozen) return phase === 'ended' ? 'none' : 'settled';
  if (c.stopped || phase === 'stopping') return 'stopped';
  if (taskHumanGate(c)) return 'human';
  if (phase === 'ended') return 'freeze';
  const window = processingWindow(c);
  if (at >= window.hardDeadline || window.repairDeadline !== undefined && at >= window.repairDeadline) return 'freeze';
  if (phase === 'checking' && c.intents.some(w => w.kind === 'check' && ['pending', 'inflight'].includes(w.status)
    && w.epoch === c.epoch && w.goalVersion === c.goalVersion && w.deadline !== null && at >= w.deadline)) return 'freeze';
  if (effectiveWork(c, phase, at).length || c.results.some(result => !result.consumed)) return 'none';
  if (taskResourceWaiting(c)) return 'resources';
  if (window.repairUsed >= window.repairLimit || c.usage.ordinary >= c.config.limits.ordinary || c.usage.retries >= c.config.limits.retries) return 'freeze';
  return 'repair';
}
export function applySupervision(c: TaskContext, e: TaskEvent, phase: Phase): void {
  const r = ensureResilience(c); r.lastSupervisedAt = e.at;
  c.reply = { ok: true, code: 'OK', detail: '监督检查已保存' };
  const trigger = e.type === 'SUPERVISE' ? e.trigger ?? 'timer' : 'timer';
  const diagnostic = trigger === 'hostFailure' ? '执行服务发生错误，正在核查并尝试恢复。'
    : trigger === 'workerFailure' ? '执行工作失败，正在核查可用的恢复路径。' : trigger === 'recover' ? '恢复持久任务的监督责任。' : '检查持久任务的推进路径。';
  c.trace.push({ event: 'SUPERVISE', detail: JSON.stringify({ eventId: e.id, trigger, reason: diagnostic }), at: e.at });
  if ((trigger === 'hostFailure' || trigger === 'workerFailure') && !taskHumanGate(c) && !c.reason) c.reason = diagnostic;
  settleCleanup(c, e.at);
  skipOptionalStalls(c, e);
  const decision = supervisionDecision(c, phase, e.at);
  if (decision === 'human') {
    for (const work of c.intents.filter(w => w.status === 'uncertain')) adoptCleanup(c, e.at, work.id);
    for (const item of r.cleanup.filter(i => i.state === 'pending')) item.nextCheckAt = e.at + resiliencePolicy(c).cancelGraceMs;
    r.nextSupervisionAt = r.cleanup.some(i => i.state === 'pending') ? e.at + resiliencePolicy(c).cancelGraceMs : null; return;
  }
  if (phase === 'ended' || c.outcome !== null) {
    adoptCleanup(c, e.at);
    for (const item of r.cleanup.filter(i => i.state === 'pending')) item.nextCheckAt = e.at + resiliencePolicy(c).cancelGraceMs;
    r.nextSupervisionAt = r.cleanup.some(i => i.state === 'pending') ? e.at + resiliencePolicy(c).cancelGraceMs : null; return;
  }
  if (decision === 'freeze' || decision === 'stopped') { freezeIncomplete(c, e, c.reason || '自动处理窗口或有限修复已耗尽', decision === 'stopped' ? 'stopped' : undefined); return; }
  if (decision === 'repair') {
    r.window.repairUsed++; c.usage.retries++; r.window.repairDeadline ??= Math.min(r.window.hardDeadline, e.at + resiliencePolicy(c).repairTimeoutMs);
    adoptCleanup(c, e.at);
    for (const work of c.intents) if (!workInCleanup(c, work) && ['pending', 'inflight'].includes(work.status)) work.status = 'done';
    if (c.discussion) c.discussion.status = 'cancelled';
    for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'failed'].includes(input.status)) input.status = 'cancelled';
    coordinate(c, e, `监督修复：${c.reason || '当前阶段没有有效执行路径'}`);
  }
  r.nextSupervisionAt = Math.min(r.window.hardDeadline, r.window.repairDeadline ?? e.at + resiliencePolicy(c).repairTimeoutMs);
}
export function skipOptionalStalls(c: TaskContext, e: Pick<TaskEvent, 'id' | 'at'>): void {
  if (!resiliencePolicy(c).allowMissingContent || c.outcome !== null || taskHumanGate(c)) return;
  const r = ensureResilience(c);
  let changed = false;
  for (const work of c.intents.filter(w => w.epoch === c.epoch && w.goalVersion === c.goalVersion && w.status === 'uncertain')) {
    const part = c.discussion?.mapReduce?.queue?.find(p => p.workId === work.id);
    if (!part || r.skips.some(s => s.targetKind === 'partition' && s.targetId === part.partitionId)) continue;
    adoptCleanup(c, e.at, work.id);
    if (!skipCurrentPartition(c, work.id, '当前策略允许缺失；未决物理效果由独立清理接管')) continue;
    changed = true;
    r.skips.push({ id: `${r.window.id}:skip:${part.partitionId}`, windowId: r.window.id, targetKind: 'partition', targetId: part.partitionId,
      reason: '已授权允许缺失的分片因执行效果未知而跳过内容', at: e.at, authorization: 'policy', epoch: c.epoch, goalVersion: c.goalVersion });
  }
  if (changed) advanceMapQueue(c, { ...e, type: 'SUPERVISE' });
}
