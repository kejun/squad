#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startFixture, report, revisedReport } from './model-fixture.mjs';
import { inspectInstance } from './doctor.mjs';
import { verifyBuild } from './build-proof.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const allowed = ['rooms', 'reports', 'control', 'assistance', 'layout'];
const browserContracts = ['BT_U01', 'BT_U02', 'BT_U03', 'BT_U09'];
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
for (let i = 0; i < args.length; i += 2) assert(['--feature', '--evidence', '--bdd'].includes(args[i]), `Unknown option: ${args[i]}`);
const contract = option('--bdd', undefined);
if (contract) assert(process.send && browserContracts.includes(contract), 'Browser contracts require Cucumber IPC and a known original scenario');
const selected = contract || option('--feature', 'rooms');
assert([...allowed, ...browserContracts, 'all'].includes(selected), `Unknown feature: ${selected}`);
const evidence = resolve(option('--evidence', join(root, 'reports/verify-squad', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid)));
assert(!existsSync(evidence), 'Use a new evidence directory; existing proof is never overwritten');
mkdirSync(evidence, { recursive: true });
const state = mkdtempSync(join(tmpdir(), 'squad-verify-'));
const workspace = mkdtempSync(join(tmpdir(), 'squad-verify-workspace-'));
const database = join(state, 'team.sqlite');
const actions = join(evidence, 'actions.jsonl');
const require = createRequire(join(root, 'package.json'));
const run = { status: 'running', feature: selected, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, evidence, state, database, completed: [], doctor: [], cleanup: {} };
let fixture, child, appProcess, appReaped, browser, context, page, port, url, timer, cleanupPromise;
const failures = [];
const observed = {};
const posted = [];
const ownedProcessGroups = new Set();
run.appProcesses = [];
run.appRuntime = { typescript: 'node --experimental-transform-types', loader: 'tests/fixtures/typescript-loader.mjs', supervisor: '.agents/skills/verify-squad/scripts/app-supervisor.py' };
run.steps = [];
run.verificationInputs = ['verify.mjs', 'model-fixture.mjs', 'doctor.mjs', 'build-proof.mjs'].map(file => ({ file, sha256: createHash('sha256').update(readFileSync(join(root, '.agents/skills/verify-squad/scripts', file))).digest('hex') }));

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
function processGroupGone(pid) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
function signalOwnedGroup(pid, signal) {
  assert(ownedProcessGroups.has(pid), 'Only a process group created by this run may receive a signal');
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stopApp(signal = 'SIGTERM') {
  if (!child) return;
  const owned = child;
  if (!appProcess) {
    // A startup failure can precede the app-PID message. The owned supervisor
    // handles TERM, stops its own app group and reaps before it closes.
    const closed = owned.exitCode === null && owned.signalCode === null
      ? new Promise(resolve => owned.once('close', resolve)) : Promise.resolve();
    if (Number.isInteger(owned.pid) && ownedProcessGroups.has(owned.pid)) signalOwnedGroup(owned.pid, 'SIGTERM');
    const deadline = setTimeout(() => { if (ownedProcessGroups.has(owned.pid)) signalOwnedGroup(owned.pid, 'SIGKILL'); }, 8000);
    try { await closed; } finally { clearTimeout(deadline); }
    if (appProcess) return stopApp('SIGTERM');
    assert(!owned.pid || processGroupGone(owned.pid), 'Failed startup supervisor must be gone');
    child = undefined;
    return;
  }
  const app = appProcess;
  assert(app && ownedProcessGroups.has(app.appPid), 'The real Node app must belong to an owned detached process group');
  const ended = owned.exitCode === null && owned.signalCode === null ? once(owned, 'close') : Promise.resolve();
  if (!processGroupGone(app.appPid)) signalOwnedGroup(app.appPid, signal);
  const killTimer = setTimeout(() => signalOwnedGroup(app.appPid, 'SIGKILL'), 5000);
  try {
    await ended;
    assert.equal(owned.exitCode, 0, 'The retained supervisor must finish reaping normally');
    assert.equal(owned.signalCode, null, 'The retained supervisor must survive app termination');
    assert.equal(appReaped?.appPid, app.appPid);
    assert.equal(appReaped?.reapedAll, true, 'All owned app descendants must be reaped');
    if (signal === 'SIGKILL') assert.equal(appReaped.appExit.signal, 'SIGKILL', 'Offline acceptance must lose the actual Node app by SIGKILL');
    await until(async () => processGroupGone(app.appPid) && processGroupGone(owned.pid), gone => gone, `owned app process group ${app.appPid} is gone`, 5000);
  } finally { clearTimeout(killTimer); }
  const proof = { pid: app.appPid, processGroup: app.appPid, ...appReaped.appExit,
    supervisorPid: owned.pid, supervisorProcessGroup: owned.pid, supervisorExitCode: owned.exitCode, supervisorSignal: owned.signalCode,
    reapedPids: appReaped.reapedPids, reapedAll: true, processGroupGone: true };
  run.appProcesses.push(proof);
  log('app-stopped', proof);
  child = undefined;
  appProcess = undefined;
  appReaped = undefined;
}

async function launch() {
  port ??= await freePort();
  url = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH, HOME: state, TMPDIR: state, NODE_ENV: 'production',
    WEB_PORT: String(port), WEB_DATABASE: database, MODEL_BASE_URL: fixture.url,
    MODEL_NAME: 'squad-verification-fixture', MODEL_NO_AUTH: 'true', MODEL_JSON_MODE: 'true', SQUAD_WEB_TOOLS_ENABLED: 'false', SQUAD_LOCAL_SKILLS_ROOTS: join(state, 'skills'), SQUAD_WORKSPACE_ROOT: workspace };
  const output = [];
  const loader = pathToFileURL(join(root, run.appRuntime.loader)).href;
  run.appRuntime.loaderSha256 = createHash('sha256').update(readFileSync(join(root, run.appRuntime.loader))).digest('hex');
  run.appRuntime.supervisorSha256 = createHash('sha256').update(readFileSync(join(root, run.appRuntime.supervisor))).digest('hex');
  appProcess = undefined;
  appReaped = undefined;
  child = spawn('python3', ['-u', join(root, run.appRuntime.supervisor), String(process.pid), process.execPath,
    '--experimental-transform-types', '--loader', loader, join(root, 'scripts/web.ts')],
    { cwd: state, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => failures.push(error.message));
  assert(Number.isInteger(child.pid), 'Owned app supervisor must have a process-group leader PID');
  ownedProcessGroups.add(child.pid);
  let control = '';
  child.stdout.on('data', chunk => {
    control += chunk.toString();
    let end;
    while ((end = control.indexOf('\n')) >= 0) {
      const line = control.slice(0, end); control = control.slice(end + 1);
      if (!line.startsWith('SQUAD_BROWSER_APP ')) continue;
      const value = JSON.parse(line.slice('SQUAD_BROWSER_APP '.length));
      assert.equal(value.supervisorPid, child.pid);
      assert.equal(value.supervisorProcessGroup, child.pid, 'Supervisor must own a detached group');
      assert.equal(value.processGroup, value.appPid, 'The actual Node app must own its group');
      if (value.phase === 'spawned') { appProcess = value; ownedProcessGroups.add(value.appPid); }
      if (value.phase === 'reaped') appReaped = value;
    }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    output.push(chunk.toString()); appendFileSync(join(evidence, 'server.log'), chunk);
  });
  await until(async () => {
    assert(child.exitCode === null && child.signalCode === null, `App exited: ${output.join('')}`);
    assert.equal(failures.length, 0, failures.join('\n'));
    return output.join('');
  }, text => appProcess && text.includes(`Squad API: ${url}`), 'owned Node app server ready');
  log('app-launched', { pid: appProcess.appPid, processGroup: appProcess.processGroup, supervisorPid: child.pid, url, database, runtime: run.appRuntime });
  writeFileSync(join(evidence, 'instance.json'), JSON.stringify({ pid: appProcess.appPid, processGroup: appProcess.processGroup, supervisorPid: child.pid, url, database, root, source: run.source }, null, 2));
  await doctor();
}
async function doctor() {
  assert(child && child.exitCode === null && child.signalCode === null, 'Owned child must be alive');
  const value = await inspectInstance({ pid: appProcess.appPid, url, database, root });
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
      const samples = [], startedAt = Date.now();
      let fonts;
      do {
        fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        samples.push({ elapsedMs: Date.now() - startedAt, ...fonts });
        if (fonts.fonts.some(font => font.glyphCount > 0 && /Noto Sans CJK|WenQuanYi|Microsoft YaHei|PingFang|Source Han|Droid Sans Fallback/i.test(font.familyName))) break;
        await new Promise(ready => setTimeout(ready, 25));
      } while (Date.now() - startedAt < 3000);
      writeFileSync(join(evidence, `${name}.fonts-observations.json`), JSON.stringify(samples, null, 2));
      writeFileSync(join(evidence, `${name}.fonts.json`), JSON.stringify(fonts, null, 2));
      assert(fonts.fonts.some(font => font.glyphCount > 0 && /Noto Sans CJK|WenQuanYi|Microsoft YaHei|PingFang|Source Han|Droid Sans Fallback/i.test(font.familyName)), 'Capture must use actual Chinese font glyphs');
    }
  } finally {
    await cdp.detach();
    await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
    writeFileSync(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
  }
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
async function continueOriginalWindow() {
  const before = posted.length;
  await click('button', '继续执行', false);
  await page.getByRole('dialog', { name: '继续处理当前任务', exact: true })
    .getByRole('button', { name: '沿用原窗口继续', exact: true }).click();
  const request = posted.slice(before).find(post => post.path.endsWith('/messages'));
  assert(request, 'Explicit continuation submits the actual message request');
  const payload = JSON.parse(request.body);
  assert.equal(payload.intent, 'continue');
  assert(!Object.hasOwn(payload, 'newWindowMs'), 'Continuing in the original window must not renew it');
  assert(!Object.hasOwn(payload, 'extraOrdinary'), 'Continuing in the original window must not add execution budget');
}
async function closeRequiredPrompt(room, question) {
  const before = await until(() => get(`/api/rooms/${room.id}`), snapshot => snapshot.blockers?.some(gate =>
    gate.status === 'open' && gate.requiredHuman && gate.question === question), 'required human gate: ' + question);
  const gate = before.blockers.find(gate => gate.status === 'open' && gate.requiredHuman && gate.question === question);
  const dialog = page.getByRole('dialog', { name: '需要你的回复', exact: true });
  await dialog.getByText(question, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '暂时关闭处理提示', exact: true }).click();
  const after = await get(`/api/rooms/${room.id}`);
  assert(after.blockers.some(current => current.id === gate.id && current.version === gate.version && current.status === 'open'),
    'Closing the prompt keeps this exact human decision unanswered');
  assert.equal(after.works.filter(work => work.kind === 'owner').length, before.works.filter(work => work.kind === 'owner').length,
    'Closing a prompt cannot resume owner execution');
  log('required-prompt-closed-without-decision', { roomId: room.id, gateId: gate.id, version: gate.version, question });
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
  await archiveRooms(first, a);
}
async function archiveRooms(first, before) {
  const input = page.getByRole('textbox', { name: '群聊消息输入框' });
  await input.fill('归档前的未发送草稿');
  await page.getByRole('navigation', { name: '群聊列表', exact: true }).getByRole('button', { name: before.room.title, exact: true }).hover();
  await click('button', '归档群聊 ' + before.room.title);
  await until(() => get('/api/rooms'), value => value.rooms.find(room => room.id === first.id)?.archived, 'archive committed');
  assert.equal(await page.getByRole('navigation', { name: '群聊列表', exact: true }).getByRole('button', { name: before.room.title, exact: true }).count(), 0);
  await click('button', '已归档 1');
  await page.getByRole('navigation', { name: '归档群聊列表', exact: true }).getByRole('button', { name: before.room.title, exact: true }).click();
  await page.getByRole('log').getByText('VERIFY_ROOMS 默认负责人验证', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '归档前的未发送草稿');
  const archived = await get(`/api/rooms/${first.id}`);
  assert.deepEqual(archived.messages, before.messages); assert.deepEqual(archived.tasks, before.tasks);
  assert(archived.tasks[0].artifacts.length > 0);
  await capture('rooms-archived');
  await stopApp(); await launch(); await page.reload();
  await page.getByRole('navigation', { name: '归档群聊列表', exact: true }).waitFor();
  await page.getByRole('log').getByText('VERIFY_ROOMS 默认负责人验证', { exact: true }).waitFor();
  assert.equal((await get(`/api/rooms/${first.id}`)).room.archived, true);
  await page.setViewportSize({ width: 390, height: 844 });
  await click('button', '展开导航');
  await capture('rooms-archived-mobile');
  await click('button', '恢复群聊 ' + before.room.title);
  await until(() => get(`/api/rooms/${first.id}`), value => !value.room.archived, 'room restored');
  await page.getByRole('navigation', { name: '群聊列表', exact: true }).waitFor();
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '收起导航', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture('rooms-restored');

  const working = await newRoom();
  await send('VERIFY_ARCHIVE 归档时继续执行');
  const inflight = await until(() => get(`/api/rooms/${working.id}`), value => value.works.some(work => work.kind === 'owner' && work.status === 'inflight'), 'owner inflight before archive');
  await until(() => readFileSync(join(evidence, 'model-http.jsonl'), 'utf8'), value => value.includes('archive-request-held'), 'held model HTTP request');
  const beforeArchive = await get(`/api/rooms/${working.id}`);
  await page.getByRole('navigation', { name: '群聊列表', exact: true }).getByRole('button', { name: inflight.room.title, exact: true }).hover();
  await click('button', '归档群聊 ' + inflight.room.title);
  const held = await until(() => get(`/api/rooms/${working.id}`), value => value.room.archived, 'inflight room archived');
  assert.deepEqual(held.tasks, beforeArchive.tasks);
  await click('button', '已归档 1');
  await page.getByRole('navigation', { name: '归档群聊列表', exact: true }).getByRole('button', { name: inflight.room.title, exact: true }).click();
  await capture('rooms-archive-inflight');
  fixture.releaseArchive();
  const finished = await done(working, 'A');
  assert(finished.room.archived); assert.deepEqual(finished.tasks[0].usage, { ordinary: 1, checks: 1 });
  await send('VERIFY_ROOMS 归档群续办');
  await until(() => get(`/api/rooms/${working.id}`), value => value.tasks.length === 2, 'new task in archive');
  const next = await done(working, 'A'); assert(next.room.archived); assert.equal(next.tasks.length, 2);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const stored = JSON.parse(db.prepare('SELECT data FROM rooms WHERE id=?').get(working.id).data);
    assert.equal(stored.archive.value, 'archived');
    writeFileSync(join(evidence, 'rooms-archive.sqlite-proof.json'), JSON.stringify({ roomId: working.id, archive: stored.archive, taskCount: Object.keys(stored.tasks).length }, null, 2));
  } finally { db.close(); }
  await capture('rooms-archive-complete');
  log('room-archive-verified', { scenarios: ['BT_G15', 'BT_G16', 'BT_G17', 'BT_G21'], historyPreserved: true, draftPreserved: true, mobileRestore: true, archiveAfterNewMessage: next.room.archived });
}
async function reports() {
  const room = await newRoom();
  await capture('reports-before');
  await send('VERIFY_REPAIR 生成可导出的报告');
  const snapshot = await done(room, 'A');
  const task = snapshot.tasks.at(-1);
  assert.equal(task.artifacts[0].content, report);
  assert.equal(task.artifacts[0].author, 'A');
  assert.equal(task.usage.checks, 2, 'Check retry must consume a second check request');
  const records = readFileSync(join(evidence, 'model-http.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const checks = records.filter(r => r.goal.includes('VERIFY_REPAIR') && r.kind === 'check');
  assert.deepEqual(checks.map(r => r.count), [1, 2]);
  assert.equal(checks[0].workId, checks[1].workId);
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
  await continueOriginalWindow();
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
    await skipModelServiceErrorGate(room);
    await closeRequiredPrompt(room, '核查中断，请重试 B');
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
  const typography = async () => {
    const font = await page.getByRole('log').locator('.message-text').first().evaluate(el => getComputedStyle(el).fontSize);
    const color = await page.getByRole('log').locator('.message:not(.from-user) .message-text').first().evaluate(el => getComputedStyle(el).color);
    const userColor = await page.getByRole('log').locator('.from-user .message-text').first().evaluate(el => getComputedStyle(el).color);
    assert.equal(font, '16px');
    assert.equal(color, 'rgb(39, 49, 66)');
    assert.equal(userColor, 'rgb(39, 49, 66)');
    log('message-typography', { font, color, userColor, viewport: page.viewportSize() });
  };
  await typography();
  await capture('layout-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await typography();
  await click('button', '展开导航');
  await page.getByRole('complementary', { name: '群聊和成员' }).waitFor();
  await capture('layout-mobile');
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '收起导航', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const statusRow = () => page.locator('.task-status-row');
const taskButton = () => page.locator('.task-status-button');
const inputBox = () => page.getByRole('textbox', { name: '群聊消息输入框' });
const timeline = () => page.getByRole('log', { name: '群聊消息', exact: true });
async function snapshotProof(name, room = observed.room) {
  const snapshot = await get(`/api/rooms/${room.id}`);
  writeFileSync(join(evidence, `${name}.snapshot.json`), JSON.stringify(snapshot, null, 2));
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const stored = JSON.parse(db.prepare('SELECT data FROM rooms WHERE id=?').get(room.id).data);
    writeFileSync(join(evidence, `${name}.sqlite-proof.json`), JSON.stringify(stored, null, 2));
  } finally { db.close(); }
  return snapshot;
}
async function running(room) {
  return until(() => get(`/api/rooms/${room.id}`), s => s.works.some(w => w.kind === 'owner' && w.status === 'inflight'), 'owner is executing');
}
async function rememberRow(phase) {
  await statusRow().waitFor({ state: 'visible' });
  assert.equal(await statusRow().count(), 1, 'One task has exactly one status row');
  await statusRow().waitFor({ state: 'visible' });
  const handle = await statusRow().elementHandle();
  if (!observed.row) observed.row = handle;
  assert.equal(await handle.evaluate((element, original) => element === original, observed.row), true, `The ${phase} phase must update the original DOM status row`);
  observed.phases ??= [];
  observed.phases.push({ phase, text: await statusRow().innerText() });
  await capture(`state-${phase}`);
}
async function prepareState() {
  observed.room = await newRoom();
  await send('VERIFY_STATE 连续状态与真实工具记录');
  await running(observed.room);
  await rememberRow('running');
}
async function receiveStates() {
  fixture.release('state-owner');
  await until(() => get(`/api/rooms/${observed.room.id}`), s => s.tasks[0]?.phase === 'waitingAssistance', 'waiting for B');
  await taskButton().getByText('等待协助', { exact: true }).waitFor();
  await rememberRow('waitingAssistance');
  fixture.release('state-assistance');
  await done(observed.room, 'A');
  await taskButton().getByText('已完成', { exact: true }).waitFor();
  await rememberRow('complete');
  observed.final = await snapshotProof('state-complete');
}
async function assertTimeline() {
  const snapshot = observed.final;
  assert(snapshot.messages.some(m => m.kind === 'help' && m.author === 'A'));
  assert(snapshot.messages.some(m => m.kind === 'answer' && m.author === 'B'));
  assert(snapshot.messages.some(m => m.author === 'facilitator' && m.text.includes('已交给 A')));
  assert(snapshot.events.some(event => event.kind === 'tool-start'), 'A real local-tool invocation must precede detail assertions');
  assert(snapshot.events.some(event => event.kind === 'tool-result'));
  assert.deepEqual(snapshot.messages.map(message => [message.kind, message.author, message.text]), [
    ['user', 'user', 'VERIFY_STATE 连续状态与真实工具记录'],
    ['help', 'A', '核对原始来源'],
    ['answer', 'B', 'B 已核对原始来源'],
    ['notice', 'facilitator', 'B 的核查结果已交给 A，已安排继续完善方案。'],
    ['final', 'A', '验证任务已完成，请查看报告。'],
  ], 'State updates must not create extra persisted status messages');
  // Compare the displayed message identities with the persisted conversation;
  // status transitions must not produce extra synthetic messages.
  const rendered = timeline().locator('.message');
  assert.equal(await rendered.count(), snapshot.messages.length, 'Timeline contains exactly the persisted actual messages');
  assert.deepEqual(await timeline().locator('.message-text').allTextContents(), snapshot.messages.map(message => message.text), 'Timeline preserves each actual statement in order');
  for (const event of snapshot.events.filter(event => ['tool-start', 'tool-result'].includes(event.kind))) {
    assert.equal(await timeline().getByText(event.detail, { exact: true }).count(), 0, `Raw execution record ${event.id} must stay outside the timeline`);
  }
  log('timeline-contract', { messages: snapshot.messages.map(m => ({ id: m.id, kind: m.kind, author: m.author })), events: snapshot.events.length });
}
async function assertCollapsed() {
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '查看方案师的执行过程' }).click();
  const details = page.getByRole('complementary', { name: '方案师的执行过程', exact: true });
  const trigger = details.getByRole('button', { name: /查看本地技能/ }).first();
  await trigger.waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Raw tool details start collapsed');
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await details.getByText('来源：任务执行 · 轮次 1', { exact: true }).first().waitFor();
  await capture('state-tool-expanded');
  await trigger.click();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
}
async function basics() {
  const first = observed.room;
  const second = await newRoom(true);
  await click('button', '点名成员');
  await click('option', 'Builder 2 @builder-2');
  assert.match(await inputBox().inputValue(), /@builder-2/);
  await inputBox().fill('@builder-2');
  await inputBox().press('Enter');
  await until(() => inputBox().inputValue(), text => text === '@builder-2 ', 'keyboard mention completion');
  await send('@builder-2 VERIFY_STOP 单页面停止与继续', true);
  observed.room = second;
  observed.beforeStop = await running(second);
  observed.placeholder = await until(() => inputBox().getAttribute('placeholder'), text => text?.startsWith('补充当前工作'), 'active task input placeholder');
  await capture('basic-running');
  await click('button', '停止');
  await until(() => get(`/api/rooms/${second.id}`), s => s.tasks[0]?.outcome === 'stopped', 'user stop persisted');
  await until(() => fixture.cancelled, n => n > 0, 'provider request aborted by Stop');
  await capture('basic-stopped');
  const firstSnapshot = await get(`/api/rooms/${first.id}`);
  await page.getByRole('navigation', { name: '群聊列表' }).getByRole('button', { name: firstSnapshot.room.title, exact: true }).click();
  await until(() => page.evaluate(() => localStorage.getItem('squad-room')), id => id === first.id, 'switch to first room');
  const secondSnapshot = await get(`/api/rooms/${second.id}`);
  await page.getByRole('navigation', { name: '群聊列表' }).getByRole('button', { name: secondSnapshot.room.title, exact: true }).click();
  await until(() => page.evaluate(() => localStorage.getItem('squad-room')), id => id === second.id, 'switch back to stopped task');
}
async function inputAndContinue() {
  await continueOriginalWindow();
  const continued = await done(observed.room, 'builder-2');
  assert.equal(continued.tasks.length, 1);
  assert.equal(continued.tasks[0].id, observed.beforeStop.tasks[0].id);
  assert(continued.tasks[0].trace.some(entry => entry.event === 'STOP'));
  assert(continued.tasks[0].trace.some(entry => entry.event === 'CONTINUE'));
  assert(continued.events.some(event => event.kind === 'cancelled'), 'The stopped execution remains visible in history');
  await capture('basic-continued');
  observed.room = await newRoom();
  await send('VERIFY_INPUT 执行中的真实补充');
  await running(observed.room);
  await until(() => inputBox().getAttribute('placeholder'), text => text?.startsWith('补充当前工作'), 'active task input placeholder');
  await send('追加资料：验收必须保留来源');
  const received = await until(() => get(`/api/rooms/${observed.room.id}`), s => s.messages.some(m => m.text === '追加资料：验收必须保留来源'), 'supplement persisted while owner is running');
  assert.equal(received.tasks.length, 1, 'Midflight input stays in the original task');
  await timeline().getByText('追加资料：验收必须保留来源', { exact: true }).waitFor();
  await capture('input-received');
  fixture.release('input-owner');
  await closeRequiredPrompt(observed.room, '请补充报告的来源要求。');
  await send('来源要求是：追加资料中的验收必须保留来源');
  const waiting = await until(() => get(`/api/rooms/${observed.room.id}`), s => s.tasks[0]?.phase === 'waitingHuman' && s.works.filter(work => work.kind === 'owner').length >= 2, 'explicit user question after supplement handoff');
  await closeRequiredPrompt(observed.room, '请确认是否采用追加资料中的来源要求？');
  await timeline().getByText('请确认是否采用追加资料中的来源要求？', { exact: true }).waitFor();
  assert.match(await page.locator('.task-status-row').innerText(), /等待你的回复/);
  await capture('input-waiting-human');
  await send('确认采用来源要求');
  const completed = await done(observed.room, 'A');
  assert.equal(completed.tasks[0].id, waiting.tasks[0].id);
  const requests = readFileSync(join(evidence, 'model-http.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(requests.some(request => request.goal?.includes('VERIFY_INPUT') && request.hasSupplement), 'The model receives the actual midflight supplement at a safe boundary');
  await snapshotProof('input-complete');
}
async function skipModelServiceErrorGate(room) {
  const gate = (await get(`/api/rooms/${room.id}`)).blockers?.find(blocker =>
    blocker.status === 'open' && blocker.requiredHuman && blocker.cause === 'modelServiceError');
  if (!gate) return;
  const dialog = page.getByRole('dialog', { name: '需要你的回复', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '跳过', exact: true }).click();
  await until(() => get(`/api/rooms/${room.id}`), snap => !snap.blockers?.some(blocker => blocker.id === gate.id && blocker.status === 'open'),
    'model service error gate skipped');
}
async function retryFromHelp() {
  observed.room = await newRoom();
  await send('VERIFY_RETRY 浏览器原求助重试');
  const before = await until(() => get(`/api/rooms/${observed.room.id}`), s => s.tasks[0]?.phase === 'waitingHuman' && s.tasks[0].assists?.some(help => help.retryable), 'retryable assistance');
  await skipModelServiceErrorGate(observed.room);
  await closeRequiredPrompt(observed.room, '核查中断，请重试 B');
  await timeline().getByText('核查中断，请重试 B', { exact: true }).waitFor();
  await capture('retry-failed');
  await timeline().getByRole('button', { name: '重试 B 的这次协助', exact: true }).first().click();
  const after = await done(observed.room, 'A');
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].id, before.tasks[0].id);
  assert.deepEqual(after.works.filter(w => w.kind === 'assistance').map(w => w.agentId), ['B', 'B']);
  assert(after.messages.filter(m => m.author === 'facilitator' && m.text.includes('已交给 A')).length >= 1,
    'Owner must receive the assistance retry outcome');
  await snapshotProof('retry-complete');
}
async function prepareDetails() {
  observed.room = await newRoom();
  await send('VERIFY_DETAILS 来源版本与按需详情');
  observed.final = await done(observed.room, 'A');
  for (const kind of ['tool-start', 'tool-result', 'error', 'output']) assert(observed.final.events.some(event => event.kind === kind && event.agentId === 'A'), `A must have real ${kind} events`);
  assert(observed.final.tasks[0].artifacts.length);
  await snapshotProof('details-seed');
}
async function openDetails() {
  await taskButton().click();
  await page.getByRole('complementary', { name: '结果详情', exact: true }).waitFor();
  await capture('details-task');
  observed.taskText = await page.getByRole('complementary', { name: '结果详情', exact: true }).innerText();
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '查看方案师的执行过程' }).click();
  await page.getByRole('complementary', { name: '方案师的执行过程', exact: true }).waitFor();
  assert.equal(await page.locator('.details').count(), 1, 'Task and member records share one details area');
  await capture('details-agent');
}
async function detailSources() {
  const details = page.getByRole('complementary', { name: '方案师的执行过程', exact: true });
  const work = observed.final.works.find(w => w.kind === 'owner');
  assert(work.reason);
  await details.getByText(work.reason, { exact: true }).first().waitFor();
  const tool = details.getByRole('button', { name: /查看本地技能/ }).first();
  assert.equal(await tool.getAttribute('aria-expanded'), 'false');
  await tool.click();
  await details.getByText('来源：任务执行 · 轮次 1', { exact: true }).first().waitFor();
  await details.getByRole('button', { name: /模型输出格式不合规，重新生成/ }).first().click();
  await capture('details-sources-errors');
}
async function artifactVersion() {
  const artifact = observed.final.tasks[0].artifacts[0];
  await click('tab', '产物', false);
  await page.getByRole('complementary', { name: '方案师的执行过程', exact: true }).getByRole('button', { name: `查看 ${artifact.name}`, exact: true }).click();
  const preview = page.getByRole('complementary', { name: '报告预览', exact: true });
  await preview.getByRole('heading', { name: '验证报告', exact: true }).waitFor();
  assert.match(await preview.innerText(), /来源/);
  assert.match(await preview.innerText(), /方案师/);
  observed.agentArtifactText = await preview.innerText();
  await capture('details-agent-artifact');
  await taskButton().click();
  await page.getByRole('complementary', { name: '结果详情', exact: true }).getByRole('button', { name: `查看 ${artifact.name}`, exact: true }).click();
  await preview.getByRole('heading', { name: '验证报告', exact: true }).waitFor();
  assert.equal(await preview.innerText(), observed.agentArtifactText, 'Task and member entries resolve the same report, source and version');
  await click('button', '引用到新任务');
  await send('VERIFY_REVISION 根据已引用原报告补齐回执核对');
  const revision = await until(() => get(`/api/rooms/${observed.room.id}`), s => s.tasks.length === 2 && s.tasks[1].outcome === 'complete', 'referenced report revision complete');
  const revisedTask = revision.tasks[1];
  assert.equal(revisedTask.sourceArtifact.sourceTaskId, observed.final.tasks[0].id);
  assert.equal(revisedTask.sourceArtifact.artifactId, artifact.id);
  assert.equal(revisedTask.sourceArtifact.revision, artifact.revision);
  assert.equal(revisedTask.artifacts[0].content, revisedReport);
  assert.equal(revision.tasks[0].artifacts[0].content, report, 'Original version stays unchanged');
  await taskButton().getByText(revisedTask.goal, { exact: true }).waitFor();
  await taskButton().click();
  const result = page.getByRole('complementary', { name: '结果详情', exact: true });
  await result.getByRole('button', { name: '查看 verification-report-v2.md', exact: true }).click();
  await preview.getByRole('heading', { name: '修订验证报告', exact: true }).waitFor();
  const sourceLink = preview.getByRole('button', { name: /来源.*verification-report.md/ });
  await sourceLink.waitFor();
  const sourceLabel = await sourceLink.innerText();
  assert.match(sourceLabel, /来源 verification-report.md/);
  await capture('details-revision-source');
  await sourceLink.click();
  await preview.getByRole('heading', { name: '验证报告', exact: true }).waitFor();
  assert.equal(await preview.getByRole('heading', { name: '修订验证报告', exact: true }).count(), 0, 'Source link must resolve the original version');
  await capture('details-original-from-source');
  await page.getByRole('complementary', { name: '群聊和成员' }).getByRole('button', { name: '查看方案师的执行过程' }).click();
  await click('tab', '产物', false);
  const artifacts = page.getByRole('complementary', { name: '方案师的执行过程', exact: true });
  await artifacts.getByRole('button', { name: '查看 verification-report-v2.md', exact: true }).click();
  await preview.getByRole('heading', { name: '修订验证报告', exact: true }).waitFor();
  await preview.getByRole('button', { name: '来源 verification-report.md', exact: true }).waitFor();
  await capture('details-revision-from-member');
  await snapshotProof('details-artifact-version');
}
async function prepareOffline() {
  observed.room = await newRoom();
  await send('VERIFY_RECONNECT 活动刷新与宿主重连');
  observed.beforeOffline = await running(observed.room);
  await capture('offline-before-refresh');
  await page.reload();
  await page.getByText('已连接', { exact: true }).waitFor();
  await timeline().getByText('VERIFY_RECONNECT 活动刷新与宿主重连', { exact: true }).waitFor();
  const refreshed = await get(`/api/rooms/${observed.room.id}`);
  assert.equal(refreshed.tasks[0].id, observed.beforeOffline.tasks[0].id);
  assert.equal(refreshed.tasks.length, 1);
  await capture('offline-active-refreshed');
  await stopApp('SIGKILL');
  await page.getByText('连接中断', { exact: true }).first().waitFor();
  observed.offlineText = await timeline().innerText();
  observed.offlineWorks = observed.beforeOffline.works;
}
async function noOfflineProgress() {
  // Poll through two actual failed requests; elapsed time alone is not evidence.
  let failedPolls = 0;
  const listener = request => { if (request.url().startsWith(url + '/api/')) failedPolls++; };
  page.on('requestfailed', listener);
  try { await until(async () => failedPolls, count => count >= 2, 'two failed offline polls', 12_000); }
  finally { page.off('requestfailed', listener); }
  assert.equal(await timeline().innerText(), observed.offlineText, 'No new conversation progress appears while the host is absent');
  assert.equal(await inputBox().isDisabled(), true);
  assert.equal(await page.locator('.is-working').count(), 0, 'Offline host cannot be presented as executing');
  await capture('offline-no-progress');
}
async function reconnect() {
  await launch();
  await page.getByText('已连接', { exact: true }).waitFor(); // No reload: exercise automatic reconnection.
  const after = await done(observed.room, 'A');
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].id, observed.beforeOffline.tasks[0].id);
  const oldWork = observed.beforeOffline.works.find(w => w.kind === 'owner');
  assert.equal(after.works.filter(w => w.kind === 'owner').length, 1, 'Recovery preserves the safe work identity');
  assert.equal(after.works.find(w => w.kind === 'owner').id, oldWork.id);
  assert.equal(after.messages.filter(m => m.text === 'VERIFY_RECONNECT 活动刷新与宿主重连').length, 1);
  await snapshotProof('offline-reconnected');
}
async function lostReceiptRetry() {
  observed.room = await newRoom();
  let lost = false;
  const route = async route => {
    if (!lost && route.request().method() === 'POST') {
      lost = true;
      const realResponse = await route.fetch(); // The production service commits first.
      assert.equal(realResponse.status(), 200);
      log('real-response-lost', { path: new URL(route.request().url()).pathname });
      return route.abort('failed'); // Drop only transport delivery, never invent API state.
    }
    return route.continue();
  };
  await page.route('**/api/rooms/*/messages', route);
  await send('VERIFY_ROOMS 丢失回执后重试同一消息');
  await page.getByRole('alert').waitFor();
  assert.equal(await inputBox().inputValue(), 'VERIFY_ROOMS 丢失回执后重试同一消息', 'Failed send retains the draft');
  await capture('retry-lost-receipt');
  await page.unroute('**/api/rooms/*/messages', route);
  await click('button', '发送消息');
  const after = await done(observed.room, 'A');
  const messages = posted.filter(post => post.path.endsWith('/messages') && JSON.parse(post.body).text === 'VERIFY_ROOMS 丢失回执后重试同一消息');
  assert.equal(messages.length, 2, 'The browser performs the actual retry');
  assert.equal(JSON.parse(messages[0].body).id, JSON.parse(messages[1].body).id, 'Retry keeps the original request identity');
  assert.equal(after.messages.filter(m => m.text === 'VERIFY_ROOMS 丢失回执后重试同一消息').length, 1);
  assert.equal(after.tasks.length, 1);
  assert.equal(after.works.filter(w => w.kind === 'owner').length, 1);
  await snapshotProof('retry-deduplicated');
}
const contractCommands = {
  openRoom: async () => { observed.room = await newRoom(); await capture('basic-open'); },
  basics,
  placeholder: async () => assert.match(observed.placeholder, /^补充当前工作/),
  singlePage: async () => { assert.equal(new URL(page.url()).pathname, '/'); assert.equal(await page.getByRole('link', { name: /设置|任务看板|审批/ }).count(), 0); },
  inputAndContinue, retryFromHelp,
  prepareState, receiveStates,
  sameRow: async () => { assert.deepEqual(observed.phases.map(p => p.phase), ['running', 'waitingAssistance', 'complete']); writeFileSync(join(evidence, 'status-row.json'), JSON.stringify(observed.phases, null, 2)); },
  timeline: assertTimeline, collapsed: assertCollapsed,
  prepareDetails, openDetails,
  sharedDetails: async () => { assert.equal(await page.locator('.details').count(), 1); assert.match(observed.taskText, /VERIFY_DETAILS/); await page.getByRole('complementary', { name: '方案师的执行过程', exact: true }).getByRole('tab', { name: /执行过程/ }).waitFor(); },
  detailSources,
  noHiddenReasoning: async () => { assert.doesNotMatch(await page.locator('.details').innerText(), /隐藏推理|chain.of.thought|hidden.reasoning/i); },
  artifactVersion,
  prepareOffline,
  observeOffline: async () => { assert.equal(child, undefined); await page.getByText('连接中断', { exact: true }).first().waitFor(); await capture('offline-visible'); },
  disconnected: async () => { assert.match(await taskButton().innerText(), /连接中断/); assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true); },
  noOfflineProgress, reconnect, lostReceiptRetry,
};
const requiredCommands = {
  BT_U01: ['openRoom', 'basics', 'placeholder', 'singlePage', 'inputAndContinue', 'retryFromHelp'],
  BT_U02: ['prepareState', 'receiveStates', 'sameRow', 'timeline', 'collapsed'],
  BT_U03: ['prepareDetails', 'openDetails', 'sharedDetails', 'detailSources', 'noHiddenReasoning', 'artifactVersion'],
  BT_U09: ['prepareOffline', 'observeOffline', 'disconnected', 'noOfflineProgress', 'reconnect', 'lostReceiptRetry'],
};
async function driveContract() {
  process.send({ id: 'ready', result: { evidence, source: run.source, browser: run.browser } });
  await new Promise(resolve => {
    let busy = false;
    process.on('message', async message => {
      if (message.command === 'close') { resolve(); return; }
      try {
        assert(!busy, 'Browser contract steps are sequential');
        assert(requiredCommands[contract].includes(message.command), `Unexpected ${contract} command ${message.command}`);
        busy = true;
        await contractCommands[message.command]();
        log('contract-step-pass', { contract, command: message.command });
        run.steps.push(message.command);
        process.send({ id: message.id, result: { command: message.command } });
      } catch (error) {
        run.error = error.stack;
        failures.push(`${message.command}: ${error.message}`);
        await capture('step-failure').catch(() => {});
        process.send({ id: message.id, error: error.stack });
      } finally { busy = false; }
    });
    process.once('disconnect', resolve);
  });
  assert.deepEqual(run.steps, requiredCommands[contract], 'Every original Gherkin requirement must execute in order');
  assert.equal(failures.length, 0, failures.join('\n'));
  run.completed.push(contract);
}

