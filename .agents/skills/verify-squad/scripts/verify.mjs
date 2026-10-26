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
import { startFixture, report } from './model-fixture.mjs';
import { inspectInstance } from './doctor.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const allowed = ['rooms', 'reports', 'control', 'assistance', 'layout'];
if (args.includes('--help')) {
  console.log('Usage: verify.mjs [--feature rooms|reports|control|assistance|layout|all] [--evidence ABSOLUTE_NEW_DIRECTORY]\nRequires npm ci, npm run build, Playwright and Chromium. See SKILL.md.');
  process.exit(0);
}
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  assert(args[i + 1] && !args[i + 1].startsWith('--'), `Missing ${name} value`);
  return args[i + 1];
}
for (let i = 0; i < args.length; i += 2) assert(['--feature', '--evidence'].includes(args[i]), `Unknown option: ${args[i]}`);
const selected = option('--feature', 'rooms');
assert([...allowed, 'all'].includes(selected), `Unknown feature: ${selected}`);
const evidence = resolve(option('--evidence', join(root, 'reports/verify-squad', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid)));
assert(!existsSync(evidence), 'Use a new evidence directory; existing proof is never overwritten');
mkdirSync(evidence, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'squad-verify-'));
const database = join(state, 'team.sqlite');
const actions = join(evidence, 'actions.jsonl');
const require = createRequire(join(root, 'package.json'));
const run = { status: 'running', feature: selected, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, evidence, state, database, completed: [], doctor: [], cleanup: {} };
let fixture, child, browser, context, page, port, url, timer, cleanupPromise;
const failures = [];
const log = (action, detail = {}) => appendFileSync(actions, JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n');
async function until(get, predicate, label, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await get();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function get(path) {
  const response = await fetch(url + path, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, `GET ${path}`);
  return response.json();
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function stopApp() {
  if (!child) return;
  const owned = child;
  if (owned.exitCode === null && owned.signalCode === null) {
    const ended = once(owned, 'exit');
    owned.kill('SIGTERM');
    const killTimer = setTimeout(() => owned.kill('SIGKILL'), 5000);
    try { await ended; } finally { clearTimeout(killTimer); }
  }
  log('app-stopped', { pid: owned.pid, code: owned.exitCode, signal: owned.signalCode });
  child = undefined;
}
async function launch() {
  port ??= await freePort();
  url = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: state, TMPDIR: state, NODE_ENV: 'production',
    WEB_PORT: String(port), WEB_DATABASE: database, MODEL_BASE_URL: fixture.url,
    MODEL_NAME: 'squad-verification-fixture', MODEL_NO_AUTH: 'true', MODEL_JSON_MODE: 'true', SQUAD_WEB_TOOLS_ENABLED: 'false' };
  const output = [];
  const loader = pathToFileURL(require.resolve('tsx')).href;
  child = spawn(process.execPath, ['--import', loader, join(root, 'scripts/web.ts')], { cwd: state, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => failures.push(error.message));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output.push(chunk.toString()); appendFileSync(join(evidence, 'server.log'), chunk);
  });
  await until(async () => {
    assert(child.exitCode === null && child.signalCode === null, `App exited: ${output.join('')}`);
    assert.equal(failures.length, 0, failures.join('\n'));
    return output.join('');
  }, text => text.includes(`Squad API: ${url}`), 'owned server ready');
  log('app-launched', { pid: child.pid, url, database });
  writeFileSync(join(evidence, 'instance.json'), JSON.stringify({ pid: child.pid, url, database, root, source: run.source }, null, 2));
  await doctor();
}
async function doctor() {
  assert(child && child.exitCode === null && child.signalCode === null, 'Owned child must be alive');
  const value = await inspectInstance({ pid: child.pid, url, database, root });
  run.doctor.push(value);
  log('doctor', value);
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root: document } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.nodeId, selector: '.message-text, .welcome h2' });
    if (nodeId) {
      const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      writeFileSync(join(evidence, `${name}.fonts.json`), JSON.stringify(fonts, null, 2));
    }
  } finally { await cdp.detach(); }
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
  writeFileSync(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
}
async function click(role, name, exact = true) {
  log('click', { role, name });
  await page.getByRole(role, { name, exact }).click();
}
async function newRoom(shortcut = false) {
  const before = (await get('/api/rooms')).rooms;
  if (shortcut) { log('keypress', { key: 'Control+n' }); await page.keyboard.press('Control+n'); }
  else await click('button', '新建群聊', false);
  const after = await until(() => get('/api/rooms'), v => v.rooms.length === before.length + 1, 'new room');
  const room = after.rooms.find(r => !before.some(old => old.id === r.id));
  await until(() => page.evaluate(() => localStorage.getItem('squad-room')), v => v === room.id, 'selected room');
  await page.getByRole('button', { name: '点名成员', exact: true }).waitFor({ state: 'visible' });
  await until(() => get(`/api/rooms/${room.id}`), v => v.modelConfigured && v.agents.length === 5, 'configured room ready');
  return room;
}
async function send(text, enter = false) {
  log('fill', { label: '群聊消息输入框', text });
  await page.getByRole('textbox', { name: '群聊消息输入框' }).fill(text);
  if (enter) { log('keypress', { key: 'Enter' }); await page.getByRole('textbox', { name: '群聊消息输入框' }).press('Enter'); }
  else await click('button', '发送消息');
}
async function done(room, owner) {
  const snapshot = await until(() => get(`/api/rooms/${room.id}`), v => v.tasks.at(-1)?.outcome === 'complete', 'task complete');
  if (owner) assert.equal(snapshot.tasks.at(-1).owner, owner);
  await page.getByRole('log', { name: '群聊消息' }).getByText('验证任务已完成，请查看报告。', { exact: true }).first().waitFor();
  writeFileSync(join(evidence, `${room.id}.snapshot.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}
async function rooms() {
  const first = await newRoom();
  await capture('rooms-before');
  await send('VERIFY_ROOMS 默认负责人验证');
  const a = await done(first, 'A');
  const second = await newRoom(true);
  // Exercise both completion entry points; do not set mentions through an API.
  await click('button', '点名成员');
  await click('option', 'Builder 2 @builder-2');
  assert.match(await page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), /@builder-2/);
  await page.getByRole('textbox', { name: '群聊消息输入框' }).fill('@builder-2');
  await page.getByRole('textbox', { name: '群聊消息输入框' }).press('Enter');
  await until(() => page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), v => v === '@builder-2 ', 'keyboard mention completion');
  await send('@builder-2 VERIFY_ROOMS 点名负责人验证', true);
  const b = await done(second, 'builder-2');
  assert.equal(b.tasks.length, 1);
  await page.getByRole('navigation', { name: '群聊列表' }).getByRole('button', { name: a.room.title, exact: true }).click();
  await until(() => page.evaluate(() => localStorage.getItem('squad-room')), id => id === first.id, 'switch room');
  await page.getByRole('log').getByText('VERIFY_ROOMS 默认负责人验证', { exact: true }).waitFor();
  await capture('rooms-switched');
  await stopApp();
  await page.getByText('连接中断', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
  await capture('rooms-offline');
  await launch();
  await page.reload();
  await page.getByRole('log').getByText('VERIFY_ROOMS 默认负责人验证', { exact: true }).waitFor();
  const restored = await get(`/api/rooms/${first.id}`);
  assert.deepEqual(restored.messages, a.messages);
  assert.deepEqual(restored.tasks, a.tasks);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT data FROM rooms WHERE id=?').get(first.id);
    assert(row && row.data.includes('VERIFY_ROOMS 默认负责人验证'));
    writeFileSync(join(evidence, 'rooms.sqlite-proof.json'), JSON.stringify({ roomIds: [first.id, second.id], stored: JSON.parse(row.data) }, null, 2));
  } finally { db.close(); }
  await capture('rooms-after-restart');
}
async function reports() {
  const room = await newRoom();
  await capture('reports-before');
  await send('VERIFY_REPAIR 生成可导出的报告');
  const snapshot = await done(room, 'A');
  const task = snapshot.tasks.at(-1);
  assert.equal(task.artifacts[0].content, report);
  assert.equal(task.artifacts[0].author, 'A');
  assert.equal(task.usage.checks, 2, 'Check regeneration must consume a second check request');
  const records = readFileSync(join(evidence, 'model-http.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(records.some(r => r.goal.includes('VERIFY_REPAIR') && r.kind === 'check' && r.repair));
  await page.getByRole('log').getByRole('button', { name: '查看 verification-report.md', exact: true }).click();
  const preview = page.getByRole('complementary', { name: '报告预览', exact: true });
  await preview.getByRole('heading', { name: '验证报告', exact: true }).waitFor();
  await capture('reports-preview');
  await click('button', '复制详情');
  await page.getByRole('status').getByText('已复制', { exact: true }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, report);
  writeFileSync(join(evidence, 'clipboard.txt'), clipboard);
  log('clipboard-readback', { matchesReport: true });
  const downloaded = page.waitForEvent('download');
  await click('button', '导出详情');
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'verification-report.md');
  await download.saveAs(join(evidence, 'verification-report.md'));
  assert.equal(readFileSync(join(evidence, 'verification-report.md'), 'utf8'), report);
  log('download-readback', { filename: download.suggestedFilename(), matchesReport: true });
  await click('button', '返回详情');
  await page.getByRole('complementary', { name: '结果详情' }).waitFor();
  await capture('reports-result-details');
  await click('button', '关闭详情');
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '查看方案师的执行过程' }).click();
  await page.getByRole('complementary', { name: '方案师的执行过程' }).waitFor();
  await click('tab', '产物', false);
  await page.getByRole('complementary', { name: '方案师的执行过程' }).getByRole('button', { name: '查看 verification-report.md' }).waitFor();
  await capture('reports-member-artifacts');
  await click('button', '关闭详情');
}
async function control() {
  const room = await newRoom();
  await send('VERIFY_STOP 停止后继续原任务');
  const before = await until(() => get(`/api/rooms/${room.id}`), s => s.works.some(w => w.status === 'inflight'), 'inflight work');
  await capture('control-inflight');
  await click('button', '停止');
  await until(() => get(`/api/rooms/${room.id}`), s => s.tasks[0]?.outcome === 'stopped', 'stopped outcome');
  await until(() => fixture.cancelled, n => n > 0, 'HTTP cancellation');
  const transport = readFileSync(join(evidence, 'model-http.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(transport.some(e => e.event === 'request-cancelled' && e.goal === before.tasks[0].goal
    && before.works.some(w => w.id === e.workId && w.status === 'inflight')), 'Retain transport cancellation for this inflight work');
  await capture('control-stopped');
  await click('button', '继续执行', false);
  const after = await done(room, 'A');
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].id, before.tasks[0].id);
  assert(after.events.some(e => e.kind === 'cancelled'));
  await capture('control-continued');
}
async function assistance() {
  for (const entry of ['button', 'text']) {
    const room = await newRoom();
    await send(`VERIFY_RETRY ${entry} 核查中断后交回负责人`);
    const before = await until(() => get(`/api/rooms/${room.id}`), s => s.tasks[0]?.phase === 'waitingHuman' && s.tasks[0].assists?.some(h => h.retryable), 'retryable assistance');
    await capture(`assistance-${entry}-interrupted`);
    if (entry === 'button') await page.getByRole('log').getByRole('button', { name: '重试 B 的这次协助', exact: true }).first().click();
    else await send('B 重试', true);
    const after = await done(room, 'A');
    assert.equal(after.tasks.length, 1);
    assert.equal(after.tasks[0].id, before.tasks[0].id);
    assert.equal(after.messages.filter(m => m.author === 'facilitator' && m.text.includes('核查结果已交给 A')).length, 1);
    assert.deepEqual(after.works.filter(w => w.kind === 'assistance').map(w => w.agentId), ['B', 'B']);
    await capture(`assistance-${entry}-returned`);
  }
  const room = await newRoom();
  await send('VERIFY_REVIEW 先生成报告');
  await done(room, 'A');
  await send('大家都提提意见');
  const reviewed = await until(() => get(`/api/rooms/${room.id}`), s => s.tasks.length === 2 && s.tasks.at(-1)?.outcome === 'complete', 'team review');
  assert.deepEqual(reviewed.tasks.at(-1).review.completed, ['B', 'builder-1', 'builder-2', 'builder-3']);
  assert.equal(reviewed.tasks.at(-1).review.status, 'complete');
  writeFileSync(join(evidence, 'assistance-review.snapshot.json'), JSON.stringify(reviewed, null, 2));
  await page.getByRole('log').getByText('builder-3 已核查完成', { exact: true }).waitFor();
  await capture('assistance-team-review');
}
async function layout() {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const room = await newRoom();
  await send('VERIFY_LAYOUT 字号与面板');
  await done(room, 'A');
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '查看方案师的执行过程' }).click();
  await page.getByRole('complementary', { name: '方案师的执行过程' }).waitFor();
  await capture('layout-before');
  for (const [name, offset] of [['调整导航宽度', 40], ['调整详情宽度', -40]]) {
    const handle = page.getByRole('separator', { name, exact: true });
    const before = Number(await handle.getAttribute('aria-valuenow'));
    const box = await handle.boundingBox();
    assert(box);
    log('drag', { name, offset });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + offset, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await until(() => handle.getAttribute('aria-valuenow'), n => Number(n) > before, 'resized panel');
    await handle.focus();
    await handle.press('Home');
    assert.equal(await handle.getAttribute('aria-valuenow'), await handle.getAttribute('aria-valuemin'));
  }
  await click('button', '收起导航');
  assert.equal(await page.getByRole('complementary', { name: '群聊和成员' }).isVisible(), false);
  await page.reload();
  await page.getByRole('button', { name: '展开导航', exact: true }).waitFor();
  await click('button', '展开导航');
  const font = await page.getByRole('log').locator('.message-text').first().evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(font, '14px');
  await capture('layout-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await click('button', '展开导航');
  await page.getByRole('complementary', { name: '群聊和成员' }).waitFor();
  await capture('layout-mobile');
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '收起导航', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
function cleanup() {
  cleanupPromise ??= performCleanup();
  return cleanupPromise;
}
async function performCleanup() {
  clearTimeout(timer);
  if (context) await context.tracing.stop({ path: join(evidence, 'trace.zip') }).catch(e => failures.push(`trace: ${e.message}`));
  if (browser) await browser.close().catch(e => failures.push(`browser cleanup: ${e.message}`));
  await stopApp();
  if (fixture) await fixture.close();
  rmSync(state, { recursive: true, force: true });
  run.cleanup = { stateRemoved: !existsSync(state), appStopped: !child, browserClosed: !browser?.isConnected(), evidenceRetained: existsSync(actions) };
}
async function interrupted(reason) {
  run.status = 'failed';
  run.error = reason;
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  try { await cleanup(); }
  finally {
    writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
    clearTimeout(forceExit);
    process.exit(1);
  }
}
process.once('SIGINT', () => { void interrupted('SIGINT'); });
process.once('SIGTERM', () => { void interrupted('SIGTERM'); });
log('run-start', { source: run.source, feature: selected });
try {
  assert(existsSync(join(root, 'dist/web/index.html')), 'Run npm run build first');
  symlinkSync(join(root, 'dist'), join(state, 'dist'), 'dir');
  fixture = await startFixture(join(evidence, 'model-http.jsonl'));
  await launch();
  const runtimeModule = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES && join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs');
  const modulePath = process.env.SQUAD_PLAYWRIGHT_MODULE || (runtimeModule && existsSync(runtimeModule) ? runtimeModule : undefined);
  const { chromium } = modulePath ? await import(pathToFileURL(resolve(modulePath)).href) : require('playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.SQUAD_CHROMIUM ? { executablePath: process.env.SQUAD_CHROMIUM } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  await context.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    if (host === '127.0.0.1') return route.continue();
    if (host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') {
      log('external-font-blocked', { host });
      return route.abort();
    }
    failures.push(`Unexpected browser network: ${host}`);
    return route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
  page.on('request', request => { if (request.method() === 'POST') log('browser-post', { path: new URL(request.url()).pathname, body: request.postData() }); });
  run.browser = browser.version();
  run.url = url;
  timer = setTimeout(() => { void interrupted('Global verification deadline (180s)'); }, 180_000);
  await page.goto(url);
  await page.getByText('已连接', { exact: true }).waitFor();
  for (const name of selected === 'all' ? allowed : [selected]) {
    await doctor();
    log('feature-start', { feature: name });
    await ({ rooms, reports, control, assistance, layout })[name]();
    assert.equal(failures.length, 0, failures.join('\n'));
    run.completed.push(name);
    log('feature-pass', { feature: name });
  }
  run.status = 'verified';
} catch (error) {
  run.status = 'failed';
  run.error = error.stack;
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
  if (child && child.exitCode === null) await doctor().catch(e => { run.doctorAfterFailure = e.message; });
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) { failures.push(`cleanup: ${error.message}`); process.exitCode = 1; }
  run.failures = failures;
  if (failures.length) run.status = 'failed';
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
  assert(existsSync(join(evidence, 'run.json')) && existsSync(actions), 'Evidence must survive cleanup');
  console.log(JSON.stringify(run, null, 2));
}
