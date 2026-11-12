import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamConfig } from '../team.config.ts';
import { LocalRuntime } from '../src/local-runtime.ts';
import { processingWindow } from '../src/task/resilience.ts';
import { ResilientWorkspaceBrowserFixture } from './resilient-workspace-browser-fixture.mjs';

/** Given data uses persisted public Engine operations; all decisions below use
 * the real browser, HTTP router, WebService and SQLite, with no API stubbing. */
export class WindowStdinUICase {
  constructor(id) { this.id = id; this.sequence = 0; this.hostStarts = 0; }
  context() { return this.browser.service.engine.view(this.room.id, this.taskId).context; }
  snapshot() { return this.browser.service.snapshot(this.room.id); }
  event(body) {
    const response = this.browser.service.engine.send(this.room.id, this.taskId,
      { id: `window-stdin-ui:${++this.sequence}`, at: Date.now(), ...body });
    assert(response.ok, JSON.stringify(response)); return response;
  }
  async open() {
    this.directory = await mkdtemp(join(tmpdir(), 'squad-window-stdin-ui-'));
    this.source = join(this.directory, 'source'); await mkdir(this.source);
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.directory, 'runtime'), workspaceRoot: this.source,
      skillRoots: [], cliCatalog: [], catalogRefreshIntervalMs: 0,
      backend: { available: true, execute: async () => { throw new Error('This UI case must not execute sandbox commands'); } } });
    const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
    config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    config.resilience = { automaticTimeoutMs: this.id === 'BT_Y149' ? 1200 : 60_000,
      repairTimeoutMs: 60_000, cancelGraceMs: 1000 };
    const adapter = { execute: async (_work, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
    this.browser = await new ResilientWorkspaceBrowserFixture(this.id, { config, adapter, localRuntime: this.runtime }).open();
    this.page = this.browser.page; this.room = await this.browser.createRoom();
    const engine = this.browser.service.engine;
    this.taskId = this.browser.service.submit(this.room.id, { id: randomUUID(), text: '核对可见窗口与标准输入计划' }).taskId;
    const pending = engine.pending(this.room.id, this.taskId).find(work => work.kind === 'owner');
    this.owner = engine.claim(this.room.id, this.taskId, pending.id); assert(this.owner);
    this.room = this.snapshot().room;
    if (this.id === 'BT_Y149') {
      this.event({ type: 'CONSUME', intentId: this.owner.id, fence: this.owner });
      this.event({ type: 'CONSUME', intentId: this.owner.id, fence: this.owner });
      this.event({ type: 'CONSUME', intentId: this.owner.id, fence: this.owner });
      this.event({ type: 'ARTIFACT', artifact: { id: 'saved-before-expiry', name: 'source.md', content: '窗口到期前已经保存的可见成果' } });
      this.originalWindow = structuredClone(processingWindow(this.context()));
      this.originalUsage = structuredClone(this.context().usage); assert.equal(this.originalUsage.ordinary, 3);
      await this.browser.until(() => Date.now(), now => now >= this.originalWindow.hardDeadline, 'actual hard deadline');
      this.event({ type: 'SUPERVISE', trigger: 'timer' });
      this.windowGate = structuredClone(this.context().resilience.gates.find(gate => gate.status === 'open' && gate.cause === 'windowExpired'));
      assert(this.windowGate); assert.equal(this.context().outcome, null);
    } else {
      const inputPath = 'inputs/scan.txt'; this.inputBody = 'PRIVATE OCR INPUT: 426185';
      await mkdir(join(this.source, 'inputs')); await writeFile(join(this.source, inputPath), this.inputBody);
      this.marker = join(this.source, 'unapproved-start.txt');
      const action = { type: 'runCli', executable: process.execPath, args: ['-e',
        'require("node:fs").writeFileSync("unapproved-start.txt","started");process.stdin.pipe(process.stdout)'],
        execution: 'host', reason: '核对工作区文件标准输入的精确宿主计划', stdin: { path: inputPath } };
      const operation = engine.requestLocal(this.room.id, this.taskId, this.owner.id, this.owner.attempt, action, [],
        this.runtime.workspaceId(this.owner, engine.localNamespace(this.room.id, this.taskId)));
      const claim = engine.claimLocal(this.room.id, this.taskId, this.owner.id, operation.id, this.owner.attempt); assert(claim.response.ok);
      const execution = await this.runtime.execute(this.owner, claim.operation, new AbortController().signal, () => { this.hostStarts++; },
        undefined, { roomId: this.room.id, taskId: this.taskId }, metadata => this.event({ type: 'LOCAL_PREPARED',
          intentId: this.owner.id, operationId: operation.id, sessionId: claim.operation.sessionId, fence: this.owner, ...metadata }));
      assert(execution.approval); this.approval = execution.approval; this.operationId = operation.id;
      this.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: this.owner.id, operationId: operation.id,
        sessionId: claim.operation.sessionId, approval: execution.approval, fence: this.owner });
      this.expectedInput = { path: inputPath, sha256: createHash('sha256').update(this.inputBody).digest('hex'), bytes: Buffer.byteLength(this.inputBody) };
      assert.deepEqual(this.approval.plan.stdin, this.expectedInput); assert.equal(this.hostStarts, 0); assert(!existsSync(this.marker));
    }
    await this.page.reload();
    await this.page.getByRole('heading', { name: this.room.title, exact: true, includeHidden: true }).waitFor();
  }
  async closeAndReload() {
    const dialog = this.page.getByRole('dialog', { name: '处理窗口已到期', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '暂时关闭处理提示', exact: true }).click();
    await this.page.reload();
    await this.page.getByRole('dialog', { name: '处理窗口已到期', exact: true }).waitFor();
  }
  async verifyExpired() {
    const dialog = this.page.getByRole('dialog', { name: '处理窗口已到期', exact: true });
    await dialog.waitFor();
    assert((await dialog.innerText()).includes('WINDOW_EXPIRED'));
    assert.equal(await dialog.getByRole('spinbutton', { name: '新处理时长（分钟）', exact: true }).inputValue(), '180');
    assert.equal(await dialog.getByRole('button', { name: '授权新窗口', exact: true }).count(), 1);
    const context = this.context(); assert.equal(context.outcome, null);
    assert.equal(processingWindow(context).id, this.originalWindow.id);
    assert.equal(processingWindow(context).hardDeadline, this.originalWindow.hardDeadline);
    assert(context.resilience.gates.some(gate => gate.id === this.windowGate.id && gate.status === 'open'));
    assert.equal(this.browser.posts.filter(post => post.path.endsWith('/blocker-decision')).length, 0);
    await this.browser.capture('window-expired-after-reload');
  }
  async authorizeWindow() {
    const dialog = this.page.getByRole('dialog', { name: '处理窗口已到期', exact: true });
    await dialog.getByRole('textbox', { name: '决定回复', exact: true }).fill('继续处理，明确授权新的三小时窗口');
    await dialog.getByRole('button', { name: '授权新窗口', exact: true }).click();
    await this.browser.until(() => processingWindow(this.context()), window => window.id !== this.originalWindow.id, 'authorized replacement window');
  }
  async verifyAuthorizedWindow() {
    const context = this.context(), window = processingWindow(context);
    assert.equal(window.hardDeadline - window.openedAt, 10_800_000);
    assert(window.authorizationId); assert.equal(context.artifacts.find(artifact => artifact.id === 'saved-before-expiry').content, '窗口到期前已经保存的可见成果');
    assert(context.usage.ordinary >= this.originalUsage.ordinary); assert(context.usage.checks >= this.originalUsage.checks);
    const decisions = this.browser.posts.filter(post => post.path.endsWith('/blocker-decision'));
    assert.equal(decisions.length, 1); assert.equal(decisions[0].body.blockerId, this.windowGate.id);
    assert.equal(decisions[0].body.actionId, 'newWindow'); assert.equal(decisions[0].body.newWindowMs, 10_800_000);
    const rows = this.browser.readDatabase().rooms;
    assert(rows.some(row => row.id === this.room.id && row.data.includes(window.authorizationId)));
    await this.browser.capture('new-window-authorized'); this.browser.completed.push(this.id);
  }
  async showApproval() { await this.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true }).waitFor(); }
  async verifyInputPlan() {
    const dialog = this.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true });
    const text = await dialog.innerText();
    assert(text.includes(this.expectedInput.path)); assert(text.includes(this.expectedInput.sha256)); assert(text.includes(`${this.expectedInput.bytes}`));
    assert(!text.includes(this.inputBody));
    assert.equal(this.snapshot().hostApprovals[0].stdin.sha256, this.expectedInput.sha256);
    assert.equal(this.hostStarts, 0); assert(!existsSync(this.marker));
    await this.browser.capture('stdin-exact-host-plan');
  }
  async rejectInput() {
    const dialog = this.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true });
    const responsePending = this.page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/host-approval')
      && response.request().postDataJSON()?.approvalId === this.approval.id);
    await dialog.getByRole('button', { name: '拒绝', exact: true }).click();
    const response = await responsePending;
    assert.equal(response.status(), 200); assert.equal((await response.json()).ok, true);
    await dialog.waitFor({ state: 'hidden' });
    await this.browser.until(() => this.context().intents.flatMap(work => work.localOperations ?? []).find(operation => operation.id === this.operationId),
      operation => operation.approval.status === 'denied', 'persisted stdin rejection');
    assert.equal(this.hostStarts, 0); assert(!existsSync(this.marker));
    const posts = this.browser.posts.filter(post => post.path.endsWith('/host-approval'));
    assert.equal(posts.length, 1); assert.equal(posts[0].body.decision, 'deny');
    assert.equal(posts[0].body.approvalId, this.approval.id);
    await this.browser.capture('stdin-host-denied');
    this.browser.completed.push(this.id);
  }
  markFailed(message) { if (this.browser) { this.browser.failed = true; this.browser.failureReason = message; } }
  async close() { try { await this.browser?.close(); } finally { await this.runtime?.close(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); } }
}
