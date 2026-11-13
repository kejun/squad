#!/usr/bin/env node
/** Write injected MODEL_* / CLOUDFLARE_* / SQUAD_* / WEB_* from process.env into .env using .env.example as template. */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const prefixes = [
  'MODEL_', 'A_MODEL_', 'B_MODEL_', 'BUILDER_1_MODEL_', 'BUILDER_2_MODEL_', 'BUILDER_3_MODEL_',
  'FACILITATOR_MODEL_', 'CHECK_MODEL_', 'INTENT_MODEL_', 'CLOUDFLARE_', 'SQUAD_', 'WEB_',
];
const aliases = [
  ['OPENAI_API_KEY', 'MODEL_API_KEY'],
  ['OPENAI_BASE_URL', 'MODEL_BASE_URL'],
  ['OPENROUTER_API_KEY', 'MODEL_API_KEY'],
];

const template = readFileSync('.env.example', 'utf8');
const merged = { ...parseEnv(template) };
for (const [from, to] of aliases) {
  const value = process.env[from]?.trim();
  if (value && !merged[to]?.trim()) merged[to] = value;
  if (from === 'OPENROUTER_API_KEY' && value && !merged.MODEL_BASE_URL?.trim()) {
    merged.MODEL_BASE_URL = 'https://openrouter.ai/api/v1';
  }
}
let overridden = 0;
for (const [key, value] of Object.entries(process.env)) {
  if (!value?.trim() || !prefixes.some(prefix => key.startsWith(prefix))) continue;
  if (merged[key] !== value) overridden++;
  merged[key] = value;
}

const webDefaults = {
  SQUAD_WEB_TOOLS_ENABLED: 'true',
  CLOUDFLARE_AI_GATEWAY_ID: 'default',
  CLOUDFLARE_WEB_SEARCH_PROVIDER: 'ceramic',
  CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS: 'default',
};
for (const [key, value] of Object.entries(webDefaults)) {
  if (!merged[key]?.trim()) merged[key] = value;
}

const lines = [];
for (const line of template.split(/\r?\n/)) {
  if (line.startsWith('# Copy this file')) {
    lines.push('# Generated from .env.example and injected environment secrets (scripts/sync-dotenv-from-env.mjs).');
    continue;
  }
  if (line.startsWith('#') || !line.trim() || !line.includes('=')) {
    lines.push(line);
    continue;
  }
  const key = line.slice(0, line.indexOf('=')).trim();
  lines.push(`${key}=${merged[key] ?? ''}`);
}
const written = new Set(
  lines.filter(line => line.includes('=') && !line.startsWith('#')).map(line => line.slice(0, line.indexOf('=')).trim()),
);
for (const key of Object.keys(webDefaults)) {
  if (!written.has(key)) lines.push(`${key}=${merged[key] ?? ''}`);
}
writeFileSync('.env', `${lines.join('\n')}\n`);
const ready =
  Boolean(merged.MODEL_BASE_URL?.trim()) &&
  Boolean(merged.MODEL_NAME?.trim()) &&
  (Boolean(merged.MODEL_API_KEY?.trim()) || merged.MODEL_NO_AUTH === 'true');
const cloudflareReady =
  merged.SQUAD_WEB_TOOLS_ENABLED !== 'false' &&
  Boolean(merged.CLOUDFLARE_ACCOUNT_ID?.trim()) &&
  Boolean(merged.CLOUDFLARE_API_TOKEN?.trim());
console.log(JSON.stringify({ overridden, ready, cloudflareReady }));
