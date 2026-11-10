import type { Intent } from './types.js';
import type { LocalAction, LocalOperation } from './local-operation.js';

export type CliFailureCategory = 'command_missing' | 'arguments' | 'sandbox_unavailable' | 'execution_boundary' | 'authentication' | 'unknown';
type CliAction = Extract<LocalAction, { type: 'runCli' }>;

/** A settled observation is not proof that a failed command had no side effects. */
export function classifyCliFailure(operation: LocalOperation): CliFailureCategory | undefined {
  const result = operation.result;
  if (operation.action.type !== 'runCli' || operation.status !== 'failed' || !result || result.ok) return undefined;
  if (result.code === 'CLI_NOT_FOUND') return 'command_missing';
  if (result.code === 'CLI_SANDBOX_UNAVAILABLE') return 'sandbox_unavailable';
  if (result.code !== 'failed' || typeof result.data.exitCode !== 'number' || result.data.exitCode === 0 || result.data.signal) return undefined;
  const stderr = typeof result.data.stderr === 'string' ? result.data.stderr : '';
  if (/\b(?:unknown (?:option|flag)|unrecognized (?:option|arguments?)|unrecognised (?:option|arguments?)|bad option|invalid option)\b/i.test(stderr)) return 'arguments';
  if (/\b(?:authentication required|not logged in|login required|please (?:log|sign) in|requires authentication)\b/i.test(stderr)) return 'authentication';
  if (operation.action.execution !== 'host' && /\b(?:PERM_DENIED|EPERM|EACCES|operation not permitted|permission denied|sandbox network (?:denied|denial)|ENOTFOUND localhost)\b/i.test(stderr)) return 'execution_boundary';
  return 'unknown';
}

/** Defaults are semantic protocol values; real filesystem aliases are not guessed here. */
export function cliInvocationKey(action: CliAction): string {
  return JSON.stringify([action.executable, action.args, action.cwd ?? '.', action.skillId ?? null, action.execution ?? 'sandbox']);
}

export function repeatedCliFailures(work: Intent, action: CliAction): number {
  const key = cliInvocationKey(action);
  return (work.localOperations ?? []).filter(operation => {
    if (operation.action.type !== 'runCli' || cliInvocationKey(operation.action) !== key) return false;
    const category = classifyCliFailure(operation);
    return category !== undefined && category !== 'unknown';
  }).length;
}
