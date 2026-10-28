import type { Intent, ModelBinding, TeamConfig } from './types.js';

export function resolveModel(config: TeamConfig, kind: Intent['kind'], target: string): ModelBinding | undefined {
  const models = config.models;
  if (!models || !['interpretation', 'owner', 'assistance', 'facilitator', 'discussionSummary', 'check'].includes(kind)) return undefined;
  const serviceId = kind === 'check' ? models.check ?? models.facilitator ?? models.default
    : kind === 'interpretation' ? models.intent ?? models.facilitator ?? models.default
    : kind === 'facilitator' || kind === 'discussionSummary' ? models.facilitator ?? models.default
    : config.bots.find(bot => bot.id === target)?.model ?? models.default;
  const service = models.services[serviceId];
  return service ? { serviceId, service: structuredClone(service) } : undefined;
}

export function modelSignature(binding: unknown): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
  return JSON.stringify(ordered(binding)) ?? '';
}
