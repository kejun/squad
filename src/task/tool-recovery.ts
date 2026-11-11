import { localPhysicalPending, localRecoveryBlocked } from '../local-operation.js';
import { toolFailureCodes, type TaskContext, type TaskEvent, type ToolFailureCode, type WebToolKind } from '../types.js';
import { requestBudgetProblem } from './budget.js';
import { discussionActive } from './facts.js';

type Failure = Extract<TaskEvent, { type: 'RECORD_TOOL_FAILURE' }>;
const knownFailures: Record<string, ToolFailureCode> = {
  WEB_TOOLS_NOT_CONFIGURED: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  WEB_TOOLS_ENV_UNAVAILABLE: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  INVALID_CLOUDFLARE_CREDENTIALS: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  INVALID_CLOUDFLARE_WEB_SEARCH_PROVIDER: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  INVALID_CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  web_fetch_unsupported_resource: 'WEB_TOOL_UNSUPPORTED_RESOURCE',
  web_fetch_unsupported_content_type: 'WEB_TOOL_UNSUPPORTED_RESOURCE',
  web_fetch_too_large: 'WEB_TOOL_UNSUPPORTED_RESOURCE',
  web_fetch_too_many_redirects: 'WEB_TOOL_UNSUPPORTED_RESOURCE',
  web_fetch_timeout: 'WEB_TOOL_TIMEOUT', web_search_timeout: 'WEB_TOOL_TIMEOUT',
  web_fetch_conversion_failed: 'WEB_TOOL_CONVERSION_FAILED',
  web_fetch_http_error: 'WEB_TOOL_HTTP_ERROR',
  web_fetch_blocked: 'WEB_TOOL_HTTP_ERROR',
  web_fetch_unavailable: 'WEB_TOOL_UNAVAILABLE', web_search_unavailable: 'WEB_TOOL_UNAVAILABLE',
  web_fetch_failed: 'WEB_TOOL_UNAVAILABLE', web_search_failed: 'WEB_TOOL_UNAVAILABLE',
  web_search_unsupported_runtime: 'WEB_TOOL_UNSUPPORTED_RESOURCE',
  web_search_gateway_not_configured: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  web_search_byok_not_configured: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  web_search_payment_required: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  web_search_unauthorized: 'WEB_TOOL_CONFIGURATION_UNAVAILABLE',
  web_search_rate_limited: 'WEB_TOOL_RATE_LIMITED',
};
/** Only a fixed category crosses the model/persistence boundary, never the provider error body. */
export function recoverableWebFailure(tool: WebToolKind, message: string): ToolFailureCode | undefined {
  const token = /^[A-Za-z_]+/.exec(message)?.[0];
  if (!token || token.startsWith('web_') && !token.startsWith(`${tool}_`)) return undefined;
  return Object.hasOwn(knownFailures, token) ? knownFailures[token] : undefined;
}

export function toolFailureProblem(c: TaskContext, e: Failure): string | null {
  const work = c.intents.find(item => item.id === e.intentId);
  if (!work || work.status !== 'inflight' || c.outcome !== null) return 'WORK_NOT_INFLIGHT';
  if (!e.fence || e.fence.epoch !== c.epoch || e.fence.goalVersion !== c.goalVersion
    || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return 'STALE_FENCE';
  if (e.attempt !== work.attempt) return 'STALE_ATTEMPT';
  if (!['owner', 'assistance', 'facilitator'].includes(work.kind) || work.replay === 'unsafe') return 'TOOL_RECOVERY_NOT_ALLOWED';
  if (work.discussionId && (!discussionActive(c) || c.discussion?.id !== work.discussionId)) return 'STALE_DISCUSSION';
  if (work.deadline !== null && e.at >= work.deadline) return 'WORK_EXPIRED';
  if (localRecoveryBlocked(c)) return 'INCOMPATIBLE_EXECUTION';
  if (localPhysicalPending(work)) return 'LOCAL_OPERATION_PENDING';
  if (c.config.webTools?.enabled === false) return 'WEB_TOOLS_DISABLED';
  if (!['web_fetch', 'web_search'].includes(e.tool) || !toolFailureCodes.includes(e.code)) return 'INVALID_TOOL_FAILURE';
  const capability = e.tool === 'web_fetch' ? 'webFetch' : 'webSearch';
  if ((work.payload.capabilities as Record<string, unknown> | undefined)?.[capability] === false) return 'WEB_TOOLS_NOT_ALLOWED';
  const prefix = `request:${work.id}:${work.attempt}:${e.tool}:`;
  if (typeof e.requestId !== 'string' || !e.requestId.startsWith(prefix) || !/^[1-9][0-9]{0,8}$/.test(e.requestId.slice(prefix.length))
    || !c.trace.some(entry => entry.event === 'CONSUME' && entry.detail === e.requestId)) return 'TOOL_FAILURE_REQUEST_REQUIRED';
  const failures = work.toolRecovery?.failures ?? [];
  if (failures.some(item => item.requestId === e.requestId)) return 'DUPLICATE_TOOL_FAILURE';
  if (failures.length >= 2) return 'TOOL_RECOVERY_EXHAUSTED';
  return requestBudgetProblem(c, work);
}

export function recordToolFailure(c: TaskContext, e: Failure): void {
  const work = c.intents.find(item => item.id === e.intentId)!;
  (work.toolRecovery ??= { failures: [] }).failures.push({ requestId: e.requestId, tool: e.tool, code: e.code, attempt: work.attempt, at: e.at });
}
