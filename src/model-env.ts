import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { validateConfig, type ModelService, type TeamConfig } from './types.js';

export type ModelEnvironment = Record<string, string | undefined>;
const suffixes = ['BASE_URL', 'NAME', 'API_KEY', 'NO_AUTH', 'JSON_MODE', 'TEMPERATURE', 'MAX_TOKENS', 'EXTRA_BODY'] as const;
const slots = [
  ['A', 'A_MODEL'], ['B', 'B_MODEL'], ['builder-1', 'BUILDER_1_MODEL'],
  ['builder-2', 'BUILDER_2_MODEL'], ['builder-3', 'BUILDER_3_MODEL'],
] as const;

const fileValues = new Map<string, string>();

/** Reload optional .env, replacing only values previously supplied by this loader. */
export function loadModelEnvFile(path = '.env'): void {
  let values: ModelEnvironment = {};
  try { values = parseEnv(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to load model environment file');
  }
  // Preserve host overrides, including changes made after startup. Remove revoked file values.
  for (const [key, previous] of fileValues) {
    if (process.env[key] !== previous) fileValues.delete(key);
    else if (!Object.hasOwn(values, key)) {
      delete process.env[key];
      fileValues.delete(key);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && (process.env[key] === undefined || fileValues.has(key))) {
      process.env[key] = value;
      fileValues.set(key, value);
    }
  }
}

/** One consistent environment for a request, independent of later file or process updates. */
export function readModelEnv(): ModelEnvironment {
  loadModelEnvFile();
  return { ...process.env };
}

/** Resolve non-secret model settings; keep only credential variable names in task configuration. */
export function configureModelsFromEnv(base: TeamConfig, env: ModelEnvironment): TeamConfig {
  const config = structuredClone(base);
  const value = (key: string) => env[key]?.trim() || undefined;
  const has = (prefix: string) => suffixes.some(suffix => value(`${prefix}_${suffix}`) !== undefined);
  const prefixes = ['MODEL', ...slots.map(([, prefix]) => prefix), 'FACILITATOR_MODEL', 'CHECK_MODEL', 'INTENT_MODEL'];
  if (!prefixes.some(has)) return config;
  if (!value('MODEL_BASE_URL') || !value('MODEL_NAME')) throw new Error('Configure MODEL_BASE_URL and MODEL_NAME in .env');
  const bool = (key: string, fallback: boolean): boolean => {
    const text = value(key)?.toLowerCase();
    if (text === undefined) return fallback;
    if (text === 'true' || text === 'false') return text === 'true';
    throw new Error(`Invalid boolean environment variable: ${key}`);
  };
  const number = (key: string, fallback: number | undefined): number | undefined => {
    const text = value(key);
    if (text === undefined) return fallback;
    const result = Number(text);
    if (!Number.isFinite(result)) throw new Error(`Invalid numeric environment variable: ${key}`);
    return result;
  };
  const profile = (prefix: string, fallback?: ModelService): ModelService => {
    const baseUrl = value(`${prefix}_BASE_URL`) ?? fallback!.baseUrl;
    const model = value(`${prefix}_NAME`) ?? fallback!.model;
    const service: ModelService = { baseUrl, model, jsonMode: bool(`${prefix}_JSON_MODE`, fallback?.jsonMode ?? true) };
    const ownKey = value(`${prefix}_API_KEY`) !== undefined;
    const differentEndpoint = fallback && baseUrl.replace(/\/+$/, '') !== fallback.baseUrl.replace(/\/+$/, '');
    const noAuth = bool(`${prefix}_NO_AUTH`, ownKey || differentEndpoint ? false : fallback ? fallback.apiKeyEnv === undefined : false);
    if (!noAuth) {
      // A new endpoint must not silently receive a different provider's inherited credential.
      service.apiKeyEnv = !fallback || ownKey || differentEndpoint ? `${prefix}_API_KEY` : fallback.apiKeyEnv ?? `${prefix}_API_KEY`;
    }
    const temperature = number(`${prefix}_TEMPERATURE`, fallback?.temperature);
    const maxTokens = number(`${prefix}_MAX_TOKENS`, fallback?.maxTokens);
    if (temperature !== undefined) service.temperature = temperature;
    if (maxTokens !== undefined) service.maxTokens = maxTokens;
    const body = value(`${prefix}_EXTRA_BODY`);
    if (body !== undefined) {
      try { service.extraBody = JSON.parse(body); } catch { throw new Error(`Invalid JSON environment variable: ${prefix}_EXTRA_BODY`); }
    } else if (fallback?.extraBody !== undefined) service.extraBody = structuredClone(fallback.extraBody);
    return service;
  };
  const primary = profile('MODEL');
  config.models = { default: 'primary', services: { primary } };
  for (const [botId, prefix] of slots) {
    const bot = config.bots.find(member => member.id === botId);
    if (bot && has(prefix)) {
      config.models.services[botId] = profile(prefix, primary);
      bot.model = botId;
    }
  }
  if (has('FACILITATOR_MODEL')) {
    config.models.services.facilitator = profile('FACILITATOR_MODEL', primary);
    config.models.facilitator = 'facilitator';
  }
  if (has('CHECK_MODEL')) {
    config.models.services.check = profile('CHECK_MODEL', config.models.services.facilitator ?? primary);
    config.models.check = 'check';
  }
  if (has('INTENT_MODEL')) {
    config.models.services.intent = profile('INTENT_MODEL', config.models.services.facilitator ?? primary);
    config.models.intent = 'intent';
  }
  validateConfig(config);
  return config;
}
