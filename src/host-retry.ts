/** Task-owned host retry requests and batches. Execution is entirely outside this module. */
import type { Intent, TaskContext, TaskEvent } from './types.js';
import { cancelLocalOperations, hostRetryMemberAllowed, localEnabled, localPhysicalPending, localRecoveryBlocked, localUnsettled, type LocalAction, type LocalOperation } from './local-operation.js';
import { activeHelp, allInflight, discussionActive, ok, unresolvedInput } from './task/facts.js';
import { finish, message, owner } from './task/operations.js';

export interface HostRetryRequest {
  id: string; sourceWorkId: string; sourceOperationId: string; sourceRequestHash: string; requestHash: string;
  goalVersion: number; requestedAt: number; deadline: number;
  status: 'pending' | 'active' | 'uncertain' | 'settled' | 'expired' | 'cancelled';
  batchId?: string; workId?: string; operationId?: string; reason?: string; reported?: boolean;
}
export interface HostRetryBatch {
  id: string; workId: string; requestIds: string[];
  phase: 'active' | 'uncertain' | 'draining';
  ownerClaimed?: boolean;
}

/** Reconcile facts in the parent transaction, never grant execution authority here. */
export function hostRetryBatchPhase(c: TaskContext): HostRetryBatch['phase'] {
  const batch = c.hostRetryBatch!;
  if (batch.phase === 'draining' || c.stopped || c.outcome !== null) return 'draining';
  const work = c.intents.find(item => item.id === batch.workId);
  if (work?.status === 'uncertain' || work?.localOperations?.some(op => op.status === 'uncertain')
    || batchRequests(c, batch.id).some(request => retryEffectUnconfirmed(request, work?.localOperations ?? []))) return 'uncertain';
  return 'active';
}

export const hostRetryBatchNeedsSync = (c: TaskContext) => !!c.hostRetryBatch && c.hostRetryBatch.phase !== hostRetryBatchPhase(c);

export function synchronizeHostRetryBatch(c: TaskContext) {
  if (c.hostRetryBatch) c.hostRetryBatch.phase = hostRetryBatchPhase(c);
}

export function claimHostRetryOwner(c: TaskContext, work: Intent, previousRequests: number): boolean {
  const batch = c.hostRetryBatch;
  if (!batch || batch.workId !== work.id) return false;
  if (!batch.ownerClaimed || previousRequests > 0) c.usage.ordinary++;
  batch.ownerClaimed = true;
  return true;
}

export function hostRetryAction(op: LocalOperation): Extract<LocalAction, { type: 'runCli' }> {
  if (op.action.type !== 'runCli') throw new Error('Not a CLI operation');
  const changed = Array.isArray(op.result?.data.outputFiles) ? op.result.data.outputFiles.length : 0;
  return { ...op.action, execution: 'host', reason: `用户请求在宿主重试已确定失败的沙箱命令${changed ? `；上次记录有${changed}个文件变更，请核对后批准` : ''}` };
}

export function findHostRetry(c: TaskContext, sourceWorkId: string, sourceOperationId: string) {
  return c.hostRetryRequests?.find(r => r.sourceWorkId === sourceWorkId && r.sourceOperationId === sourceOperationId);
}

function sourceOf(c: TaskContext, workId: string, operationId: string) {
  const work = c.intents.find(w => w.id === workId);
  const op = work?.localOperations?.find(o => o.id === operationId);
  return { work, op };
}

function minimumBudget(c: TaskContext, count: number) {
  return c.usage.ordinary + count + 1 <= c.config.limits.ordinary && c.usage.checks + 1 <= c.config.limits.checks;
}

