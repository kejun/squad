import { artifactForWork } from './task/delivery.js';
import { hostSessionMatches } from './host-session.js';
import { evidenceSource, type EvidenceStream } from './task/evidence.js';
import { verificationActionProblem } from './task/verification.js';
import { repeatedCliFailures } from './cli-failure.js';
/** Persisted child-operation contract. This module has no filesystem, process or network I/O. */
import { localEnabled, type Intent, type TaskContext, type TaskEvent, type TeamConfig } from './types.js';
export { localEnabled } from './types.js';

export type LocalAction =
  | { type: 'verifyWorkspace'; expectedRevision: string }
  | { type: 'readArtifact'; artifactId: string; cursor?: string }
  | { type: 'readEvidence'; sourceOperationId: string; stream: EvidenceStream; cursor?: string }
  | { type: 'discoverHost'; commands?: string[]; query?: string; cursor?: string }
  | { type: 'listSkills'; query?: string; cursor?: string }
  | { type: 'loadSkill'; skillId: string }
  | { type: 'readSkillResource'; skillId: string; path: string; offset?: number }
  | { type: 'runCli'; executable: string; args: string[]; cwd?: string; timeoutMs?: number; skillId?: string; execution?: 'sandbox' | 'host'; reason?: string };
export interface LocalMessage { role: 'user' | 'assistant'; content: string }
export interface LocalToolResult { ok: boolean; code: string; data: Record<string, unknown> }
export interface LocalCheckpoint { messages: LocalMessage[]; nextOperation: number; pendingOperationId?: string }
export interface SkillBinding { skillId: string; skillVersion: string }
export interface HostCommandPlan {
  executable: string; args: string[]; cwd: string; workspaceRevision: string;
  executableHash: string; environmentHash: string; host: string; account: string; reason: string;
}
export interface HostApproval {
  id: string; digest: string; plan: HostCommandPlan; expiresAt: number; sessionGrantId?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}
export interface LocalOperation {
  id: string; namespace: string; requestHash: string; action: LocalAction;
  status: 'queued' | 'claimed' | 'awaitingApproval' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'uncertain';
  parentAttempt: number; attempt: number; sessionId?: string;
  workspaceId?: string; workspaceRevision?: string; isolated?: boolean;
  createdAt: number; startedAt?: number; finishedAt?: number;
  result?: LocalToolResult;
  approval?: HostApproval;
  hostRetryIntentId?: string;
  hostRetryOf?: string;
  hostRetryRequestId?: string;
  deadline?: number;
  skillBindings?: SkillBinding[];
  executionCharged?: boolean;
  forceManualApproval?: boolean;
}
export type LocalEvent =
  | { type: 'LOCAL_REQUEST'; intentId: string; operationId: string; namespace: string; requestHash: string; action: LocalAction; parentAttempt: number; messages: LocalMessage[]; workspaceId?: string }
  | { type: 'LOCAL_REJECTED'; intentId: string; operationId: string; parentAttempt: number; result: LocalToolResult }
  | { type: 'LOCAL_CLAIM'; intentId: string; operationId: string; parentAttempt: number; sessionId: string; leaseAvailable: boolean }
  | { type: 'LOCAL_APPROVAL_REQUIRED'; intentId: string; operationId: string; sessionId: string; approval: HostApproval }
  | { type: 'LOCAL_APPROVAL_DECISION'; intentId: string; operationId: string; approvalId: string; decision: 'approve' | 'approveSession' | 'deny' }
  | { type: 'LOCAL_RETRY_EXPIRED'; intentId: string; operationId: string }
  | { type: 'LOCAL_APPROVAL_EXPIRED'; intentId: string; operationId: string }
  | { type: 'LOCAL_STARTED'; intentId: string; operationId: string; sessionId: string; workspaceRevision?: string; isolated?: boolean }
  | { type: 'LOCAL_RESULT'; intentId: string; operationId: string; sessionId: string; result: LocalToolResult; settled: boolean; effectsKnown: boolean }
  | { type: 'LOCAL_RECONCILE'; intentId: string; operationId: string; sessionId: string; resolution: 'notStarted' | 'receipt'; result?: LocalToolResult; detail: string };

