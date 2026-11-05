import type { TaskContext, TeamConfig } from '../types.js';
import { localUnsettled } from '../local-operation.js';

export const currentExecutionVersion = 'team-v2';
export const currentToolVersion = 'tools-v2';

export function currentTaskProtocol(config: TeamConfig): boolean {
  return config.version === currentExecutionVersion && config.toolVersion === currentToolVersion;
}

export function taskProtocolChanged(from: TeamConfig, to: TeamConfig): boolean {
  return from.version !== to.version || from.toolVersion !== to.toolVersion;
}

/** Only an explicit user command may activate a settled task across this exact upgrade. */
export function legacyTerminalConfig(c: TaskContext, config?: TeamConfig): TeamConfig | undefined {
  if (!config || !currentTaskProtocol(config) || c.config.version !== 'team-v1' || c.config.toolVersion !== 'tools-v1'
    || c.outcome === null || c.intents.some(work => localUnsettled(work) || work.status === 'inflight'
      || work.status === 'uncertain' || work.status === 'pending' && work.kind !== 'cancel')) return undefined;
  return { ...config, limits: c.config.limits };
}

export function adoptLegacyTerminalConfig(c: TaskContext, config?: TeamConfig) {
  const upgraded = legacyTerminalConfig(c, config);
  if (!upgraded) return;
  c.config = structuredClone(upgraded);
  c.hostSession = undefined;
  for (const work of c.intents) if (work.kind === 'cancel' && work.status === 'pending') work.status = 'cancelled';
}
