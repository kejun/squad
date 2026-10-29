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
import { startFixture } from '../.agents/skills/verify-squad/scripts/model-fixture.mjs';
import { inspectInstance } from '../.agents/skills/verify-squad/scripts/doctor.mjs';

// Real production entry, HTTP, SQLite and React. Only the model-provider HTTP
// boundary uses the existing synthetic fixture; browser API calls are never faked.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const evidence = resolve(process.argv[2] ?? join(root, 'reports/state-debug', new Date().toISOString().replaceAll(':', '-')));
assert(!existsSync(evidence), 'Choose a new evidence directory'); mkdirSync(evidence, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'squad-state-debug-'));
const database = join(state, 'team.sqlite');
const run = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), status: 'running', checks: [], cleanup: {} };
const log = (action, detail = {}) => appendFileSync(join(evidence, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n');
const until = async (read, accept, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error('Timed out: ' + label);
};
let child, fixture, browser, context, page, timer;
const errors = [], posts = [];
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
  writeFileSync(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
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
  fixture = await startFixture(join(evidence, 'model-http.jsonl'));
  symlinkSync(join(root, 'dist'), join(state, 'dist'), 'dir');
  let output = '';
  child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'scripts/web.ts')], {
    cwd: state, env: { PATH: process.env.PATH, NODE_ENV: 'production', WEB_PORT: String(port), WEB_DATABASE: database,
      MODEL_BASE_URL: fixture.url, MODEL_NAME: 'squad-verification-fixture', MODEL_NO_AUTH: 'true', MODEL_JSON_MODE: 'true',
      SQUAD_WEB_TOOLS_ENABLED: 'false', SQUAD_DEBUG: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => errors.push(error.message));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(join(evidence, 'server.log'), chunk); });
  timer = setTimeout(() => { errors.push('Browser verification deadline exceeded'); void browser?.close(); child?.kill('SIGTERM'); }, 180000);
  await until(() => { assert.equal(child.exitCode, null, output); return output; }, text => text.includes(`Squad API: ${url}`), 'owned application ready');
  const instance = { pid: child.pid, url, database, root };
  writeFileSync(join(evidence, 'instance.json'), JSON.stringify(instance, null, 2));
  run.doctor = await inspectInstance(instance);
  const modulePath = process.env.SQUAD_PLAYWRIGHT_MODULE ?? (process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES && join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs'));
  const { chromium } = modulePath ? await import(pathToFileURL(modulePath).href) : require('playwright');
  browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--disable-gpu', '--disable-dev-shm-usage'],
    ...(process.env.SQUAD_CHROMIUM ? { executablePath: process.env.SQUAD_CHROMIUM } : {}) });
  run.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    // Offline font fallback is measured below; no external application/data session.
    return route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') { posts.push(request.url()); log('browser-post', { url: request.url(), body: request.postData() }); } });
  await page.goto(url);
  await page.getByRole('button', { name: '新建群聊', exact: false }).first().click();
  await page.getByRole('textbox', { name: '群聊消息输入框' }).fill('VERIFY_ROOMS 状态机调试验收');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const get = async path => { const response = await fetch(url + path, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200); return response.json(); };
  const roomId = await until(() => page.evaluate(() => localStorage.getItem('squad-room')), Boolean, 'room selection');
  await until(() => get('/api/rooms/' + roomId), value => value.tasks.length && value.tasks.at(-1).phase === 'ended', 'model work committed');
  const feed = await get('/api/debug/rooms/' + roomId);
  const firstRunning = feed.records.findIndex(record => record.phase === 'running' && record.snapshot.context.intents.some(i => i.kind === 'owner' && i.status === 'pending'));
  assert(firstRunning >= 0, 'Need a genuine running snapshot before owner claim');
  const readRoom = () => { const db = new DatabaseSync(database, { readOnly: true }); try { return db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId).data; } finally { db.close(); } };
  const committed = readRoom(); const beforePosts = posts.length;
  await page.getByRole('button', { name: '打开状态机调试', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '状态机调试', exact: true });
  await dialog.getByRole('region', { name: '本次运行轨迹' }).waitFor();
  await capture('live-run');
  await dialog.getByRole('button', { name: '查看步骤 ' + firstRunning, exact: true }).click();
  await dialog.getByText('正在查看历史步骤', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: '从此步新建沙箱', exact: true }).click();
  const sourceSandbox = await dialog.getByLabel('选择沙箱').inputValue();
  await dialog.getByLabel('事件类型', { exact: true }).selectOption('HELP');
  await dialog.getByLabel('参数 target', { exact: true }).fill('A');
  await dialog.getByRole('button', { name: '预演', exact: true }).click();
  await dialog.getByRole('region', { name: '预演步骤详情', exact: true }).getByText('SELF_DEPENDENCY', { exact: false }).waitFor();
  assert.equal(await dialog.locator('[data-testid="debug-phase"]').textContent(), 'running');
  assert.equal(await dialog.locator('.debug-history li').count(), 1);
  run.checks.push('self dependency explained without advancing');
  await dialog.getByLabel('参数 target', { exact: true }).fill('B');
  await dialog.getByRole('button', { name: '单步执行', exact: true }).click();
  await until(() => dialog.locator('[data-testid="debug-phase"]').textContent(), value => value === 'waitingAssistance', 'sandbox HELP');
  assert.equal(await dialog.locator('.debug-history li').count(), 2);
  await dialog.getByRole('button', { name: '查看步骤 0', exact: true }).click();
  assert.equal(await dialog.getByLabel('参数 target').inputValue(), 'B');
  await dialog.getByRole('button', { name: '从此步新建沙箱', exact: true }).click();
  await dialog.getByLabel('事件类型', { exact: true }).selectOption('WAIT_USER');
  await dialog.getByRole('button', { name: '单步执行', exact: true }).click();
  assert.equal(await dialog.locator('[data-testid="debug-phase"]').textContent(), 'waitingHuman');
  assert.match(await dialog.textContent(), /复制基线/);
  await dialog.getByLabel('选择沙箱').selectOption(sourceSandbox);
  assert.equal(await dialog.locator('[data-testid="debug-phase"]').textContent(), 'waitingAssistance');
  assert.equal(await dialog.locator('.debug-history li').count(), 2);
  run.checks.push('history fork preserves source and draft');
  await dialog.getByRole('button', { name: '返回最新', exact: true }).click();
  await dialog.getByLabel('事件类型', { exact: true }).selectOption('STOP');
  await dialog.getByRole('button', { name: '单步执行', exact: true }).click();
  assert.equal(await dialog.locator('[data-testid="debug-phase"]').textContent(), 'ended');
  await dialog.getByRole('region', { name: '步骤详情', exact: true }).getByText('stopping → ended', { exact: true }).waitFor();
  run.checks.push('STOP automatic microstep visible');
  await capture('sandbox-run');
  await dialog.getByRole('button', { name: '完整状态图', exact: true }).click();
  const points = () => dialog.locator('[aria-label^="查看状态 "]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-label'), node.getAttribute('transform')]));
  const before = await points(); assert.equal(before.length, 8);
  await dialog.getByLabel('事件类型', { exact: true }).selectOption('CONTINUE');
  await dialog.getByRole('button', { name: '单步执行', exact: true }).click();
  assert.deepEqual(await points(), before);
  await dialog.getByLabel('状态图缩放', { exact: true }).focus();
  await dialog.getByLabel('状态图缩放', { exact: true }).press('Home');
  const smallText = await dialog.locator('svg text').evaluateAll(nodes => nodes.filter(node => {
    const style = getComputedStyle(node); return style.visibility !== 'hidden' && parseFloat(style.fontSize) * (node.getScreenCTM()?.a ?? 1) < 13.9;
  }).map(node => node.textContent));
  assert.deepEqual(smallText, []);
  await capture('complete-graph');
  run.checks.push('all states stay fixed and zoom labels remain at least 14px');
  const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const document = await cdp.send('DOM.getDocument');
  const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.debug-header h2' });
  const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
  writeFileSync(join(evidence, 'chinese-fonts.json'), JSON.stringify(fonts, null, 2));
  assert(fonts.fonts.some(font => font.glyphCount > 0 && /Noto.*CJK|Noto.*SC|WenQuanYi|PingFang/i.test(font.familyName)), 'Chinese glyphs need an actual CJK font');
  await cdp.detach();
  await dialog.getByRole('button', { name: '当前运行', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); await capture('mobile-run');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false);
  assert.equal(readRoom(), committed); assert.equal(posts.length, beforePosts);
  run.checks.push('sandbox makes no business writes and SQLite stays unchanged');
  run.doctorAfter = await inspectInstance(instance);
  assert.deepEqual(errors, []); run.status = 'verified';
} catch (error) {
  run.status = 'failed'; run.error = error.stack; process.exitCode = 1;
  if (page && !page.isClosed()) await capture('failure').catch(() => {});
} finally {
  try { await stop(); } catch (error) { run.cleanup.error = error.message; process.exitCode = 1; run.status = 'failed'; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
  console.log(JSON.stringify({ status: run.status, source: run.source, evidence, checks: run.checks, cleanup: run.cleanup }, null, 2));
}
