/** Trusted user retry policy and pure operation intents; never executes a process. */
import type { TaskContext, TaskEvent } from './types.js';
import { localEnabled, localRecoveryBlocked, localUnsettled, type LocalAction, type LocalOperation } from './local-operation.js';
import { discussionActive, unresolvedInput } from './task/facts.js';
import { cancelWork, message, owner } from './task/operations.js';

export function hostRetryAction(op: LocalOperation): Extract<LocalAction, { type: 'runCli' }> {
  if (op.action.type !== 'runCli') throw new Error('Not a CLI operation');
  const changed = Array.isArray(op.result?.data.outputFiles) ? op.result.data.outputFiles.length : 0;
  return { ...op.action, execution: 'host', reason: `用户请求在宿主重试已确定失败的沙箱命令${changed ? `；上次记录有${changed}个文件变更，请核对后批准` : ''}` };
}
export function hostRetryProblem(c: TaskContext, sourceWorkId: string, sourceOperationId: string, sourceRequestHash: string): string | null {
  if (c.stopped) return 'STOPPED';
  if (localRecoveryBlocked(c)) return 'INCOMPATIBLE_EXECUTION';
  const source = c.intents.find(w => w.id === sourceWorkId), op = source?.localOperations?.find(o => o.id === sourceOperationId);
  if (!source || !op || op.action.type !== 'runCli' || op.action.execution === 'host' || op.result?.data.execution === 'host'
    || op.status !== 'failed' || op.result?.ok !== false) return 'NOT_FAILED_SANDBOX_COMMAND';
  if (source.goalVersion !== c.goalVersion) return 'STALE_WORK';
  if (op.requestHash !== sourceRequestHash) return 'SOURCE_COMMAND_CHANGED';
  if (op.hostRetryIntentId) return 'HOST_RETRY_ALREADY_REQUESTED';
  if (!op.workspaceId) return 'WORKSPACE_REQUIRED';
  if (!['owner', 'assistance', 'facilitator', 'check'].includes(source.kind)) return 'LOCAL_TOOLS_NOT_ALLOWED';
  if (!localEnabled(c.config, c.owner) || !localEnabled(c.config, source.target)) return 'LOCAL_TOOLS_DISABLED';
  if (!c.config.bots.some(bot => bot.id === c.owner)) return 'OWNER_UNAVAILABLE';
  if (c.intents.some(w => w.status === 'uncertain' || localUnsettled(w) || w.status === 'inflight' && (w.replay === 'unsafe' || w.kind === 'tool'))
    || discussionActive(c) || unresolvedInput(c) || c.inputs.some(note => !note.applied)) return 'UNRESOLVED_WORK';
  if (c.review && ['pending', 'reviewing'].includes(c.review.status)) return 'WAIT_FOR_BOUNDARY';
  if (op.result.data.outputFilesTruncated === true) return 'HOST_RETRY_EFFECTS_REVIEW_REQUIRED';
  if (c.usage.ordinary + 2 > c.config.limits.ordinary) return 'BUDGET_EXHAUSTED';
  return null;
}
export function applyHostRetry(c: TaskContext, e: Extract<TaskEvent, { type: 'REQUEST_HOST_RETRY' }>) {
  const source = c.intents.find(w => w.id === e.sourceWorkId)!, original = source.localOperations!.find(op => op.id === e.sourceOperationId)!;
  const action = hostRetryAction(original);
  cancelWork(c, e, true);
  c.epoch++; c.outcome = null; c.candidate = null; c.reason = ''; c.deferredCoordination = false;
  for (const help of c.assists) if (['pending', 'running', 'answered'].includes(help.status)) help.status = 'cancelled';
  message(c, e, 'user', '请求在宿主重试这条失败命令，取得结果后继续整理。', 'user');
  owner(c, e, { manualHostRetry: true, sourceWorkId: source.id, sourceOperationId: original.id,
    reason: '先续办已保存的宿主命令申请，取得真实回执后继续原目标；不要重新选择或重复执行该命令。' });
  const retry = c.intents.at(-1)!;
  retry.localSkills = structuredClone(source.localSkills ?? c.localSkillVersions ?? []);
  const op: LocalOperation = { id: `${retry.id}:local:0`, namespace: original.namespace, requestHash: e.requestHash,
    action, status: 'queued', parentAttempt: 0, attempt: 0, workspaceId: original.workspaceId!, createdAt: e.at, hostRetryOf: original.id };
  retry.localOperations = [op];
  retry.localCheckpoint = { nextOperation: 1, pendingOperationId: op.id, messages: [
    { role: 'user', content: JSON.stringify({ type: 'host_retry_source', untrusted: true, sourceOperationId: original.id, originalAction: original.action, previousResult: original.result }) },
    { role: 'assistant', content: JSON.stringify(action) },
  ] };
  original.hostRetryIntentId = retry.id;
}
