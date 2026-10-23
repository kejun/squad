import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareWebTools } from '../src/web-tools.js';
import { loadModelEnvFile, type ModelEnvironment } from '../src/model-env.js';

export const oldWebEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'old_file_token',
  CLOUDFLARE_WEB_SEARCH_PROVIDER: 'exa', CLOUDFLARE_AI_GATEWAY_ID: 'old-gateway', CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS: 'old-key',
};
export const newWebEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'new_file_token',
  CLOUDFLARE_WEB_SEARCH_PROVIDER: 'linkup', CLOUDFLARE_AI_GATEWAY_ID: 'new-gateway', CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS: 'new-key',
};
export const explicitWebEnv = { ...oldWebEnv, CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32), CLOUDFLARE_API_TOKEN: 'explicit_token' };
export interface EnvProbe {
  calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  error: string;
  callsAfterFailure: number;
}

/** Use a separate host so .env edits and process variables never affect other scenarios. */
export function runWebEnvScenario(scenario: string, mode = ''): EnvProbe {
  const directory = mkdtempSync(join(tmpdir(), 'squad-web-env-'));
  try {
    const child = spawnSync(process.execPath, [
      '--import', resolve('node_modules/tsx/dist/loader.mjs'), fileURLToPath(import.meta.url), '--probe', scenario, mode,
    ], { cwd: directory, env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tests/bdd/tsconfig.json') }, encoding: 'utf8', timeout: 10000 });
    if (child.status !== 0) throw new Error(`Environment probe failed: ${child.error?.message ?? child.stderr.slice(-4000)}`);
    return JSON.parse(child.stdout) as EnvProbe;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

async function probe(scenario: string, mode: string): Promise<EnvProbe> {
  for (const key of Object.keys(process.env)) if (key.startsWith('CLOUDFLARE_')) delete process.env[key];
  const writeEnv = (env: ModelEnvironment) => writeFileSync('.env', Object.entries(env).map(([key, value]) => `${key}=${value ?? ''}`).join('\n'));
  writeEnv(oldWebEnv);
  if (scenario === 'priority' && mode === '进程环境') Object.assign(process.env, explicitWebEnv);
  loadModelEnvFile();
  const result: EnvProbe = { calls: [], error: '', callsAfterFailure: 0 };
  let releasePage!: () => void;
  let pageStarted!: () => void;
  const pageWaiting = new Promise<void>(resolve => { pageStarted = resolve; });
  const pageReady = new Promise<void>(resolve => { releasePage = resolve; });
  let holdPage = scenario === 'inflight';
  const transport: typeof fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://api.cloudflare.com/')) {
      result.calls.push({ url: target, headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
      if (target.endsWith('/ai/websearch/')) return Response.json({ items: [], metadata: { query: 'reload', requestId: 'reload', latencyMs: 1 } });
      return Response.json({ success: true, result: [{ format: 'markdown', data: '# Evidence' }] });
    }
    if (holdPage) { holdPage = false; pageStarted(); await pageReady; }
    return new Response('<h1>Evidence</h1>', { headers: { 'content-type': 'text/html' } });
  };
  const tools = new CloudflareWebTools({ transport, ...(scenario === 'priority' && mode === '注入环境' ? { env: explicitWebEnv } : {}) });
  const search = () => tools.search({ query: 'reload' }, new AbortController().signal);
  const fetchPage = () => tools.fetch({ url: 'https://evidence.example/report' }, new AbortController().signal);
  if (scenario === 'rotation') {
    const request = mode === 'web_search' ? search : fetchPage;
    await request(); writeEnv(newWebEnv); await request();
  } else if (scenario === 'priority') {
    await search(); writeEnv(newWebEnv);
    if (mode === '注入环境') { rmSync('.env'); mkdirSync('.env'); }
    await search();
  } else if (scenario === 'revocation') {
    await search();
    if (mode === '删除令牌') {
      const { CLOUDFLARE_API_TOKEN: _token, ...rest } = oldWebEnv;
      writeEnv(rest);
    } else if (mode === '清空令牌') writeEnv({ ...oldWebEnv, CLOUDFLARE_API_TOKEN: '' });
    else if (mode === '删除文件') rmSync('.env');
    else if (mode === '读取失败') { rmSync('.env'); mkdirSync('.env'); }
    else throw new Error('Unknown revocation mode');
    try { await search(); } catch (error) { result.error = String(error); }
    result.callsAfterFailure = result.calls.length;
    rmSync('.env', { recursive: true, force: true }); writeEnv(newWebEnv); await search();
  } else if (scenario === 'inflight') {
    const pending = fetchPage();
    await pageWaiting; writeEnv(newWebEnv); await search(); releasePage();
    await pending; await fetchPage();
  } else throw new Error('Unknown environment scenario');
  return result;
}

if (process.argv[2] === '--probe') {
  probe(process.argv[3]!, process.argv[4] ?? '').then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error); process.exitCode = 1;
  });
}
