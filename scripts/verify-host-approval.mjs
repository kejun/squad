import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as portServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Isolated production entry, real model HTTP boundary, browser clicks, SQLite and actual host CLI.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(root, 'package.json'));
const evidence = resolve(process.argv[2] ?? join(root, 'reports/host-approval', new Date().toISOString().replaceAll(':', '-')));
await mkdir(evidence, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'squad-host-browser-'));
const serviceDir = join(state, 'service'), workspace = join(state, 'project'), database = join(state, 'team.sqlite');
await mkdir(serviceDir); await mkdir(workspace); await symlink(join(root, 'dist'), join(serviceDir, 'dist'));
const result = { status: 'running', source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), checks: [], cleanup: {} };
const requests = [], errors = [], posts = [];
const manualRetry = process.env.SQUAD_VERIFY_HOST_RETRY === '1';
const sessionMode = process.env.SQUAD_VERIFY_HOST_SESSION === '1';
assert(!(manualRetry && sessionMode), 'Run retry and session verification separately');
let releaseSessionResponse, sessionPause = true, sessionGateSeen = false;
const privateAuth = join(state, 'private', 'auth.txt'); await mkdir(dirname(privateAuth)); await writeFile(privateAuth, 'synthetic-host-login');
const executable = process.execPath;
const action = { type: 'runCli', executable, args: ['-e', `require("node:fs").readFileSync(${JSON.stringify(privateAuth)}); require("node:fs").appendFileSync("runs.txt", "once\\n"); console.log("host-proof", process.env.HOME)`], execution: manualRetry ? 'sandbox' : 'host', reason: '复用本机账号与已有授权，验证按次批准' };
const fixture = createServer((req, res) => { void (async () => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); requests.push(body);
  const system = body.messages[0]?.content ?? '';
  const receipts = body.messages.filter(m => m.role === 'user' && m.content.startsWith('{"type":"local_tool_result",'));
  if (sessionMode && receipts.length === 1 && sessionPause && !system.includes('executing check work')) {
    sessionGateSeen = true;
    await new Promise(resolve => { releaseSessionResponse = resolve; });
  }
  const output = system.includes('executing check work') ? { type: 'check', passed: true, gaps: [] }
    : (sessionMode ? receipts.length >= 2 : receipts.length > 0)
      ? { type: 'answer', text: '命令回执已收到', artifacts: [{ name: 'receipt.md', content: body.messages.at(-1).content }] } : sessionMode && receipts.length === 1
        ? { ...action, args: [...action.args.slice(0, -1), action.args.at(-1) + '; console.log("session-command-2")'] } : action;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
})().catch(error => { errors.push(String(error)); res.writeHead(500); res.end(); }); });
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const socket = portServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); const url = `http://127.0.0.1:${port}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'production', WEB_PORT: String(port), WEB_DATABASE: database,
  MODEL_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`, MODEL_NAME: 'host-approval-browser-fixture', MODEL_NO_AUTH: 'true',
  SQUAD_INTENT_ANALYSIS_ENABLED: 'false', SQUAD_WEB_TOOLS_ENABLED: 'false', SQUAD_LOCAL_SKILLS_ROOTS: join(state, 'empty-skills'),
  SQUAD_LOCAL_DATA_DIR: join(state, 'runtime'), SQUAD_WORKSPACE_ROOT: workspace };