export function hostRetryProblem(c: TaskContext, sourceWorkId: string, sourceOperationId: string, sourceRequestHash: string): string | null {
  if (c.stopped) return 'STOPPED';
  if (localRecoveryBlocked(c)) return 'INCOMPATIBLE_EXECUTION';
  const { work, op } = sourceOf(c, sourceWorkId, sourceOperationId);
  if (!work || !op || op.action.type !== 'runCli' || op.action.execution === 'host' || op.result?.data.execution === 'host'
    || op.status !== 'failed' || op.result?.ok !== false) return 'NOT_FAILED_SANDBOX_COMMAND';
  if (work.goalVersion !== c.goalVersion) return 'STALE_WORK';
  if (op.requestHash !== sourceRequestHash) return 'SOURCE_COMMAND_CHANGED';
  if (findHostRetry(c, sourceWorkId, sourceOperationId)) return null;
  if (op.hostRetryIntentId) return 'HOST_RETRY_ALREADY_REQUESTED';
  if (work.kind === 'check' || work.discussionId || op.isolated) return 'HOST_RETRY_ISOLATED_SOURCE';
  if (!op.workspaceId) return 'WORKSPACE_REQUIRED';
  if (!['owner', 'assistance', 'facilitator', 'check'].includes(work.kind)) return 'LOCAL_TOOLS_NOT_ALLOWED';
  if (!localEnabled(c.config, c.owner) || !hostRetryMemberAllowed(c.config, work)) return 'LOCAL_TOOLS_DISABLED';
  if (!c.config.bots.some(bot => bot.id === c.owner)) return 'OWNER_UNAVAILABLE';
  if (c.intents.some(w => w.status === 'uncertain' || localPhysicalPending(w)
    || w.localOperations?.some(op => op.status === 'awaitingApproval' || op.status === 'queued' && !op.hostRetryRequestId)
    || w.status === 'inflight' && (w.replay === 'unsafe' || w.kind === 'tool'))) return 'UNRESOLVED_WORK';
  if (op.result.data.outputFilesTruncated === true) return 'HOST_RETRY_EFFECTS_REVIEW_REQUIRED';
  if (!minimumBudget(c, 1)) return 'BUDGET_EXHAUSTED';
  return null;
}

export function applyHostRetry(c: TaskContext, e: Extract<TaskEvent, { type: 'REQUEST_HOST_RETRY' }>) {
  const existing = findHostRetry(c, e.sourceWorkId, e.sourceOperationId);
  if (existing) { ok(c, existing.id); return; }
  if (c.outcome !== null) {
    c.epoch++; c.outcome = null; c.reason = ''; c.deferredCoordination = false;
    c.hostSession = undefined;
  }
  const request: HostRetryRequest = { id: `${c.taskId}:host-retry:${c.nextSeq++}`, sourceWorkId: e.sourceWorkId,
    sourceOperationId: e.sourceOperationId, sourceRequestHash: e.sourceRequestHash, requestHash: e.requestHash,
    goalVersion: c.goalVersion, requestedAt: e.at, deadline: e.at + c.config.limits.workTimeoutMs, status: 'pending' };
  (c.hostRetryRequests ??= []).push(request);
  message(c, e, 'user', '请求在宿主重试这条失败命令，取得结果后继续整理。', 'user');
  ok(c, request.id);
}

export function pendingHostRetry(c: TaskContext) {
  return c.hostRetryRequests?.some(r => (r.status === 'pending' || r.status === 'expired' && !r.reported && !r.batchId) && r.goalVersion === c.goalVersion) ?? false;
}

function batchRequests(c: TaskContext, batchId: string) {
  return (c.hostRetryRequests ?? []).filter(request => request.batchId === batchId);
}

function retryEffectUnconfirmed(request: HostRetryRequest, operations: LocalOperation[]): boolean {
  if (request.status === 'uncertain') return true;
  if (request.status !== 'active' || request.operationId === undefined) return false;
  return !operations.some(op => op.id === request.operationId);
}

export function hostRetryBatchRetirable(c: TaskContext): boolean {
  const batch = c.hostRetryBatch;
  if (!batch) return false;
  const work = c.intents.find(w => w.id === batch.workId);
  if (work && (work.status !== 'done' && work.status !== 'cancelled' || localPhysicalPending(work))) return false;
  const operations = work?.localOperations ?? [];
  return !batchRequests(c, batch.id).some(request => retryEffectUnconfirmed(request, operations));
}

function closeUnfinishedRetry(request: HostRetryRequest, op: LocalOperation | undefined, at: number) {
  if (op?.finishedAt !== undefined) {
    recordHostRetryReceipt(request, op, op.finishedAt);
    return;
  }
  const expired = request.deadline <= at;
  request.status = expired ? 'expired' : 'cancelled';
  request.reason = expired ? 'WORK_EXPIRED' : 'WORK_NOT_STARTED';
}

