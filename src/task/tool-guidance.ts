import { classifyCliFailure, repeatedCliFailures, type CliFailureCategory } from '../cli-failure.js';
import { localParentProblem, localPhysicalPending } from '../local-operation.js';
import type { Intent, TaskContext } from '../types.js';

/** Current assignment only: historical messages and tool output cannot steer recommendations. */
export function toolGuidanceObjective(work: Intent): string {
  const partition = work.payload.partition as { objective?: unknown; expectedOutput?: unknown } | undefined;
  const goal = work.payload.goal as { text?: unknown } | undefined;
  const parts = partition ? [partition.objective, partition.expectedOutput]
    : typeof work.payload.question === 'string' ? [work.payload.question, work.payload.expected] : [goal?.text];
  return parts.filter((part): part is string => typeof part === 'string').join('\n').slice(0, 12_000);
}

export function toolGuidanceAllowed(c: TaskContext, work: Intent, at: number): boolean {
  return c.outcome === null && ['owner', 'assistance', 'facilitator'].includes(work.kind)
    && work.replay !== 'unsafe' && !localParentProblem(c, work, at) && !localPhysicalPending(work);
}

const nextSteps: Record<CliFailureCategory, string> = {
  command_missing: 'Rediscover an installed command or applicable skill with discoverHost/listSkills; do not install automatically.',
  arguments: 'Read the registered helpArgs through runCli in the documented environment, then correct arguments using the actual help receipt.',
  sandbox_unavailable: 'Report the sandbox capability gap; request host execution only if the task requires it and through normal approval.',
  execution_boundary: 'Inspect the original receipt and any effects; request host execution only if the task needs host access and through normal approval.',
  authentication: 'Report the authentication requirement or request the documented host access; never read secrets or log in automatically.',
  unknown: 'Inspect the original receipt and business failure; do not infer that different flags or elevated permissions will fix it.',
};

export function cliFailureGuidance(work: Intent) {
  return (work.localOperations ?? []).flatMap(operation => {
    const category = classifyCliFailure(operation);
    if (!category || operation.action.type !== 'runCli') return [];
    return [{ operationId: operation.id, action: operation.action, category }];
  }).slice(-5).map(({ operationId, action, category }) => ({ operationId, category, nextStep: nextSteps[category],
    failureCount: repeatedCliFailures(work, action) }));
}
