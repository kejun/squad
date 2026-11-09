import { localEnabled, type Intent, type TaskContext } from '../types.js';

/** Read methods are observations, never evidence for another resource or execution authority. */
export function sharedToolKnowledge(c: TaskContext, work: Intent) {
  if (c.stopped || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion
    || !['owner', 'assistance', 'facilitator'].includes(work.kind)
    || !localEnabled(c.config, work.target)
    || (work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools !== true) return [];
  return c.intents.filter(source => source.id !== work.id && source.epoch === c.epoch && source.goalVersion === c.goalVersion)
    .flatMap(source => (source.localOperations ?? []).flatMap(operation => {
      const action = operation.action;
      if (action.type !== 'runCli' || operation.status !== 'succeeded' || !operation.result?.ok
        || operation.result.data.exitCode !== 0 || JSON.stringify(action).length > 4000) return [];
      return [{ sourceOperationId: operation.id, sourceMember: source.target, finishedAt: operation.finishedAt ?? null,
        action: structuredClone(action),
        observationOnly: true, requiresIndependentExecution: true }];
    })).slice(-10);
}