let child, browser, context, page, roomId, timer;
const until = async (read, accept, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out: ' + label);
};
const room = async () => (await page.request.get(url + '/api/rooms/' + roomId)).json();
const runs = async () => readFile(join(workspace, 'runs.txt'), 'utf8').catch(() => '');
async function start() {
  let output = '';
  child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, join(root, 'scripts/web.ts')], { cwd: serviceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => errors.push(String(error)));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += String(chunk); });
  await until(() => { assert.equal(child.exitCode, null, output); return output; }, text => text.includes(`Squad API: ${url}`), 'owned production server ready');
  await writeFile(join(evidence, 'server.log'), output);
}
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await ended; } finally { clearTimeout(force); }
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
  await writeFile(join(evidence, name + '.aria.txt'), await page.locator('body').ariaSnapshot());
}
async function requestCommand() {
  await page.getByRole('textbox', { name: '群聊消息输入框' }).fill('执行本次宿主验证命令');
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/messages'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const reply = await (await sent).json();
  if (manualRetry) {
    await until(room, snapshot => snapshot.tasks.find(task => task.id === reply.taskId)?.outcome === 'complete', 'model finishes without requesting host');
    assert.equal((await room()).hostApprovals.length, 0);
    await page.getByRole('button', { name: '请求在宿主执行', exact: true }).click();
  }
  await page.getByRole('dialog').waitFor();
  assert((await page.getByLabel('请求执行的完整命令').textContent()).includes(executable));
}
try {
  await start();
  const modulePath = process.env.SQUAD_PLAYWRIGHT_MODULE ?? join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ?? '', 'playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
  browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    ...(process.env.SQUAD_CHROMIUM ? { executablePath: process.env.SQUAD_CHROMIUM } : {}) });
  result.browser = browser.version(); context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(String(error)));
  page.on('request', req => { if (req.method() === 'POST') posts.push({ url: req.url(), body: req.postDataJSON() }); });
  timer = setTimeout(() => { errors.push('Browser verification deadline exceeded'); void browser?.close(); child?.kill('SIGTERM'); }, 120000);
  await page.goto(url); await page.getByRole('button', { name: /新建群聊/ }).click();
  roomId = (await (await page.request.get(url + '/api/rooms')).json()).rooms[0].id;
  await requestCommand(); await capture('01-pending');
  const cdp = await context.newCDPSession(page); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const dom = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '.host-approval-heading h2' });
  const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }); await writeFile(join(evidence, 'fonts.json'), JSON.stringify(fonts, null, 2));
  assert(fonts.fonts.some(font => /Noto Sans CJK/.test(font.familyName) && font.glyphCount > 0), 'Chinese platform font must actually render');
  if (sessionMode) {
    const decisions = () => posts.filter(post => post.url.endsWith('/host-approval'));
    const pauseAtFirstResult = async () => {
      await until(() => sessionGateSeen, Boolean, 'first host result reaches controlled model boundary');
      await until(room, snapshot => snapshot.hostSessions?.length === 1, 'session grant is visible');
      await page.getByRole('button', { name: '撤销会话授权', exact: true }).waitFor();
    };
    const releaseNextCommand = () => { sessionPause = false; releaseSessionResponse?.(); releaseSessionResponse = undefined; };
    const resetGate = () => { sessionPause = true; sessionGateSeen = false; };
    const completeRound = async expected => {
      const snapshot = await until(room, snapshot => snapshot.tasks.at(-1)?.outcome === 'complete', 'two host commands and final owner receipt');
      assert.equal(await runs(), expected); assert.equal(snapshot.hostSessions.length, 0); return snapshot;
    };
    assert.equal(await runs(), '');
    await page.getByRole('button', { name: '允许本次会话', exact: true }).click();
    await pauseAtFirstResult(); assert.equal(await runs(), 'once\n');
    await page.reload(); await page.getByRole('button', { name: '撤销会话授权', exact: true }).waitFor();
    assert.equal((await room()).hostApprovals.length, 0); await capture('02-session-refreshed');
    releaseNextCommand(); await completeRound('once\nonce\n');
    assert.equal(decisions().length, 1); assert.equal(decisions()[0].body.decision, 'approveSession');
    assert.equal(await page.getByRole('dialog').count(), 0);
    result.checks.push('one session approval, two distinct commands each once, no second popup or decision, page refresh preserves grant, completion clears grant');

    resetGate(); await requestCommand(); assert.equal((await room()).hostSessions.length, 0);
    await page.getByRole('button', { name: '允许本次会话', exact: true }).click(); await pauseAtFirstResult();
    await page.getByRole('button', { name: '撤销会话授权', exact: true }).click();
    await until(room, snapshot => snapshot.hostSessions.length === 0, 'UI revokes current session');
    releaseNextCommand(); await page.getByRole('dialog').waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await capture('03-mobile-after-revoke');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    await completeRound('once\nonce\nonce\nonce\n');
    result.checks.push('new task requires fresh approval; UI revocation restores per-command popup; allow-once remains available on mobile');

    resetGate(); await requestCommand();
    await page.getByRole('button', { name: '允许本次会话', exact: true }).click(); await pauseAtFirstResult();
    // Crash the owned service only after the real host receipt is durable and no command is running.
    // Graceful shutdown intentionally stops active model work; a crash exercises RECOVER instead.
    const crashed = once(child, 'exit'); child.kill('SIGKILL'); await crashed;
    releaseNextCommand(); await start(); await page.reload();
    await page.getByRole('dialog').waitFor(); assert.equal((await room()).hostSessions.length, 0);
    await capture('04-session-restart-requires-approval');
    await page.getByRole('button', { name: '允许本次', exact: true }).click();
    const snapshot = await completeRound('once\nonce\nonce\nonce\nonce\nonce\n');
    await writeFile(join(evidence, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    const db = new DatabaseSync(database, { readOnly: true });
    try { const stored = String(db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId).data); assert(stored.includes('sessionGrantId') && stored.includes('host-proof')); await writeFile(join(evidence, 'sqlite-proof.json'), stored); } finally { db.close(); }
    assert.equal(errors.length, 0, errors.join('\n'));
    result.checks.push('owned service crash/recovery revokes session; same task second command requires fresh direct approval; real HTTP, host processes and SQLite proof');
    result.status = 'verified';
  } else {
  assert.equal(await runs(), ''); const count = requests.length;
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(posts.filter(post => post.url.endsWith('/host-approval')).length, 0);
  await page.locator('.host-approval-card').click(); await page.getByRole('dialog').waitFor();
  await page.reload(); await page.getByRole('dialog').waitFor(); assert.equal(requests.length, count);
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await until(room, snapshot => snapshot.tasks.at(-1)?.outcome === 'complete', 'denied result returned to original owner'); assert.equal(await runs(), '');
  result.checks.push('popup, exact command, close without deciding, refresh, idle model budget, denial');
  if (manualRetry) result.checks.push('failed sandbox record remains usable after the model finishes; button requests approval without new model selection');
  await requestCommand(); await page.getByRole('button', { name: '允许本次', exact: true }).click();
  await until(room, snapshot => snapshot.tasks.at(-1)?.outcome === 'complete', 'approved host command completed'); assert.equal(await runs(), 'once\n');
  result.checks.push('user click through production HTTP, one host execution, true HOME and durable result');
  await requestCommand(); const before = (await room()).hostApprovals[0]; const beforeRestartCount = requests.length;
  await capture('02-before-restart'); await stopChild(); await start(); await page.reload(); await page.getByRole('dialog').waitFor();
  const after = (await room()).hostApprovals[0]; assert.notEqual(after.approvalId, before.approvalId); assert.equal(requests.length, beforeRestartCount);
  await page.setViewportSize({ width: 390, height: 844 }); await capture('03-mobile-restored');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '允许本次', exact: true }).click();
  const snapshot = await until(room, snapshot => snapshot.tasks.at(-1)?.outcome === 'complete', 'fresh post-restart approval'); assert.equal(await runs(), 'once\nonce\n');
  await writeFile(join(evidence, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  const db = new DatabaseSync(database, { readOnly: true });
  try { const stored = String(db.prepare('SELECT data FROM rooms WHERE id=?').get(roomId).data); assert(stored.includes('HOST_APPROVAL_DENIED') && stored.includes('host-proof')); await writeFile(join(evidence, 'sqlite-proof.json'), stored); } finally { db.close(); }
  assert.equal(errors.length, 0, errors.join('\n')); result.checks.push('graceful restart, fresh approval identity, mobile dialog, SQLite proof'); result.status = 'verified';
  }
} catch (error) {
  result.status = 'failed'; result.error = String(error); if (page && !page.isClosed()) await capture('failure').catch(() => {});
  if (page && roomId) await writeFile(join(evidence, 'failure.snapshot.json'), JSON.stringify(await room().catch(() => null), null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer); releaseSessionResponse?.();
  await context?.tracing.stop({ path: join(evidence, 'trace.zip') }).catch(() => {});
  await browser?.close(); result.cleanup.browser = true;
  await stopChild(); result.cleanup.application = true;
  await new Promise(resolve => fixture.close(resolve)); result.cleanup.fixture = true;
  await rm(state, { recursive: true, force: true }); result.cleanup.state = true;
  await writeFile(join(evidence, 'posts.json'), JSON.stringify(posts, null, 2));
  await writeFile(join(evidence, 'model-http.json'), JSON.stringify(requests, null, 2));
  await writeFile(join(evidence, 'run.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, evidence }, null, 2));
}
