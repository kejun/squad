import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDocument, liveBehaviorCases, liveOracleExamples, loginDocument } from './shared-agent-behavior-live-fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.argv[2] ?? join(root, 'work/shared-behavior-live-controls-' + Date.now()));
const temporary = mkdtempSync(join(tmpdir(), 'squad-prompt-controls-'));
const fixtureKey = 'controlled-private-credential-never-persist-741';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
assert(!existsSync(evidence)); mkdirSync(evidence, { recursive: true, mode: 0o700 });

function allFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? allFiles(join(path, entry.name)) : [join(path, entry.name)]);
}
const before = sha(readFileSync(join(root, 'src/model-adapter.ts')));
let requests = 0, invalid = false;
const provider = createServer(async (request, response) => {
  requests++;
  try {
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: { role: string; content: string }[] };
    if (invalid) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(json({ error: { code: 'invalid_api_key', message: `Bearer ${fixtureKey}` } })); return;
    }
    const inputs = body.messages.filter(message => message.role === 'user').flatMap(message => {
      try { const value = JSON.parse(message.content); return typeof value.workId === 'string' && value.context && typeof value.context === 'object' ? [value] : []; }
      catch { return []; }
    });
    assert.equal(inputs.length, 1, 'Controlled provider must identify one actual work envelope');
    const test = liveBehaviorCases.find(test => inputs[0]!.workId === `work:${test.id}`); assert(test);
    const fetched = body.messages.some(message => {
      try { return JSON.parse(message.content).type === 'web_fetch_result'; } catch { return false; }
    });
    const output = !fetched && (test.id === 'LB02' || test.id === 'LB04')
      ? { type: 'web_fetch', url: test.id === 'LB02' ? loginDocument : backupDocument }
      : liveOracleExamples(test).good.rawFinal;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(json({ model: body.model, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      debugCredential: request.headers.authorization,
      choices: [{ finish_reason: 'stop', message: { content: json(output) } }] }));
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' }); response.end(json({ error: { code: 'CONTROLLED_PROVIDER_PROTOCOL_ERROR' } }));
  }
});

async function child(extra: string[], folder: string) {
  const address = provider.address(); assert(address && typeof address !== 'string');
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: temporary };
  for (const key of Object.keys(env)) if (/^(?:MODEL|A_MODEL|B_MODEL|BUILDER_[1-3]_MODEL|FACILITATOR_MODEL|CHECK_MODEL|INTENT_MODEL)_/.test(key)) delete env[key];
  Object.assign(env, { MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_NAME: 'controlled-behavior-fixture',
    MODEL_API_KEY: fixtureKey, MODEL_JSON_MODE: 'true' });
  return await new Promise<{ code: number | null; signal: string | null }>((resolveResult, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'tests/shared-agent-behavior-live.ts'), '--run', '--controlled-provider',
      '--repeats', '1', '--evidence', folder, ...extra], { cwd: temporary, env, detached: true });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; if (process.pid !== undefined) try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch {} }, 180_000);
    process.stdout?.on('data', value => { stdout += String(value); }); process.stderr?.on('data', value => { stderr += String(value); });
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(evidence, extra.length ? 'invalid.log' : 'controlled.log'), (stdout + stderr).replaceAll(fixtureKey, '[redacted]'));
      if (killed) reject(new Error('CONTROLLED_EVALUATOR_TIMEOUT'));
      else resolveResult({ code, signal });
    });
  });
}

async function main() {
  const summary: Record<string, unknown> = { layer: 'evaluator wiring/controls only; scripted replies do not measure prompt behavior', status: 'running' };
  try {
    await new Promise<void>(resolveReady => provider.listen(0, '127.0.0.1', resolveReady));
    const successful = await child([], join(evidence, 'controlled')); assert.equal(successful.code, 0); assert.equal(successful.signal, null);
    const run = JSON.parse(readFileSync(join(evidence, 'controlled/run.json'), 'utf8'));
    assert.equal(run.studyKind, 'controlled-provider-harness'); assert.equal(run.status, 'completed');
    assert.equal(run.actualTrials, 20); assert.equal(run.networkRequests, 24);
    assert.equal(run.automatic.baselineHardPassed, 10); assert.equal(run.automatic.candidateHardPassed, 10);
    assert.equal(run.automatic.eligibleSamples, 20); assert(run.pairs.every((pair: { comparableInputs: boolean }) => pair.comparableInputs));
    assert.equal(run.manualReview.completed, 0); assert.equal(run.cleanup, true);
    invalid = true;
    const beforeInvalid = requests, rejected = await child(['--cases', 'LB07'], join(evidence, 'invalid'));
    assert.equal(rejected.code, 1); assert.equal(rejected.signal, null);
    const invalidRun = JSON.parse(readFileSync(join(evidence, 'invalid/run.json'), 'utf8'));
    assert.equal(invalidRun.status, 'incomplete'); assert.equal(invalidRun.automatic.providerInvalidSamples, 1);
    assert.equal(invalidRun.automatic.eligibleSamples, 0); assert.equal(invalidRun.networkRequests, 1);
    assert.equal(requests - beforeInvalid, 1, 'Known authentication failure must not be automatically retried across cases or variants');
    assert.equal(invalidRun.cleanup, true);
    const actualKey = globalThis.process.env.MODEL_API_KEY;
    const artifactBodies = allFiles(evidence).map(path => readFileSync(path, 'utf8'));
    assert(artifactBodies.every(body => !body.includes(fixtureKey)), 'Controlled credential must be removed before any evidence is persisted');
    assert(!actualKey || artifactBodies.every(body => !body.includes(actualKey)), 'Actual credential must never enter controlled evidence');
    assert.equal(sha(readFileSync(join(root, 'src/model-adapter.ts'))), before);
    Object.assign(summary, { status: 'passed', controlledTrials: 20, controlledRequests: 24, providerInvalidRequests: 1,
      invalidWasNotBehaviorFailure: true, pairInputsEqual: true, oracleControls: 10,
      sensitiveValuesAbsent: true, productionSourceUnchanged: true, realProviderRequests: 0 });
  } catch (error) {
    summary.status = 'failed'; summary.errorClass = error instanceof Error ? error.name : 'UnknownError';
    throw error;
  } finally {
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).split('\n')
      .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
    for (const path of worktrees.filter(path => path.startsWith(temporary + '/'))) execFileSync('git', ['worktree', 'remove', '--force', path], { cwd: root, stdio: 'pipe' });
    rmSync(temporary, { recursive: true, force: true }); summary.cleanup = !existsSync(temporary);
    write(join(evidence, 'controls.json'), summary);
  }
  console.log(json({ ...summary, evidence }));
}

main().catch(error => { console.error(json({ status: 'failed', code: error instanceof Error ? error.name : 'UnknownError', evidence })); globalThis.process.exitCode = 1; });
