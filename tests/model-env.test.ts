import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createTeamConfig } from '../team.config.js';
import { loadModelEnvFile, OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { Harness } from './helpers.js';

const defaults = { MODEL_BASE_URL: 'https://provider.example/v1', MODEL_NAME: 'default-model', MODEL_API_KEY: 'test-private-key' };

describe('model services from .env', () => {

  it('never forwards the default credential to a changed endpoint', async () => {
    const env = { ...defaults, BUILDER_3_MODEL_BASE_URL: 'https://other.example/v1' };
    const config = createTeamConfig(env);
    const h = new Harness(config); h.event({ type: 'HANDOFF', owner: 'builder-3' });
    const http = vi.fn<typeof fetch>();
    await new WorkRunner(h.engine, new OpenAICompatibleAdapter(config, { env, transport: http, clock: () => 0 }), () => 0).runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.view().phase).toBe('waitingHuman');
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
