#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFixture } from './model-fixture.mjs';
import { verifyBuild } from './build-proof.mjs';
import { inspectInstance } from './doctor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const options = Object.fromEntries(Array.from({ length: process.argv.slice(2).length / 2 }, (_, index) => process.argv.slice(2).slice(index * 2, index * 2 + 2)));
const scenario = options['--bdd'] ?? options['--case'] ?? 'BT_U20';
const variant = options['--variant'] ?? '普通';
assert(['BT_U20', 'BT_U21'].includes(scenario));
assert(scenario === 'BT_U20' ? ['普通', '来源引用'].includes(variant) : ['成功', '失败'].includes(variant));
const evidence = resolve(options['--evidence'] ?? join(root, 'reports/verify-web-composition', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
assert(!existsSync(evidence), 'Keep every baseline and failed run in a new evidence directory');
mkdirSync(evidence, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'squad-composition-'));
const workspace = mkdtempSync(join(tmpdir(), 'squad-composition-workspace-'));
const database = join(state, 'team.sqlite');
const actions = join(evidence, 'actions.jsonl');
const log = (action, detail = {}) => appendFileSync(actions, JSON.stringify({ action, ...detail }) + '\n');
const run = { status: 'running', scenario, variant, evidence, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), steps: [], completed: [], cleanup: {} };
let fixture, supervisor, app, reaped, browser, context, page, url, timer;
let prepared, finalProof;
const posts = [], requestErrors = [], failures = [];
const groups = new Set();
const checkpoint = (name, value) => writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2));
async function until(read, accepts, name, limit = 15_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise(ready => setTimeout(ready, 30));
  }
  throw new Error('Timed out: ' + name);
}
async function get(path) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); return response.json();
}
const snapshot = id => get('/api/rooms/' + id);
const input = () => page.getByRole('textbox', { name: '群聊消息输入框' });
function groupGone(pid) { try { process.kill(-pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }
function signal(pid, kind) { assert(groups.has(pid)); try { process.kill(-pid, kind); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
async function launch() {
  const portServer = createServer();
  await new Promise(ready => portServer.listen(0, '127.0.0.1', ready));
  const port = portServer.address().port;
  await new Promise(ready => portServer.close(ready));
  url = 'http://127.0.0.1:' + port;
  symlinkSync(join(root, 'dist'), join(state, 'dist'), 'dir');
  mkdirSync(join(state, 'skills'));
  const env = { PATH: process.env.PATH, HOME: state, TMPDIR: state, NODE_ENV: 'production', WEB_PORT: String(port), WEB_DATABASE: database,
    MODEL_BASE_URL: fixture.url, MODEL_NAME: 'composition-fixture', MODEL_NO_AUTH: 'true', MODEL_JSON_MODE: 'true', SQUAD_WEB_TOOLS_ENABLED: 'false',
    SQUAD_LOCAL_SKILLS_ROOTS: join(state, 'skills'), SQUAD_WORKSPACE_ROOT: workspace };
  supervisor = spawn('python3', ['-u', join(root, '.agents/skills/verify-squad/scripts/app-supervisor.py'), String(process.pid), process.execPath,
    '--experimental-transform-types', '--loader', pathToFileURL(join(root, 'tests/fixtures/typescript-loader.mjs')).href, join(root, 'scripts/web.ts')],
  { cwd: state, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  groups.add(supervisor.pid);
  let control = '', output = '';
  supervisor.stdout.on('data', chunk => {
    control += chunk;
    for (let end; (end = control.indexOf('\n')) >= 0;) {
      const line = control.slice(0, end); control = control.slice(end + 1);
      if (!line.startsWith('SQUAD_BROWSER_APP ')) continue;
      const value = JSON.parse(line.slice(18));
      assert.equal(value.supervisorPid, supervisor.pid);
      if (value.phase === 'spawned') { app = value; groups.add(value.appPid); }
      else if (value.phase === 'reaped') reaped = value;
    }
  });
  for (const stream of [supervisor.stdout, supervisor.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(evidence, 'server.log'), chunk); });
  await until(async () => {
    assert.equal(supervisor.exitCode, null, output); return app && output.includes('Squad API: ' + url);
  }, Boolean, 'owned production app ready');
  run.instance = { pid: app.appPid, url, database, root };
  run.doctor = await inspectInstance(run.instance);
}
async function capture(name) {
  await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
  writeFileSync(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
async function createRoom() {
  const before = (await get('/api/rooms')).rooms;
  await page.getByRole('button', { name: '新建群聊', exact: false }).click();
  const list = await until(() => get('/api/rooms'), result => result.rooms.length === before.length + 1, 'new room created');
  const room = list.rooms.find(candidate => !before.some(old => old.id === candidate.id));
  await until(() => page.evaluate(() => localStorage.getItem('squad-room')), id => id === room.id, 'new room selected');
  await input().waitFor(); return room;
}
async function choose(room, wait = true) {
  const current = await snapshot(room.id);
  await page.getByRole('navigation', { name: '群聊列表', exact: true }).getByRole('button', { name: current.room.title, exact: true }).click();
  if (wait) {
    await page.getByRole('heading', { name: current.room.title, exact: true }).waitFor();
    await until(() => page.getByText('正在加载群聊…', { exact: true }).count(), count => count === 0, 'selected snapshot loaded');
    await until(() => input().isEnabled(), Boolean, 'selected input enabled');
  }
}
async function send(text) { await input().fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); }
async function completed(room) { return until(() => snapshot(room.id), value => value.tasks.at(-1)?.outcome === 'complete', 'task completed'); }
function stored(room) {
  const db = new DatabaseSync(database, { readOnly: true });
  try { return { room: JSON.parse(db.prepare('SELECT data FROM rooms WHERE id=?').get(room.id).data), receipts: db.prepare('SELECT id,fingerprint,result FROM receipts WHERE room_id=?').all(room.id) }; }
  finally { db.close(); }
}
async function prepareRetry() {
  const first = await createRoom();
  await send('VERIFY_COMPOSITION_SOURCE 先完成原报告');
  const original = await completed(first);
  const second = await createRoom();
  await choose(first);
  let source;
  if (variant === '来源引用') {
    const task = original.tasks.at(-1), artifact = task.artifacts[0];
    source = { sourceTaskId: task.id, artifactId: artifact.id };
    await page.getByRole('log').getByRole('button', { name: '查看 verification-report.md', exact: true }).first().click();
    await page.getByRole('button', { name: '引用到新任务', exact: true }).click();
  }
  const text = variant === '来源引用' ? 'VERIFY_REVISION 跨群后重试相同来源修订' : 'VERIFY_COMPOSITION_A 跨群后重试同一消息';
  let dropped = false;
  const route = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200, 'Only discard an actual committed service response');
    log('committed-response-dropped', { room: first.id, body: route.request().postData() });
    dropped = true; await route.abort('failed');
  };
  await page.route('**/api/rooms/' + first.id + '/messages', route);
  await send(text);
  await page.getByRole('alert').waitFor();
  assert(dropped); assert.equal(await input().inputValue(), text);
  if (source) assert.equal(await page.getByRole('button', { name: '移除产物引用', exact: true }).count(), 1);
  await page.unroute('**/api/rooms/' + first.id + '/messages', route);
  await completed(first);
  const before = await snapshot(first.id);
  assert.equal(before.messages.filter(message => message.kind === 'user' && message.text === text).length, 1);
  prepared = { first, second, text, source, before };
  checkpoint('retry-before', { ...prepared, sqlite: stored(first) });
  await capture('committed-receipt-lost');
}
async function interleaveRetry() {
  const { first, second, text } = prepared;
  await choose(second); await send('VERIFY_COMPOSITION_B 另一群的独立消息'); await completed(second);
  await input().fill('另一群尚未发送的草稿');
  await choose(first); assert.equal(await input().inputValue(), text);
  if (prepared.source) assert.equal(await page.getByRole('button', { name: '移除产物引用', exact: true }).count(), 1);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => input().inputValue(), value => value === '', 'successful retry clears original draft');
  await completed(first);
  prepared.after = await snapshot(first.id);
  await capture('cross-room-retry');
}
async function identity() {
  const attempts = posts.filter(post => post.path === '/api/rooms/' + prepared.first.id + '/messages' && JSON.parse(post.body).text === prepared.text).map(post => JSON.parse(post.body));
  assert.equal(attempts.length, 2, 'Two actual browser sends must reach the same room');
  assert.equal(attempts[1].id, attempts[0].id, 'CrossRoomRetryIdentity: another room must not erase the original retry identity');
  assert.deepEqual(attempts[1], attempts[0], 'Retry must preserve the whole submitted payload');
  if (prepared.source) assert.deepEqual(attempts[1].sourceArtifact, prepared.source);
  checkpoint('retry-posts', attempts);
}
async function persisted() {
  const { first, second, text, before, after } = prepared;
  assert.equal(after.messages.filter(message => message.kind === 'user' && message.text === text).length, 1, 'CrossRoomOnce: one original message');
  assert.equal(after.tasks.length, before.tasks.length, 'A duplicate receipt must not create a second task');
  assert.deepEqual(after.works, before.works, 'A duplicate receipt must not schedule another work');
  const proof = stored(first);
  const userMessages = Object.values(proof.room.tasks).flatMap(task => task.snapshot.context.messages).filter(message => message.kind === 'user' && message.text === text);
  assert.equal(userMessages.length, 1, 'SQLite contains one original message');
  await choose(second); assert.equal(await input().inputValue(), '另一群尚未发送的草稿');
  const other = await snapshot(second.id);
  assert.equal(other.messages.filter(message => message.kind === 'user').length, 1);
  assert(!other.messages.some(message => message.text === text));
  finalProof = { first: { snapshot: after, sqlite: proof }, second: { snapshot: other, sqlite: stored(second) } };
  checkpoint('persistence-proof', finalProof);
}
async function prepareSnapshot() {
  const first = await createRoom(); await send('VERIFY_COMPOSITION_OLD 只属于原群的内容'); await completed(first);
  const second = await createRoom(); await send('VERIFY_COMPOSITION_CURRENT 只属于当前群的内容'); await completed(second);
  let release, held;
  const barrier = new Promise(ready => { release = ready; });
  const handler = async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    held = true; log('old-real-snapshot-held', { room: first.id });
    await barrier;
    try {
      if (variant === '成功') await route.fulfill({ response });
      else await route.abort('failed');
    } catch (error) { log('old-response-already-cancelled', { message: error.message }); }
  };
  await page.route('**/api/rooms/' + first.id, handler);
  await choose(first, false); await until(async () => held, Boolean, 'old real snapshot held');
  prepared = { first, second, release, handler };
}
async function interleaveSnapshot() {
  const { first, second } = prepared;
  await choose(second);
  const expected = (await snapshot(second.id)).room.title;
  await page.evaluate(() => {
    globalThis.__compositionRenders = [];
    globalThis.__compositionObserver = new MutationObserver(() => globalThis.__compositionRenders.push({ title: document.querySelector('h1')?.textContent,
      messages: document.querySelector('[aria-label="群聊消息"]')?.textContent, connection: document.querySelector('.connection-label')?.textContent }));
    globalThis.__compositionObserver.observe(document.querySelector('main'), { childList: true, subtree: true, characterData: true });
  });
  let currentResponses = 0;
  const observe = response => { if (response.url() === url + '/api/rooms/' + second.id) currentResponses++; };
  page.on('response', observe);
  prepared.release();
  await until(async () => currentResponses, count => count >= 2, 'current room polls after old completion');
  page.off('response', observe);
  await page.unroute('**/api/rooms/' + first.id, prepared.handler);
  const renders = await page.evaluate(() => { globalThis.__compositionObserver.disconnect(); return globalThis.__compositionRenders; });
  checkpoint('snapshot-render-history', renders);
  assert(renders.every(render => render.title === expected && !render.messages?.includes('VERIFY_COMPOSITION_OLD') && render.connection === '已连接'), 'CurrentRoomIsolation: old snapshot must never replace current room or its connection even temporarily');
  prepared.expected = expected;
}
async function currentSnapshot() {
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), prepared.expected);
  assert.equal(await page.evaluate(() => localStorage.getItem('squad-room')), prepared.second.id);
  assert.equal(await page.getByText('已连接', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('log').getByText('VERIFY_COMPOSITION_OLD 只属于原群的内容', { exact: true }).count(), 0);
  await page.getByRole('log').getByText('VERIFY_COMPOSITION_CURRENT 只属于当前群的内容', { exact: true }).waitFor();
  checkpoint('snapshot-proof', { first: await snapshot(prepared.first.id), second: await snapshot(prepared.second.id), requestErrors });
  await capture('current-after-old-completion');
}
const commands = scenario === 'BT_U20' ? { prepare: prepareRetry, interleave: interleaveRetry, identity, persisted }
  : { prepare: prepareSnapshot, interleave: interleaveSnapshot, current: currentSnapshot };
async function execute(command) {
  assert.equal(command, Object.keys(commands)[run.steps.length], 'Every declared scenario step executes in order');
  await commands[command](); run.steps.push(command); log('step-passed', { command });
}
async function drive() {
  if (!options['--bdd']) { for (const command of Object.keys(commands)) await execute(command); return; }
  assert(process.send, 'BDD execution requires IPC');
  process.send({ id: 'ready', result: { evidence, browser: browser.version(), source: run.source } });
  await new Promise(done => {
    let busy = false;
    process.on('message', async message => {
      if (message.command === 'close') { done(); return; }
      if (busy) { process.send({ id: message.id, error: 'A previous scenario step is still running' }); return; }
      busy = true;
      try { await execute(message.command); process.send({ id: message.id, result: { evidence } }); }
      catch (error) { failures.push(error.stack); process.send({ id: message.id, error: error.stack }); }
      finally { busy = false; }
    });
    process.once('disconnect', done);
  });
  assert.deepEqual(run.steps, Object.keys(commands)); assert.equal(failures.length, 0, failures.join('\n'));
}
let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    clearTimeout(timer); prepared?.release?.();
    if (context) await context.tracing.stop({ path: join(evidence, 'trace.zip') }).catch(error => failures.push(error.message));
    if (browser) await browser.close();
    if (supervisor && supervisor.exitCode === null) {
      const closed = once(supervisor, 'close');
      signal(app?.appPid ?? supervisor.pid, 'SIGTERM');
      const kill = setTimeout(() => signal(app?.appPid ?? supervisor.pid, 'SIGKILL'), 5000);
      try { await closed; } finally { clearTimeout(kill); }
    }
    if (fixture) await fixture.close();
    const gone = [...groups].every(groupGone);
    if (gone) { rmSync(state, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); }
    run.process = { app, reaped, supervisorExit: supervisor?.exitCode };
    run.cleanup = { processGroupsGone: gone, reaped: !app || reaped?.reapedAll === true, stateRemoved: !existsSync(state) && !existsSync(workspace), browserClosed: !browser?.isConnected(), evidenceRetained: existsSync(actions) };
    assert(Object.values(run.cleanup).every(Boolean), 'Owned browser/app resources must be released');
  })(); return cleaning;
}
async function interrupted(reason) { run.error = reason; process.exitCode = 1; try { await cleanup(); } finally { run.status = 'failed'; checkpoint('run', run); process.exit(1); } }
process.once('SIGINT', () => { void interrupted('SIGINT'); });
process.once('SIGTERM', () => { void interrupted('SIGTERM'); });
log('start', { scenario, variant });
try {
  run.build = verifyBuild(root);
  fixture = await startFixture(join(evidence, 'model-http.jsonl'));
  await launch();
  const require = createRequire(join(root, 'package.json'));
  const { chromium } = process.env.SQUAD_PLAYWRIGHT_MODULE ? await import(pathToFileURL(resolve(process.env.SQUAD_PLAYWRIGHT_MODULE)).href) : require('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.SQUAD_CHROMIUM ? { executablePath: process.env.SQUAD_CHROMIUM } : {}) });
  run.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') { const value = { path: new URL(request.url()).pathname, body: request.postData() }; posts.push(value); log('browser-post', value); } });
  page.on('requestfailed', request => requestErrors.push({ url: request.url(), error: request.failure() }));
  timer = setTimeout(() => { void interrupted('Composition verification deadline exceeded'); }, 150_000);
  await page.goto(url); await page.getByText('已连接', { exact: true }).waitFor();
  await drive(); run.buildAfter = verifyBuild(root); run.completed.push(scenario); run.status = 'verified';
} catch (error) {
  run.status = 'failed'; run.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
} finally {
  try { await cleanup(); } catch (error) { failures.push(error.stack); process.exitCode = 1; }
  if (failures.length) { run.status = 'failed'; process.exitCode = 1; }
  run.failures = failures; checkpoint('run', run);
  console.log(JSON.stringify({ status: run.status, evidence, error: run.error, failures }));
}
if (process.connected) process.disconnect();