export function validLocalAction(value: unknown): value is LocalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  const text = (v: unknown, max = 4096) => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0');
  const optional = (key: string) => a[key] === undefined || text(a[key]);
  const keys: Record<string, string[]> = { discoverHost: ['commands', 'query', 'cursor'], verifyWorkspace: ['expectedRevision'], listSkills: ['query', 'cursor'], loadSkill: ['skillId'], readSkillResource: ['skillId', 'path', 'offset'], readEvidence: ['sourceOperationId', 'stream', 'cursor'], readArtifact: ['artifactId', 'cursor'], runCli: ['executable', 'args', 'cwd', 'timeoutMs', 'skillId', 'execution', 'reason'] };
  if (typeof a.type !== 'string' || !keys[a.type] || Object.keys(a).some(k => k !== 'type' && !keys[a.type as string]!.includes(k))) return false;
  switch (a.type) {
    case 'verifyWorkspace': return typeof a.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(a.expectedRevision);
    case 'discoverHost': return optional('query') && optional('cursor') && (a.commands === undefined || Array.isArray(a.commands) && a.commands.length <= 20
      && a.commands.every(command => typeof command === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(command)));
    case 'listSkills': return optional('query') && optional('cursor');
    case 'loadSkill': return text(a.skillId);
    case 'readArtifact': return text(a.artifactId, 1024)
      && (a.cursor === undefined || typeof a.cursor === 'string' && /^[a-f0-9]{64}:[1-9][0-9]{0,14}$/.test(a.cursor));
    case 'readEvidence': return text(a.sourceOperationId, 1024) && (a.stream === 'stdout' || a.stream === 'stderr')
      && (a.cursor === undefined || typeof a.cursor === 'string' && /^[a-f0-9]{64}:[1-9][0-9]{0,5}$/.test(a.cursor));
    case 'readSkillResource': return text(a.skillId) && text(a.path) && (a.offset === undefined || Number.isSafeInteger(a.offset) && Number(a.offset) >= 0);
    case 'runCli': return text(a.executable) && Array.isArray(a.args) && a.args.length <= 128 && a.args.every(v => typeof v === 'string' && v.length <= 8192 && !v.includes('\0'))
      && optional('cwd') && optional('skillId') && optional('reason') && (a.execution === undefined || a.execution === 'sandbox' || a.execution === 'host')
      && (a.execution !== 'host' || text(a.reason, 1000))
      && (a.timeoutMs === undefined || Number.isSafeInteger(a.timeoutMs) && Number(a.timeoutMs) > 0 && Number(a.timeoutMs) <= 10_800_000);
    default: return false;
  }
}
export const localAwaitingApproval = (work: Intent) => work.localOperations?.some(op => op.status === 'awaitingApproval') ?? false;
export const localUnsettled = (work: Intent) => localAwaitingApproval(work) || (work.localOperations?.some(op => ['queued', 'claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) ?? false);
export const localPhysicalPending = (work: Intent) => work.localOperations?.some(op => ['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) ?? false;
export function hostRetryMemberAllowed(config: TeamConfig, source: Intent): boolean {
  return (source.kind === 'facilitator' || source.kind === 'check' || config.bots.some(bot => bot.id === source.target))
    && localEnabled(config, source.target);
}
export function hostRetrySourceAllowed(c: TaskContext, op: LocalOperation, config = c.config): boolean {
  if (!op.hostRetryRequestId) return true;
  const request = c.hostRetryRequests?.find(r => r.id === op.hostRetryRequestId);
  const source = c.intents.find(w => w.id === request?.sourceWorkId);
  return !!source && hostRetryMemberAllowed(config, source);
}
export function localRecoveryBlocked(c: TaskContext): boolean {
  return ['Execution version incompatible', 'Tool permission revoked', 'Execution member unavailable',
    'Model configuration changed', 'Input analysis configuration changed'].includes(c.reason);
}
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
  if (op && ['LOCAL_CLAIM', 'LOCAL_APPROVAL_REQUIRED', 'LOCAL_APPROVAL_DECISION', 'LOCAL_STARTED'].includes(event.type) && !hostRetrySourceAllowed(c, op))
    return 'LOCAL_TOOLS_DISABLED';
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
      if (work.kind !== 'check' && event.action.type === 'runCli' && repeatedCliFailures(work, event.action) >= 2) return 'CLI_REPEAT_FAILURE_LIMIT';
      if (isSavedRead(event.action) && event.workspaceId !== undefined) return 'INVALID_LOCAL_REQUEST';
      if (event.action.type === 'verifyWorkspace' && work.kind !== 'check') return 'WORKSPACE_VALIDATION_NOT_ALLOWED';
      if (['runCli', 'verifyWorkspace'].includes(event.action.type) && !event.workspaceId) return 'WORKSPACE_REQUIRED';
      return verificationActionProblem(work, event.action, event.workspaceId);
    case 'LOCAL_REJECTED':
      return op?.status === 'queued' && op.parentAttempt === event.parentAttempt && event.result?.ok === false ? null : 'LOCAL_NOT_QUEUED';
    case 'LOCAL_CLAIM': {
      if (!op || op.status !== 'queued') return 'LOCAL_NOT_QUEUED';
      const problem = verificationActionProblem(work, op.action, op.workspaceId, op.id);
      if (problem) return problem;
      if (op.deadline !== undefined && e.at >= op.deadline) return 'WORK_EXPIRED';
      if (!event.sessionId) return 'LOCAL_SESSION_REQUIRED';
      if (['runCli', 'verifyWorkspace'].includes(op.action.type) && !event.leaseAvailable) return 'WORKSPACE_BUSY';
      if (op.action.type === 'runCli' && op.action.execution === 'host' && op.approval) {
        if (op.approval.status !== 'approved') return 'HOST_APPROVAL_REQUIRED';
        if (event.at >= op.approval.expiresAt) return 'HOST_APPROVAL_EXPIRED';
        if (op.approval.sessionGrantId && (op.approval.sessionGrantId !== c.hostSession?.id || !hostSessionMatches(c, work, op, op.approval))) return 'HOST_APPROVAL_REQUIRED';
      }
      if (op.action.type === 'readEvidence' && !evidenceSource(c, work, op.action.sourceOperationId)) return 'EVIDENCE_UNAVAILABLE';
      if (op.action.type === 'readArtifact' && !artifactForWork(c, work, op.action.artifactId)) return 'ARTIFACT_UNAVAILABLE';
      return freeLocalClaim(op) ? null : budget({ ...work, bucket: 'ordinary' });
    }
    case 'LOCAL_APPROVAL_REQUIRED': {
      const problem = localParentProblem(c, work, e.at);
      if (problem) return problem;
      if (!op || op.status !== 'claimed' || op.sessionId !== event.sessionId || op.startedAt !== undefined || op.approval
        || op.action.type !== 'runCli' || op.action.execution !== 'host') return 'HOST_APPROVAL_NOT_PREPARABLE';
      const a = event.approval, p = a?.plan;
      if (!a || a.sessionGrantId !== undefined || a.status !== 'pending' || typeof a.id !== 'string' || !a.id || a.id.length > 512 || !/^[a-f0-9]{64}$/.test(a.digest)
        || !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= e.at || a.expiresAt > e.at + 600_000 || work.deadline !== null && a.expiresAt > work.deadline || op.deadline !== undefined && a.expiresAt > op.deadline
        || !p || !validLocalAction({ type: 'runCli', executable: p.executable, args: p.args, cwd: p.cwd })
        || p.reason !== op.action.reason || ![p.workspaceRevision, p.executableHash, p.environmentHash].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
        || ![p.host, p.account].every(v => typeof v === 'string' && !!v && v.length <= 256)) return 'INVALID_HOST_APPROVAL';
      return null;
    }
    case 'LOCAL_APPROVAL_DECISION': {
      const problem = localParentProblem(c, work.status === 'pending' ? { ...work, status: 'inflight' } : work, e.at);
      if (problem) return problem;
      if (c.outcome !== null || !e.fence || e.fence.epoch !== work.epoch || e.fence.goalVersion !== work.goalVersion) return 'STALE_FENCE';
      if (!op || op.status !== 'awaitingApproval' || op.approval?.status !== 'pending') return 'HOST_APPROVAL_NOT_PENDING';
      if (op.approval.id !== event.approvalId) return 'HOST_APPROVAL_MISMATCH';
      if (e.at >= op.approval.expiresAt || op.deadline !== undefined && e.at >= op.deadline) return 'HOST_APPROVAL_EXPIRED';
      return ['approve', 'approveSession', 'deny'].includes(event.decision) ? null : 'INVALID_HOST_DECISION';
    }
    case 'LOCAL_APPROVAL_EXPIRED':
      return op?.approval && ['awaitingApproval', 'queued'].includes(op.status) && e.at >= op.approval.expiresAt ? null : 'HOST_APPROVAL_NOT_EXPIRED';
    case 'LOCAL_RETRY_EXPIRED':
      return op?.deadline !== undefined && e.at >= op.deadline && ['queued', 'awaitingApproval'].includes(op.status) && op.startedAt === undefined ? null : 'HOST_RETRY_NOT_EXPIRED';
    case 'LOCAL_STARTED':
      if (!op || op.sessionId !== event.sessionId || !['claimed', 'cancelling'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';
      if (op.action.type === 'runCli' && op.action.execution === 'host' && op.approval?.status !== 'approved') return 'HOST_APPROVAL_REQUIRED';
      if (op.approval?.sessionGrantId && (op.approval.sessionGrantId !== c.hostSession?.id || !hostSessionMatches(c, work, op, op.approval))) return 'HOST_APPROVAL_REQUIRED';
      if (op.deadline !== undefined || op.action.type === 'runCli' && op.action.execution === 'host') {
        const problem = localParentProblem(c, work, e.at);
        if (problem || op.deadline !== undefined && e.at >= op.deadline) return problem ?? 'WORK_EXPIRED';
        if (op.approval && e.at >= op.approval.expiresAt) return 'HOST_APPROVAL_EXPIRED';
      }
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
export function isSavedRead(action: LocalAction): action is Extract<LocalAction, { type: 'readEvidence' | 'readArtifact' }> {
  return action.type === 'readEvidence' || action.type === 'readArtifact';
}

function freeLocalClaim(op: LocalOperation): boolean {
  return !!op.executionCharged || ['listSkills', 'discoverHost'].includes(op.action.type) || isSavedRead(op.action) && op.attempt > 0;
}

function finishOperation(work: Intent, op: LocalOperation, result: LocalToolResult, at: number) {
  op.result = result; op.finishedAt = at;
  op.status = result.code === 'cancelled' ? 'cancelled' : result.ok ? 'succeeded' : 'failed';
  if (result.ok && op.action.type === 'loadSkill' && typeof result.data.skillVersion === 'string') {
    const skillId = String(result.data.skillId);
    work.localSkills = [...(work.localSkills ?? []).filter(s => s.skillId !== skillId), { skillId, skillVersion: result.data.skillVersion }];
  }
  if (work.localCheckpoint?.pendingOperationId === op.id) {
    const checkpointResult: LocalToolResult = op.hostRetryRequestId ? { ok: result.ok, code: result.code, data: {
      execution: 'host', ...(typeof result.data.exitCode === 'number' ? { exitCode: result.data.exitCode } : {}),
      ...(typeof result.data.truncated === 'boolean' ? { truncated: result.data.truncated } : {}),
    } } : result;
    work.localCheckpoint.messages.push({ role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: op.id, untrusted: true, ...checkpointResult }) });
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
      if (!freeLocalClaim(op!) && !(op!.action.type === 'runCli' && op!.action.execution === 'host' && !op!.approval)) {
        c.usage.ordinary++;
        if (op!.hostRetryRequestId) op!.executionCharged = true;
      }
      op!.status = 'claimed'; op!.sessionId = e.sessionId; op!.parentAttempt = work.attempt; op!.attempt++;
      break;
    case 'LOCAL_APPROVAL_REQUIRED':
      op!.approval = structuredClone(e.approval); op!.status = 'awaitingApproval';
      if (!op!.forceManualApproval && hostSessionMatches(c, work, op!, op!.approval)) { op!.approval.status = 'approved'; op!.approval.sessionGrantId = c.hostSession!.id; op!.status = 'queued'; }
      break;
    case 'LOCAL_APPROVAL_DECISION':
      op!.approval!.status = e.decision !== 'deny' ? 'approved' : 'denied';
      if (e.decision === 'approveSession') {
        const p = op!.approval!.plan;
        c.hostSession = { id: e.id, epoch: c.epoch, goalVersion: c.goalVersion, namespace: op!.namespace, workspaceId: op!.workspaceId!, host: p.host, account: p.account, environmentHash: p.environmentHash };
        for (const candidate of c.intents) for (const pending of candidate.localOperations ?? [])
          if (pending.approval && !pending.forceManualApproval && ['awaitingApproval', 'queued'].includes(pending.status) && hostSessionMatches(c, candidate, pending, pending.approval) && pending.approval.expiresAt > e.at) {
            pending.approval.status = 'approved'; pending.approval.sessionGrantId = c.hostSession.id; pending.status = 'queued';
          }
      }
      if (e.decision !== 'deny') op!.status = 'queued';
      else finishOperation(work, op!, { ok: false, code: 'HOST_APPROVAL_DENIED', data: {} }, e.at);
      break;
    case 'LOCAL_APPROVAL_EXPIRED':
      op!.approval!.status = 'expired';
      finishOperation(work, op!, { ok: false, code: 'HOST_APPROVAL_EXPIRED', data: {} }, e.at);
      break;
    case 'LOCAL_RETRY_EXPIRED':
      if (op!.approval) op!.approval.status = 'expired';
      finishOperation(work, op!, { ok: false, code: 'WORK_EXPIRED', data: {} }, e.at);
      break;
    case 'LOCAL_STARTED':
      if (op!.status !== 'cancelling') op!.status = 'running';
      op!.startedAt = e.at;
      if (e.workspaceRevision !== undefined) op!.workspaceRevision = e.workspaceRevision;
      if (e.isolated !== undefined) op!.isolated = e.isolated;
      break;
    case 'LOCAL_RESULT':
      if (op!.hostRetryRequestId && op!.startedAt === undefined && op!.approval && e.settled && e.effectsKnown
        && e.result.code === 'HOST_APPROVAL_STALE' && !c.stopped && work.epoch === c.epoch && work.goalVersion === c.goalVersion
        && (op!.deadline === undefined || e.at < op!.deadline)) {
        op!.status = 'queued'; op!.forceManualApproval = true; delete op!.approval;
        break;
      }
      if (op!.hostRetryRequestId && op!.startedAt === undefined && op!.approval?.sessionGrantId
        && e.settled && e.effectsKnown && e.result.code === 'HOST_APPROVAL_REQUIRED' && !c.stopped
        && work.epoch === c.epoch && work.goalVersion === c.goalVersion && e.at < op!.approval.expiresAt) {
        op!.status = 'awaitingApproval'; op!.approval.status = 'pending'; op!.approval.id = `${e.id}:${op!.id}`;
        delete op!.approval.sessionGrantId;
        break;
      }
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
        if (op!.status === 'queued' && op!.approval) {
          op!.status = 'awaitingApproval'; op!.approval!.status = 'pending'; delete op!.approval!.sessionGrantId; op!.approval!.id = `${e.id}:${op!.id}`;
        }
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
    if (['queued', 'awaitingApproval'].includes(op.status)) {
      op.status = 'cancelled'; if (op.approval) op.approval.status = 'expired';
    }
    else if (['claimed', 'running'].includes(op.status)) op.status = 'cancelling';
  }
}
export function recoverLocalOperations(work: Intent, recoveryId = 'recovery'): void {
  for (const op of work.localOperations ?? []) if (op.approval && ['awaitingApproval', 'queued'].includes(op.status)) {
    op.status = 'awaitingApproval'; op.approval.status = 'pending'; op.approval.id = `${recoveryId}:${op.id}`; delete op.approval.sessionGrantId;
  }
  for (const op of work.localOperations ?? []) if (['claimed', 'running', 'cancelling'].includes(op.status)) op.status = 'uncertain';
  if (localPhysicalPending(work)) work.status = 'uncertain';
}