export function retireHostRetryBatch(c: TaskContext, e: TaskEvent) {
  if (!hostRetryBatchRetirable(c)) return;
  const batch = c.hostRetryBatch!;
  const work = c.intents.find(w => w.id === batch.workId);
  if (work) cancelLocalOperations(work);
  const operations = work?.localOperations ?? [];
  for (const request of batchRequests(c, batch.id)) {
    if (request.status === 'active') closeUnfinishedRetry(request, operations.find(op => op.id === request.operationId), e.at);
  }
  // XState assign merges top-level fields, so clearing the field requires an explicit value.
  c.hostRetryBatch = undefined;
  c.trace.push({ event: 'HOST_RETRY_BATCH_RETIRED', at: e.at,
    detail: JSON.stringify({ batchId: batch.id, workId: batch.workId, workStatus: work?.status ?? 'missing', trigger: e.type, eventId: e.id }) });
}

export function hostRetryBoundary(c: TaskContext) {
  return pendingHostRetry(c) && !c.hostRetryBatch && !c.stopped && c.outcome === null && !localRecoveryBlocked(c)
    && !allInflight(c).length && !c.intents.some(w => localUnsettled(w) || w.status === 'uncertain' || w.kind === 'tool' && w.status === 'pending')
    && !activeHelp(c) && !discussionActive(c) && !unresolvedInput(c) && !c.inputs.some(note => !note.applied)
    && (!c.review || !['pending', 'reviewing'].includes(c.review.status));
}

function waitingRequests(c: TaskContext, at: number) {
  return (c.hostRetryRequests ?? []).filter(r => r.status === 'pending' && r.goalVersion === c.goalVersion
    && r.deadline > at && localEnabled(c.config, c.owner) && hostRetryMemberAllowed(c.config, sourceOf(c, r.sourceWorkId, r.sourceOperationId).work!));
}

export function canStartHostRetry(c: TaskContext, at: number) {
  if (!hostRetryBoundary(c)) return false;
  const requests = waitingRequests(c, at);
  return requests.length > 0 && minimumBudget(c, requests.length);
}

function rejectWaiting(c: TaskContext, at: number, accepted: HostRetryRequest[]) {
  for (const request of c.hostRetryRequests ?? []) {
    if (request.status === 'expired' && !request.batchId) { request.reported = true; continue; }
    if (request.status !== 'pending' || accepted.includes(request)) continue;
    request.status = request.deadline <= at ? 'expired' : 'cancelled';
    request.reported = true;
    request.reason = request.status === 'expired' ? 'WORK_EXPIRED' : !localEnabled(c.config, c.owner)
      || !hostRetryMemberAllowed(c.config, sourceOf(c, request.sourceWorkId, request.sourceOperationId).work!) ? 'LOCAL_TOOLS_DISABLED' : 'BUDGET_EXHAUSTED';
  }
}

export function failHostRetryBoundary(c: TaskContext, e: TaskEvent) {
  rejectWaiting(c, e.at, []);
  finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed', '宿主续办未执行，见失败命令记录。');
}

function queueNext(c: TaskContext, work: Intent, at: number) {
  const batch = c.hostRetryBatch;
  if (!batch || batch.phase === 'draining' || batch.workId !== work.id || work.localCheckpoint?.pendingOperationId) return;
  const requests = batchRequests(c, batch.id);
  const remaining = requests.filter(r => r.status === 'active' && !r.operationId);
  for (const request of remaining) {
    const source = sourceOf(c, request.sourceWorkId, request.sourceOperationId);
    const original = source.op!;
    const deadline = Math.min(request.deadline, work.deadline ?? Infinity);
    if (at >= deadline || !hostRetryMemberAllowed(c.config, source.work!) || !localEnabled(c.config, work.target)) {
      request.status = at >= deadline ? 'expired' : 'cancelled';
      request.reason = at >= deadline ? 'WORK_EXPIRED' : 'LOCAL_TOOLS_DISABLED';
      continue;
    }
    const action = hostRetryAction(original);
    const checkpoint = work.localCheckpoint!;
    const op: LocalOperation = { id: `${work.id}:local:${checkpoint.nextOperation++}`, namespace: original.namespace, requestHash: request.requestHash,
      action, status: 'queued', parentAttempt: work.attempt, attempt: 0, workspaceId: original.workspaceId!, createdAt: at, deadline,
      hostRetryOf: original.id, hostRetryRequestId: request.id, skillBindings: structuredClone(source.work!.localSkills ?? c.localSkillVersions ?? []) };
    (work.localOperations ??= []).push(op);
    checkpoint.pendingOperationId = op.id;
    checkpoint.messages.push({ role: 'user', content: JSON.stringify({ type: 'host_retry_source', untrusted: true,
      sourceOperationId: original.id, retryOperationId: op.id, previousResultCode: original.result?.code }) });
    request.operationId = op.id;
    return;
  }
  work.localCheckpoint?.messages.push({ role: 'user', content: JSON.stringify({ type: 'host_retry_batch_results', untrusted: true,
    results: requests.map(r => ({ sourceOperationId: r.sourceOperationId, operationId: r.operationId, status: r.status, reason: r.reason })) }) });
}