function cleanup() {
  cleanupPromise ??= performCleanup();
  return cleanupPromise;
}
async function performCleanup() {
  clearTimeout(timer);
  if (page && !page.isClosed() && contract) await capture('contract-final').catch(e => failures.push(`capture: ${e.message}`));
  if (context) await context.tracing.stop({ path: join(evidence, 'trace.zip') }).catch(e => failures.push(`trace: ${e.message}`));
  if (browser) await browser.close().catch(e => failures.push(`browser cleanup: ${e.message}`));
  try { await stopApp(); } catch (error) { failures.push(`app cleanup: ${error.message}`); }
  let fixtureClosed = !fixture;
  try { if (fixture) { await fixture.close(); fixtureClosed = true; } }
  catch (error) { failures.push(`fixture cleanup: ${error.message}`); }
  let groupsGone = false;
  try { groupsGone = [...ownedProcessGroups].every(pid => processGroupGone(pid)); }
  catch (error) { failures.push(`process group cleanup: ${error.message}`); }
  if (groupsGone) {
    try { rmSync(state, { recursive: true, force: true }); } catch (error) { failures.push(`state cleanup: ${error.message}`); }
    try { rmSync(workspace, { recursive: true, force: true }); } catch (error) { failures.push(`workspace cleanup: ${error.message}`); }
  } else {
    log('state-retained', { state, workspace, reason: 'Owned app exit is not proven; retain active database' });
    // Let the supervisor's parent-loss/closed-pipe guard finish bounded cleanup;
    // do not hang this failed verifier or remove a possibly active database.
    child?.unref(); child?.stdout?.destroy(); child?.stderr?.destroy();
  }
  run.cleanup = { stateRemoved: !existsSync(state) && !existsSync(workspace), appStopped: groupsGone,
    processGroupGone: groupsGone, fixtureClosed, browserClosed: !browser?.isConnected(), evidenceRetained: existsSync(actions) };
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
  run.build = verifyBuild(root);
  symlinkSync(join(root, 'dist'), join(state, 'dist'), 'dir');
  mkdirSync(join(state, 'skills'));
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
  page.on('request', request => { if (request.method() === 'POST') { const value = { path: new URL(request.url()).pathname, body: request.postData() }; posted.push(value); log('browser-post', value); } });
  run.browser = browser.version();
  run.url = url;
  timer = setTimeout(() => { void interrupted('Global verification deadline (180s)'); }, 180_000);
  await page.goto(url);
  await page.getByText('已连接', { exact: true }).waitFor();
  if (contract) await driveContract();
  for (const name of contract ? [] : selected === 'all' ? allowed : [selected]) {
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
  if (failures.length) { run.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
  assert(existsSync(join(evidence, 'run.json')) && existsSync(actions), 'Evidence must survive cleanup');
  console.log(JSON.stringify(run, null, 2));
}

if (process.connected) process.disconnect();
