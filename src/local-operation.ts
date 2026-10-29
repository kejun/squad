/** Persisted child-operation contract. This module has no filesystem, process or network I/O. */
import type { Intent, TaskContext, TaskEvent, TeamConfig } from './types.js';

export type LocalAction =
  | { type: 'verifyWorkspace'; expectedRevision: string }
  | { type: 'listSkills'; query?: string; cursor?: string }
  | { type: 'loadSkill'; skillId: string }
  | { type: 'readSkillResource'; skillId: string; path: string; offset?: number }
  | { type: 'runCli'; executable: string; args: string[]; cwd?: string; timeoutMs?: number; skillId?: string };
export interface LocalMessage { role: 'user' | 'assistant'; content: string }
export interface LocalToolResult { ok: boolean; code: string; data: Record<string, unknown> }
export interface LocalCheckpoint { messages: LocalMessage[]; nextOperation: number; pendingOperationId?: string }
export interface SkillBinding { skillId: string; skillVersion: string }
export interface LocalOperation {
  id: string; namespace: string; requestHash: string; action: LocalAction;
  status: 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'uncertain';
  parentAttempt: number; attempt: number; sessionId?: string;
  workspaceId?: string; workspaceRevision?: string; isolated?: boolean;
  createdAt: number; startedAt?: number; finishedAt?: number;
  result?: LocalToolResult;
}
export type LocalEvent =
  | { type: 'LOCAL_REQUEST'; intentId: string; operationId: string; namespace: string; requestHash: string; action: LocalAction; parentAttempt: number; messages: LocalMessage[]; workspaceId?: string }
  | { type: 'LOCAL_REJECTED'; intentId: string; operationId: string; parentAttempt: number; result: LocalToolResult }
  | { type: 'LOCAL_CLAIM'; intentId: string; operationId: string; parentAttempt: number; sessionId: string; leaseAvailable: boolean }
  | { type: 'LOCAL_STARTED'; intentId: string; operationId: string; sessionId: string; workspaceRevision?: string; isolated?: boolean }
  | { type: 'LOCAL_RESULT'; intentId: string; operationId: string; sessionId: string; result: LocalToolResult; settled: boolean; effectsKnown: boolean }
  | { type: 'LOCAL_RECONCILE'; intentId: string; operationId: string; sessionId: string; resolution: 'notStarted' | 'receipt'; result?: LocalToolResult; detail: string };