export function startHostRetryBatch(c: TaskContext, e: TaskEvent) {
  const requests = waitingRequests(c, e.at);
  const unexecuted = (c.hostRetryRequests ?? []).filter(r => r.goalVersion === c.goalVersion && !r.reported && !r.batchId
    && (r.status === 'expired' || r.status === 'pending' && !requests.includes(r)));
  rejectWaiting(c, e.at, requests);
  const prior = c.intents.find(w => w.kind === 'owner' && w.status === 'pending');
  owner(c, e, { ...prior?.payload, manualHostRetry: true, previousReason: prior?.payload.reason ?? c.reason,
    reason: '综合已保存的宿主续办回执并继续原目标。保留已有工作及约束，区分成功、失败和未执行。' });
  const work = c.intents.at(-1)!;
  for (const request of requests) {
    request.status = 'active'; request.batchId = work.id; request.workId = work.id;
    sourceOf(c, request.sourceWorkId, request.sourceOperationId).op!.hostRetryIntentId = work.id;
  }
  for (const request of unexecuted) { request.batchId = work.id; request.workId = work.id; }
  c.deferredCoordination = false;
  c.hostRetryBatch = { phase: 'active', id: work.id, workId: work.id, requestIds: requests.map(r => r.id) };
  work.localCheckpoint = { nextOperation: 0, messages: [] };
  queueNext(c, work, e.at);
}

function recordHostRetryReceipt(request: HostRetryRequest, op: LocalOperation, at: number) {
  const expiredBeforeStart = op.startedAt === undefined && op.deadline !== undefined && at >= op.deadline;
  request.status = expiredBeforeStart ? 'expired' : 'settled';
  request.reason = expiredBeforeStart ? 'WORK_EXPIRED' : op.result?.code ?? op.status;
}

export function settleHostRetryOperation(c: TaskContext, intentId: string, operationId: string, at: number) {
  if (!c.hostRetryRequests) return;
  const { work, op } = sourceOf(c, intentId, operationId);
  const request = c.hostRetryRequests.find(r => r.id === op?.hostRetryRequestId);
  if (!work || !op || !request) return;
  if (op.status === 'uncertain') request.status = 'uncertain';
  else if (op.status === 'queued' || op.status === 'awaitingApproval') request.status = 'active';
  else if (['succeeded', 'failed', 'cancelled'].includes(op.status) && ['active', 'uncertain'].includes(request.status)) {
    recordHostRetryReceipt(request, op, at);
    if (!c.stopped && !localRecoveryBlocked(c) && request.goalVersion === c.goalVersion) queueNext(c, work, at);
  }
}

export function cancelHostRetries(c: TaskContext, reason: string) {
  for (const request of c.hostRetryRequests ?? []) {
    if (request.status === 'expired' && !request.batchId) request.reported = true;
    if (request.status === 'pending' || request.status === 'active' && (!request.workId || !c.intents.some(
      w => w.id === request.workId && localPhysicalPending(w) && w.localOperations?.some(op => op.id === request.operationId && ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status))))) {
      request.status = 'cancelled'; request.reason = reason;
    }
  }
  if (c.hostRetryBatch) c.hostRetryBatch.phase = 'draining';
}

export function hostRetryReservation(c: TaskContext) {
  if (!c.hostRetryBatch) return 0;
  const work = c.intents.find(w => w.id === c.hostRetryBatch?.workId);
  return Number(!c.hostRetryBatch.ownerClaimed) + (c.hostRetryRequests ?? []).filter(r => r.batchId === c.hostRetryBatch?.id
    && r.status === 'active' && !work?.localOperations?.some(op => op.id === r.operationId && op.executionCharged)).length;
}

export function expireHostRetry(c: TaskContext, at: number) {
  for (const request of c.hostRetryRequests ?? []) {
    if (request.deadline > at || request.status !== 'pending' && (request.status !== 'active' || !!request.operationId)) continue;
    request.status = 'expired'; request.reason = 'WORK_EXPIRED';
  }
}
