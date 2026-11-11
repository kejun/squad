import type { LocalRuntime } from './local-runtime.js';
import type { Intent, TaskContext } from './types.js';
import { classifyCliFailure } from './cli-failure.js';
import { acquisitionForOperation } from './resource-acquisition.js';

export interface CliReadiness {
  installation: 'unknown' | 'found' | 'not_found';
  authentication: 'unknown' | 'required' | 'satisfied';
  authorization: 'unknown' | 'required' | 'denied';
  authorizationScope: 'execution' | 'registered_invocation';
  sourceOperationIds: string[];
}
type Recommendations = ReturnType<LocalRuntime['recommendTools']>;
type Candidate = Recommendations['cli']['candidates'][number];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function readiness(c: TaskContext, target: Intent, candidate: Candidate, catalogVersion: string): CliReadiness {
  const execution = candidate.execution ?? 'sandbox';
  const state: CliReadiness = { installation: 'unknown', authentication: 'unknown',
    authorization: execution === 'host' ? 'required' : 'unknown', authorizationScope: 'execution', sourceOperationIds: [] };
  const sources = c.intents.filter(work => work.epoch === c.epoch && work.goalVersion === c.goalVersion)
    .flatMap(work => (work.localOperations ?? []).map(operation => ({ work, operation })))
    .sort((a, b) => (a.operation.finishedAt ?? 0) - (b.operation.finishedAt ?? 0));
  for (const { work, operation } of sources) {
    if (!operation.result || !['succeeded', 'failed'].includes(operation.status)) continue;
    let observed = false;
    if (operation.action.type === 'discoverHost' && operation.status === 'succeeded' && operation.result.ok) {
      const cli = record(operation.result.data.cli);
      const catalog = record(cli.catalog);
      if (catalog.catalogVersion !== catalogVersion) continue;
      const command = Array.isArray(cli.commands) ? cli.commands.map(record).find(item => item.command === candidate.command) : undefined;
      if (command && ['found', 'not_found'].includes(String(command[execution]))) {
        state.installation = command[execution] as 'found' | 'not_found'; observed = true;
      }
    }
    if (operation.action.type === 'runCli' && operation.action.executable === candidate.command
      && (operation.action.execution ?? 'sandbox') === execution) {
      if (operation.result.code === 'CLI_NOT_FOUND') { state.installation = 'not_found'; observed = true; }
      else if (typeof operation.result.data.exitCode === 'number') { state.installation = 'found'; observed = true; }
      const registered = work.id === target.id && (operation.action.cwd ?? '.') === '.'
        && [candidate.helpArgs, ...(candidate.examples ?? []).map(example => example.args)]
          .some(args => args && JSON.stringify(args) === JSON.stringify(operation.action.type === 'runCli' ? operation.action.args : []));
      if (registered && classifyCliFailure(operation) === 'authentication') { state.authentication = 'required'; observed = true; }
      const acquisition = acquisitionForOperation(c, work, operation);
      if (registered && acquisition?.configuration?.version === JSON.stringify([c.config.version, c.config.toolVersion])
        && acquisition.configuration.authentication !== 'unknown') {
        state.authentication = acquisition.configuration.authentication; observed = true;
      }
      if (registered && operation.approval?.status === 'denied') {
        state.authorization = 'denied'; state.authorizationScope = 'registered_invocation'; observed = true;
      }
    }
    if (observed && !state.sourceOperationIds.includes(operation.id)) state.sourceOperationIds.push(operation.id);
  }
  return state;
}

/** Project settled host facts only. Metadata matching never probes programs or reads credentials. */
export function withCliReadiness(c: TaskContext, work: Intent, recommendations: Recommendations) {
  const entries = recommendations.cli.candidates.map(candidate => ({ ...candidate,
    readiness: readiness(c, work, candidate, recommendations.cli.catalogVersion) }));
  const unavailable = (entry: typeof entries[number]) => entry.readiness.installation === 'not_found'
    || entry.readiness.authentication === 'required' || entry.readiness.authorization === 'denied';
  return { ...recommendations, cli: { ...recommendations.cli,
    candidates: entries.filter(entry => !unavailable(entry)), unavailableCandidates: entries.filter(unavailable),
    executionAuthority: false as const, currentWorkId: work.id } };
}