export function validLocalAction(value: unknown): value is LocalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const text = (v: unknown, max = 4096) => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0');
  const optional = (key: string) => a[key] === undefined || text(a[key]);
  const keys: Record<string, string[]> = { verifyWorkspace: ['expectedRevision'], listSkills: ['query', 'cursor'], loadSkill: ['skillId'], readSkillResource: ['skillId', 'path', 'offset'], runCli: ['executable', 'args', 'cwd', 'timeoutMs', 'skillId'] };
  if (typeof a.type !== 'string' || !keys[a.type] || Object.keys(a).some(k => k !== 'type' && !keys[a.type as string]!.includes(k))) return false;
  switch (a.type) {
    case 'verifyWorkspace': return typeof a.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(a.expectedRevision);
    case 'listSkills': return optional('query') && optional('cursor');
    case 'loadSkill': return text(a.skillId);
    case 'readSkillResource': return text(a.skillId) && text(a.path) && (a.offset === undefined || Number.isSafeInteger(a.offset) && Number(a.offset) >= 0);
    case 'runCli': return text(a.executable) && Array.isArray(a.args) && a.args.length <= 128 && a.args.every(v => typeof v === 'string' && v.length <= 8192 && !v.includes('\0'))
      && optional('cwd') && optional('skillId') && (a.timeoutMs === undefined || Number.isSafeInteger(a.timeoutMs) && Number(a.timeoutMs) > 0 && Number(a.timeoutMs) <= 10_800_000);
    default: return false;
  }
}
export const localUnsettled = (work: Intent) => work.localOperations?.some(op => ['queued', 'claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) ?? false;
export const localPhysicalPending = (work: Intent) => work.localOperations?.some(op => ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) ?? false;
export const localEnabled = (config: TeamConfig, target: string) => config.localTools?.enabled !== false && config.bots.find(b => b.id === target)?.localTools !== false;
export const localRecoveryBlocked = (c: TaskContext) => ['Execution version incompatible', 'Tool permission revoked',
  'Execution member unavailable', 'Model configuration changed', 'Input analysis configuration changed'].includes(c.reason);
export function localParentProblem(c: TaskContext, work: Intent | undefined, at: number, attempt?: number): string | null {
  if (c.stopped) return 'STOPPED';
  if (localRecoveryBlocked(c)) return 'INCOMPATIBLE_EXECUTION';
  if (!work || work.status !== 'inflight' || attempt !== undefined && attempt !== work.attempt) return 'WORK_NOT_INFLIGHT';
  if (work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return 'STALE_WORK';
  if (work.deadline !== null && at >= work.deadline) return 'WORK_EXPIRED';
  if (!['owner', 'assistance', 'facilitator', 'check'].includes(work.kind)) return 'LOCAL_TOOLS_NOT_ALLOWED';
  if (!localEnabled(c.config, work.target)) return 'LOCAL_TOOLS_DISABLED';
  if ((work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools !== true) return 'LOCAL_TOOLS_NOT_AUTHORIZED';
  return null;
}
export function localEventProblem(c: TaskContext, e: TaskEvent, budget: (work: Intent) => string | null): string | null {
  if (!e.type.startsWith('LOCAL_')) return 'INVALID_LOCAL_EVENT';
  const event = e as TaskEvent & LocalEvent;
  const work = c.intents.find(i => i.id === event.intentId);
  if (!work) return 'UNKNOWN_WORK';
  const op = work.localOperations?.find(o => o.id === event.operationId);
  if (event.type === 'LOCAL_REQUEST' || event.type === 'LOCAL_CLAIM') {
    const problem = localParentProblem(c, work, e.at, event.parentAttempt);
    if (problem) return problem;
    if (!e.fence || e.fence.epoch !== work.epoch || e.fence.goalVersion !== work.goalVersion) return 'STALE_FENCE';
  }
  switch (event.type) {
    case 'LOCAL_REQUEST':
      if (!validLocalAction(event.action) || !/^[a-f0-9]{64}$/.test(event.namespace) || !event.operationId || !/^[a-f0-9]{64}$/.test(event.requestHash)
        || !Array.isArray(event.messages) || !event.messages.every(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
        || JSON.stringify(event.messages).length > 1_900_000) return 'INVALID_LOCAL_REQUEST';
      if (op) return op.requestHash === event.requestHash ? 'LOCAL_ALREADY_REQUESTED' : 'LOCAL_REQUEST_CONFLICT';
      if (localUnsettled(work)) return 'LOCAL_OPERATION_PENDING';
      if (event.action.type === 'verifyWorkspace' && work.kind !== 'check') return 'WORKSPACE_VALIDATION_NOT_ALLOWED';
      if (['runCli', 'verifyWorkspace'].includes(event.action.type) && !event.workspaceId) return 'WORKSPACE_REQUIRED';
      return null;
    case 'LOCAL_REJECTED':
      return op?.status === 'queued' && op.parentAttempt === event.parentAttempt && event.result?.ok === false ? null : 'LOCAL_NOT_QUEUED';
    case 'LOCAL_CLAIM':
      if (!op || op.status !== 'queued') return 'LOCAL_NOT_QUEUED';
      if (!event.sessionId) return 'LOCAL_SESSION_REQUIRED';
      if (['runCli', 'verifyWorkspace'].includes(op.action.type) && !event.leaseAvailable) return 'WORKSPACE_BUSY';
      return op.action.type === 'listSkills' ? null : budget({ ...work, bucket: 'ordinary' });
    case 'LOCAL_STARTED':
      if (!op || op.sessionId !== event.sessionId || !['claimed', 'cancelling'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';
      return null;
    case 'LOCAL_RESULT':
      if (!op || op.sessionId !== event.sessionId || !['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';
      if (!event.result || typeof event.result.ok !== 'boolean' || typeof event.result.code !== 'string' || !event.result.data || JSON.stringify(event.result).length > 96_000) return 'INVALID_LOCAL_RESULT';
      return null;
    case 'LOCAL_RECONCILE':
      if (!op || op.status !== 'uncertain' || op.sessionId !== event.sessionId || !event.detail.trim()) return 'LOCAL_NOT_UNCERTAIN';
      if (event.resolution === 'receipt' && (!event.result || typeof event.result.ok !== 'boolean' || JSON.stringify(event.result).length > 96_000)) return 'INVALID_LOCAL_RESULT';
      return ['receipt', 'notStarted'].includes(event.resolution) ? null : 'INVALID_LOCAL_RESOLUTION';
  }
}
function finishOperation(work: Intent, op: LocalOperation, result: LocalToolResult, at: number) {
  op.result = result; op.finishedAt = at;
  op.status = result.code === 'cancelled' ? 'cancelled' : result.ok ? 'succeeded' : 'failed';
  if (result.ok && op.action.type === 'loadSkill' && typeof result.data.skillVersion === 'string') {
    const skillId = String(result.data.skillId);
    work.localSkills = [...(work.localSkills ?? []).filter(s => s.skillId !== skillId), { skillId, skillVersion: result.data.skillVersion }];
  }
  if (work.localCheckpoint?.pendingOperationId === op.id) {
    work.localCheckpoint.messages.push({ role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: op.id, untrusted: true, ...result }) });
    delete work.localCheckpoint.pendingOperationId;
  }
}
export function applyLocalEvent(c: TaskContext, e: TaskEvent & LocalEvent): void {
  const work = c.intents.find(i => i.id === e.intentId)!;
  let op = work.localOperations?.find(o => o.id === e.operationId);
  switch (e.type) {
    case 'LOCAL_REQUEST':
      work.localSkills = [...(work.localSkills ?? []).filter(s => !c.localSkillVersions?.some(p => p.skillId === s.skillId)), ...(c.localSkillVersions ?? [])];
      op = { id: e.operationId, namespace: e.namespace, requestHash: e.requestHash, action: e.action, status: 'queued', parentAttempt: work.attempt, attempt: 0, createdAt: e.at,
        ...(e.workspaceId ? { workspaceId: e.workspaceId } : {}) };
      (work.localOperations ??= []).push(op);
      work.localCheckpoint = { messages: e.messages, nextOperation: (work.localCheckpoint?.nextOperation ?? 0) + 1, pendingOperationId: op.id };
      break;
    case 'LOCAL_REJECTED':
      finishOperation(work, op!, e.result, e.at);
      break;
    case 'LOCAL_CLAIM':
      op!.status = 'claimed'; op!.sessionId = e.sessionId; op!.parentAttempt = work.attempt; op!.attempt++;
      if (op!.action.type !== 'listSkills') c.usage.ordinary++;
      break;
    case 'LOCAL_STARTED':
      if (op!.status !== 'cancelling') op!.status = 'running';
      op!.startedAt = e.at;
      if (e.workspaceRevision !== undefined) op!.workspaceRevision = e.workspaceRevision;
      if (e.isolated !== undefined) op!.isolated = e.isolated;
      break;
    case 'LOCAL_RESULT':
      if (!e.settled || !e.effectsKnown) { op!.status = 'uncertain'; op!.result = e.result; work.status = 'uncertain'; if (!localRecoveryBlocked(c)) c.reason = '本地操作效果不确定，需核对后继续'; }
      else {
        finishOperation(work, op!, e.result, e.at);
        if (work.status === 'uncertain' && !localPhysicalPending(work)) work.status = c.stopped || localRecoveryBlocked(c) || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion ? 'done' : 'pending';
      }
      break;
    case 'LOCAL_RECONCILE':
      if (e.resolution === 'receipt') finishOperation(work, op!, e.result!, e.at);
      else {
        op!.status = c.stopped || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion ? 'cancelled' : 'queued';
        delete op!.sessionId;
      }
      if (!localPhysicalPending(work) && work.status === 'uncertain') {
        work.status = c.stopped || localRecoveryBlocked(c) || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion ? 'done' : 'pending';
      }
      if (!localRecoveryBlocked(c)) c.reason = '本地操作已核对';
      break;
  }
  if (op?.status === 'succeeded' && op.action.type === 'loadSkill' && work.epoch === c.epoch && work.goalVersion === c.goalVersion && !c.stopped) c.localSkillVersions = [...(c.localSkillVersions ?? []).filter(s => !work.localSkills?.some(p => p.skillId === s.skillId)), ...(work.localSkills ?? [])];
  c.trace.push({ event: e.type, at: e.at, detail: JSON.stringify({ workId: work.id, operationId: e.operationId, status: op!.status }) });
}
export function cancelLocalOperations(work: Intent): void {
  for (const op of work.localOperations ?? []) {
    if (op.status === 'queued') op.status = 'cancelled';
    else if (['claimed', 'running'].includes(op.status)) op.status = 'cancelling';
  }
}
export function recoverLocalOperations(work: Intent): void {
  for (const op of work.localOperations ?? []) if (['claimed', 'running', 'cancelling'].includes(op.status)) op.status = 'uncertain';
  if (localPhysicalPending(work)) work.status = 'uncertain';
}
