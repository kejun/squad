import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createTeamConfig } from '../team.config.js';
import { configureModelsFromEnv, loadModelEnvFile, OpenAICompatibleAdapter, resolveModel, WorkRunner } from '../src/index.js';
import { Harness } from './helpers.js';

const defaults = { MODEL_BASE_URL: 'https://provider.example/v1', MODEL_NAME: 'default-model', MODEL_API_KEY: 'test-private-key' };

describe('model services from .env', () => {
  it('keeps offline configuration usable without provider settings', () => {
    const config = createTeamConfig({});
    expect(config.bots).toHaveLength(5); expect(config.models).toBeUndefined();
  });

  it('lets every bot use its own model with shared connection defaults', () => {
    const config = createTeamConfig({ ...defaults, A_MODEL_NAME: 'planner', B_MODEL_NAME: 'reviewer',
      BUILDER_1_MODEL_NAME: 'dev1', BUILDER_2_MODEL_NAME: 'dev2', BUILDER_3_MODEL_NAME: 'dev3' });
    for (const [id, name] of [['A', 'planner'], ['B', 'reviewer'], ['builder-1', 'dev1'], ['builder-2', 'dev2'], ['builder-3', 'dev3']]) {
      const selected = resolveModel(config, 'owner', id!);
      expect(selected?.service.model).toBe(name);
      expect(selected?.service.baseUrl).toBe(defaults.MODEL_BASE_URL);
      expect(selected?.service.apiKeyEnv).toBe('MODEL_API_KEY');
    }
    expect(JSON.stringify(config)).not.toContain(defaults.MODEL_API_KEY);
  });

  it('supports independent providers and role-specific credentials', () => {
    const config = createTeamConfig({ ...defaults, BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1',
      BUILDER_3_MODEL_NAME: 'other-model', BUILDER_3_MODEL_API_KEY: 'other-private-key' });
    expect(resolveModel(config, 'owner', 'builder-3')?.service).toMatchObject({ baseUrl: 'https://other.example/v1', model: 'other-model', apiKeyEnv: 'BUILDER_3_MODEL_API_KEY' });
    expect(JSON.stringify(config)).not.toContain('other-private-key');
    expect(resolveModel(config, 'owner', 'A')?.service.model).toBe('default-model');
  });

  it('never forwards the default credential to a changed endpoint', async () => {
    const env = { ...defaults, BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1' };
    const config = createTeamConfig(env);
    const selected = resolveModel(config, 'owner', 'builder-3');
    expect(selected?.service.apiKeyEnv).toBe('BUILDER_3_MODEL_API_KEY');
    const h = new Harness(config); h.event({ type: 'HANDOFF', owner: 'builder-3' });
    const http = vi.fn<typeof fetch>();
    await new WorkRunner(h.engine, new OpenAICompatibleAdapter(config, { env, transport: http, clock: () => 0 }), () => 0).runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.view().phase).toBe('waitingHuman');
  });

  it('allows an explicitly unauthenticated local service', () => {
    const config = createTeamConfig({ MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'local', MODEL_NO_AUTH: 'true',
      BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1' });
    expect(resolveModel(config, 'owner', 'A')?.service.apiKeyEnv).toBeUndefined();
    expect(resolveModel(config, 'owner', 'builder-3')?.service.apiKeyEnv).toBe('BUILDER_3_MODEL_API_KEY');
  });

  it('configures facilitator, final check and request parameters', () => {
    const config = createTeamConfig({ ...defaults, FACILITATOR_MODEL_NAME: 'coordinator', CHECK_MODEL_NAME: 'checker',
      MODEL_TEMPERATURE: '0.2', MODEL_MAX_TOKENS: '8192', MODEL_EXTRA_BODY: '{"enable_thinking":false}', CHECK_MODEL_JSON_MODE: 'false' });
    expect(resolveModel(config, 'facilitator', 'facilitator')?.service.model).toBe('coordinator');
    expect(resolveModel(config, 'check', 'facilitator')?.service).toMatchObject({ model: 'checker', jsonMode: false, temperature: 0.2, maxTokens: 8192, extraBody: { enable_thinking: false } });
  });

  it.each([
    { MODEL_BASE_URL: '' }, { MODEL_JSON_MODE: 'sometimes' }, { MODEL_TEMPERATURE: 'Infinity' },
    { MODEL_MAX_TOKENS: '-1' }, { MODEL_EXTRA_BODY: '{private-invalid-value' }, { MODEL_EXTRA_BODY: '{"messages":[]}' },
  ])('rejects invalid environment configuration without echoing its value %#', change => {
    expect(() => createTeamConfig({ ...defaults, ...change })).toThrow();
    try { createTeamConfig({ ...defaults, ...change }); } catch (error) { expect(String(error)).not.toContain('private-invalid-value'); }
  });

  it('does not mutate an existing team when resolving environment settings', () => {
    const base = createTeamConfig({}); const copy = structuredClone(base);
    configureModelsFromEnv(base, { ...defaults, A_MODEL_NAME: 'planner' }); expect(base).toEqual(copy);
  });

  it('loads a real .env automatically and honors existing process variables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'squad-env-'));
    try {
      writeFileSync(join(directory, '.env'), 'MODEL_BASE_URL="https://file.example/v1"\nMODEL_NAME="file model"\nMODEL_API_KEY="file-private-key"\nBUILDER_2_MODEL_NAME=builder-two\n');
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(?:MODEL_|A_MODEL_|B_MODEL_|BUILDER_[123]_MODEL_|FACILITATOR_MODEL_|CHECK_MODEL_)/.test(key)) delete env[key];
      env.MODEL_NAME = 'process-model';
      const configUrl = pathToFileURL(resolve('team.config.ts')).href;
      const script = `const { config } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(config));`;
      const child = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', script], { cwd: directory, env, encoding: 'utf8', timeout: 10000 });
      expect(child.status).toBe(0);
      const config = JSON.parse(child.stdout);
      expect(config.models.services.primary.model).toBe('process-model');
      expect(config.models.services.primary.baseUrl).toBe('https://file.example/v1');
      expect(config.models.services['builder-2'].model).toBe('builder-two');
      expect(child.stdout).not.toContain('file-private-key');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('ignores a missing file and reports other file errors safely', () => {
    const directory = mkdtempSync(join(tmpdir(), 'squad-env-'));
    try {
      expect(() => loadModelEnvFile(join(directory, 'missing'))).not.toThrow();
      expect(() => loadModelEnvFile(directory)).toThrow('Unable to load model environment file');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
