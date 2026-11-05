import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { inspectInstance } from '../.agents/skills/verify-squad/scripts/doctor.mjs';

// Keep the production entry, adapter, runner, HTTP, SQLite and React intact.
// Only the external provider HTTP boundary returns scripted synthetic outputs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const evidence = resolve(process.argv[2] ?? join(root, 'reports/coordination-repair', new Date().toISOString().replaceAll(':', '-')));
assert(!existsSync(evidence), 'Choose a new evidence directory'); mkdirSync(evidence, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'squad-coordination-repair-'));
const database = join(state, 'team.sqlite');
const run = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, status: 'running', checks: [], cleanup: {} };
const log = (action, detail = {}) => appendFileSync(join(evidence, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n');
const until = async (read, accept, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
};
let child, fixture, browser, context, page, timer;
const errors = [], posts = [], provider = [];
async function startFixture() {
  const counts = new Map();
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, undefined, 'Synthetic fixture must receive no credentials');
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert(raw.length < 2_000_000, 'Fixture body bound'); }
      const request = JSON.parse(raw);
      const { workId, context: payload } = JSON.parse(request.messages.find(message => message.role === 'user').content);
      const match = /^You are (.+?), executing (\w+) work\./.exec(request.messages[0].content);
      assert(match && workId, 'Production model protocol drift');
      const [, target, kind] = match, goal = payload.goal?.text ?? '';
      assert(goal.includes('REPAIR_CONTINUE') || goal.includes('REPAIR_EXHAUSTED'), 'Unexpected fixture goal');
      const key = goal + ':' + kind + ':' + target, count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      const repair = request.messages.some(message => message.content.includes('model_output_validation_error'));
      let output;
      if (kind === 'owner') output = count === 1 ? { type: 'blocked', reason: '需要协调当前方案的下一步' }
        : { type: 'deliver', text: '协调修正后完成方案，来源 https://example.org/coordination-verification',
          summary: '协调修正后任务已完成。', artifactIds: [] };
      else if (kind === 'facilitator') {
        assert.equal(typeof payload.owner, 'string', 'Coordinator must receive persisted current owner');
        assert(payload.owner.trim(), 'Coordinator owner must be nonempty');
        output = { type: 'decision', decision: goal.includes('REPAIR_CONTINUE') && repair
          ? { action: 'continue', reason: '由当前负责人继续处理自己的工作' }
          : { action: 'assist', target: payload.owner, question: '核查当前方案', expected: '给出依据', reason: '合成自我求助错误' } };
      } else if (kind === 'check') output = { type: 'check', passed: true, gaps: [] };
      else throw new Error('Unexpected model role: ' + kind);
      if (output.type === 'deliver' && payload.acceptanceCriteria) output.coverage = payload.acceptanceCriteria.map(item => ({
        criterionId: item.id, refs: [{ kind: 'candidateText' }],
      }));
      if (output.type === 'check' && payload.candidate?.acceptance) {
        output.criteriaResults = payload.candidate.acceptance.criteria.map(item => ({ criterionId: item.id, status: 'passed' }));
      }
      const record = { workId, goal, kind, target, owner: payload.owner ?? null, count, repair, outputType: output.type,
        decision: output.type === 'decision' ? output.decision.action : undefined };
      provider.push(record); appendFileSync(join(evidence, 'model-http.jsonl'), JSON.stringify(record) + '\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    } catch (error) {
      errors.push('Fixture: ' + error.message);
      appendFileSync(join(evidence, 'model-http.jsonl'), JSON.stringify({ fixtureError: error.message }) + '\n');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'FixtureFailure' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
  writeFileSync(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
function readStored(roomId, taskId) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId); assert(row, 'Owned room must be persisted');
    const room = JSON.parse(row.data), saved = room.tasks[taskId]; assert(saved?.snapshot?.context, 'Persisted task snapshot');
    return { room, snapshot: saved.snapshot, context: saved.snapshot.context };
  } finally { db.close(); }
}
async function stop() {
  clearTimeout(timer);
  const cleanupErrors = [];
  try { await context?.tracing.stop({ path: join(evidence, 'trace.zip') }); } catch (error) { cleanupErrors.push(error.message); }
  try { await browser?.close(); run.cleanup.browser = true; } catch (error) { cleanupErrors.push(error.message); }
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit'); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(force); }
  }
  run.cleanup.application = !child || child.exitCode !== null || child.signalCode !== null;
  try { await fixture?.close(); run.cleanup.fixture = true; } catch (error) { cleanupErrors.push(error.message); }
  rmSync(state, { recursive: true, force: true }); run.cleanup.state = !existsSync(state);
  if (cleanupErrors.length) throw new Error(cleanupErrors.join('; '));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  errors.push(signal); void browser?.close(); child?.kill('SIGTERM');
});
try {
  assert(existsSync(join(root, 'dist/web/index.html')), 'Run npm run build first');
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  fixture = await startFixture();
  symlinkSync(join(root, 'dist'), join(state, 'dist'), 'dir');
  let output = '';
  child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'scripts/web.ts')], {
    cwd: state, env: { PATH: process.env.PATH, NODE_ENV: 'production', WEB_PORT: String(port), WEB_DATABASE: database,
      MODEL_BASE_URL: fixture.url, MODEL_NAME: 'coordination-verification-fixture', MODEL_NO_AUTH: 'true', MODEL_JSON_MODE: 'true',
      SQUAD_WEB_TOOLS_ENABLED: 'false', SQUAD_LOCAL_TOOLS_ENABLED: 'false', SQUAD_INTENT_ANALYSIS_ENABLED: 'false', SQUAD_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => errors.push(error.message));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(evidence, 'server.log'), chunk); });
  timer = setTimeout(() => { errors.push('Browser verification deadline exceeded'); void browser?.close(); child?.kill('SIGTERM'); }, 180000);
  await until(() => { assert.equal(child.exitCode, null, output); return output; }, text => text.includes(`Squad API: ${url}`), 'owned production entry ready');
  const instance = { pid: child.pid, url, database, root };
  writeFileSync(join(evidence, 'instance.json'), JSON.stringify(instance, null, 2));
  run.doctor = await inspectInstance(instance);
  const modulePath = process.env.SQUAD_PLAYWRIGHT_MODULE ?? (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES && join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs'));
  const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : require('playwright');
  browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--disable-gpu', '--disable-dev-shm-usage'],
    ...(process.env.SQUAD_CHROMIUM ? { executablePath: process.env.SQUAD_CHROMIUM } : {}) });
  run.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).origin === url) {
      posts.push(new URL(request.url()).pathname); log('browser-post', { path: new URL(request.url()).pathname, body: request.postData() });
    }
  });
  const get = async path => { const response = await fetch(url + path, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.json(); };
  const newRoom = async text => {
    const before = (await get('/api/rooms')).rooms;
    log('click', { role: 'button', name: '新建群聊' });
    await page.getByRole('button', { name: '新建群聊', exact: false }).first().click();
    const listing = await until(() => get('/api/rooms'), value => value.rooms.length === before.length + 1, 'new room');
    const room = listing.rooms.find(item => !before.some(old => old.id === item.id)); assert(room);
    await until(() => page.evaluate(() => localStorage.getItem('squad-room')), id => id === room.id, 'selected room');
    await until(() => get(`/api/rooms/${room.id}`), value => value.modelConfigured && value.agents.length === 5, 'configured room');
    log('fill', { label: '群聊消息输入框', text });
    await page.getByRole('textbox', { name: '群聊消息输入框' }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    return room;
  };
  await page.goto(url);
  const completedRoom = await newRoom('REPAIR_CONTINUE 验证协调员纠正自我求助后继续完成方案');
  const completed = await until(() => get(`/api/rooms/${completedRoom.id}`), value => value.tasks.at(-1)?.outcome === 'complete', 'automatic coordination repair completion');
  const completedTask = completed.tasks.at(-1), success = readStored(completedRoom.id, completedTask.id);
  assert.equal(success.context.usage.retries, 1);
  assert.equal(success.context.usage.ordinary, 4); assert.equal(success.context.usage.checks, 1);
  assert.equal(success.context.assists.length, 0); assert.equal(success.context.lateResults.length, 0);
  assert.equal(success.context.trace.filter(item => item.event === 'MODEL_OUTPUT_REPAIR').length, 1);
  assert(success.context.trace.find(item => item.event === 'MODEL_OUTPUT_REPAIR').detail.includes('invalid_decision'));
  const successfulCalls = provider.filter(item => item.goal.includes('REPAIR_CONTINUE'));
  assert.equal(successfulCalls.filter(item => item.kind === 'facilitator').length, 2);
  assert.deepEqual(successfulCalls.filter(item => item.kind === 'facilitator').map(item => [item.owner, item.repair, item.decision]), [['A', false, 'assist'], ['A', true, 'continue']]);
  const successFeed = await get(`/api/debug/rooms/${completedRoom.id}`);
  assert.equal(successFeed.truncated, false); assert(!successFeed.records.some(item => item.phase === 'waitingHuman'));
  await page.getByRole('log', { name: '群聊消息' }).getByText('协调修正后任务已完成。', { exact: true }).waitFor();
  writeFileSync(join(evidence, 'continued.snapshot.json'), JSON.stringify(completed, null, 2));
  writeFileSync(join(evidence, 'continued.sqlite-proof.json'), JSON.stringify(success, null, 2));
  await capture('continued');
  run.checks.push('self-assist is repaired once before COORDINATE, then completes without human waiting or invalid assistance');
  run.checks.push('repair consumes one retry and the additional ordinary model request through the real runner');

  const exhaustedRoom = await newRoom('REPAIR_EXHAUSTED 验证协调员持续自我求助时说明等待原因');
  const exhausted = await until(() => get(`/api/rooms/${exhaustedRoom.id}`), value => value.tasks.at(-1)?.phase === 'waitingHuman', 'bounded coordination repair exhaustion');
  const exhaustedTask = exhausted.tasks.at(-1), failed = readStored(exhaustedRoom.id, exhaustedTask.id), limit = failed.context.config.limits.retries;
  assert.equal(failed.context.usage.retries, limit);
  assert.equal(failed.context.usage.ordinary, limit + 2); assert.equal(failed.context.usage.checks, 0);
  assert.equal(failed.context.assists.length, 0); assert.equal(failed.context.outcome, null);
  assert.match(exhaustedTask.reason, /协调工作未能完成/); assert.match(exhaustedTask.reason, /OUTPUT_REPAIR_EXHAUSTED/); assert.match(exhaustedTask.reason, /请/);
  const exhaustedCalls = provider.filter(item => item.goal.includes('REPAIR_EXHAUSTED') && item.kind === 'facilitator');
  assert.equal(exhaustedCalls.length, limit + 1);
  assert.equal(exhausted.events.filter(event => event.title === '模型输出格式不合规，重新生成').length, limit);
  const failureNotice = exhausted.messages.find(message => message.kind === 'notice' && message.text.includes('协调工作未能完成'));
  assert(failureNotice); assert.equal(failureNotice.text, exhaustedTask.reason);
  const chat = page.getByRole('log', { name: '群聊消息' });
  await chat.getByText(/协调工作未能完成/).first().waitFor(); await chat.getByText(/请/).first().waitFor();
  for (let n = 0; n < 3; n++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const later = await get(`/api/rooms/${exhaustedRoom.id}`);
    assert.equal(later.tasks.at(-1).reason, exhaustedTask.reason);
    assert.equal(later.tasks.at(-1).phase, 'waitingHuman');
    assert(later.messages.some(message => message.id === failureNotice.id && message.text === failureNotice.text));
  }
  assert.equal(provider.filter(item => item.goal.includes('REPAIR_EXHAUSTED') && item.kind === 'facilitator').length, limit + 1);
  writeFileSync(join(evidence, 'exhausted.snapshot.json'), JSON.stringify(exhausted, null, 2));
  writeFileSync(join(evidence, 'exhausted.sqlite-proof.json'), JSON.stringify(failed, null, 2));
  await capture('exhausted');
  run.checks.push('bounded retries stop at the real configured ceiling with no extra provider request');
  run.checks.push('persisted Chinese reason and next action are visible in chat and stable across polling');
  const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const document = await cdp.send('DOM.getDocument');
  const fontNode = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.notice-message .message-text' });
  assert(fontNode.nodeId, 'Need actual Chinese waiting notice');
  const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: fontNode.nodeId });
  writeFileSync(join(evidence, 'chinese-fonts.json'), JSON.stringify(fonts, null, 2));
  assert(fonts.fonts.some(font => font.glyphCount > 0 && /Noto.*CJK|Noto.*SC|WenQuanYi|PingFang/i.test(font.familyName + ' ' + font.postScriptName)), 'Chinese notice needs an actual CJK font');
  await cdp.detach();
  assert.equal(posts.filter(path => path.endsWith('/messages')).length, 2);
  assert(posts.every(path => path === '/api/rooms' || /^\/api\/rooms\/[^/]+\/messages$/.test(path)), 'Verification only writes through normal room/message UI');
  run.doctorAfter = await inspectInstance(instance); assert.deepEqual(errors, []);
  run.status = 'verified';
} catch (error) {
  run.status = 'failed'; run.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
} finally {
  try { await stop(); } catch (error) { run.cleanup.error = error.message; run.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
  console.log(JSON.stringify({ status: run.status, source: run.source, evidence, checks: run.checks, cleanup: run.cleanup }, null, 2));
}
