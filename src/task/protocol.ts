import type { TaskContext, TeamConfig } from '../types.js';
import { localUnsettled } from '../local-operation.js';

export const currentExecutionVersion = 'team-v3';
export const currentToolVersion = 'tools-v3';

export function currentTaskProtocol(config: TeamConfig): boolean {
  return config.version === currentExecutionVersion && config.toolVersion === currentToolVersion;
}

export function taskStorageVersion(config: TeamConfig): 1 | 2 | 3 {
  if (currentTaskProtocol(config)) return 3;
  return config.version === 'team-v2' && config.toolVersion === 'tools-v2' ? 2 : 1;
}

export function taskProtocolChanged(from: TeamConfig, to: TeamConfig): boolean {
  return from.version !== to.version || from.toolVersion !== to.toolVersion;
}

function legacyTaskSettled(c: TaskContext): boolean {
  return c.outcome !== null && !c.intents.some(work => localUnsettled(work) || work.status === 'inflight'
    || work.status === 'uncertain' || work.status === 'pending' && work.kind !== 'cancel');
}

/** Only an explicit user command may activate a settled task across a supported upgrade. */
export function legacyTerminalConfig(c: TaskContext, config?: TeamConfig): TeamConfig | undefined {
  const knownLegacy = c.config.version === 'team-v1' && c.config.toolVersion === 'tools-v1' || taskStorageVersion(c.config) === 2;
  if (!config || !currentTaskProtocol(config) || !knownLegacy || !legacyTaskSettled(c)) return undefined;
  return { ...config, limits: c.config.limits };
}

export function adoptLegacyTerminalConfig(c: TaskContext, config?: TeamConfig) {
  const upgraded = legacyTerminalConfig(c, config);
  if (!upgraded) return;
  c.config = structuredClone(upgraded);
  c.hostSession = undefined;
  for (const work of c.intents) if (work.kind === 'cancel' && work.status === 'pending') work.status = 'cancelled';
}
