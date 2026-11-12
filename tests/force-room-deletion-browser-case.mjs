import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamConfig } from '../team.config.ts';
import { LocalRuntime } from '../src/local-runtime.ts';
import { passFixtureCheck } from './helpers.ts';
import { runProcess } from '../src/local-cli.ts';
import { ResilientWorkspaceBrowserFixture, barrier } from './resilient-workspace-browser-fixture.mjs';

/** Current delete UI: real Chromium -> HTTP -> SQLite; only model/process boundary is controlled. */
export class ForceRoomDeletionBrowserCase {
  constructor(id) { this.id = id; this.number = Number(id.replace('BT_Y', '')); this.gates = []; }
  async open() {
    this.outer = await mkdtemp(join(tmpdir(), 'squad-force-delete-ui-'));
    this.source = join(this.outer, 'source'); await mkdir(this.source);
    await writeFile(join(this.source, 'keep.txt'), '用户工程必须保留');
    this.runtimeOptions = { dataRoot: join(this.outer, 'runtime'), workspaceRoot: this.source, skillRoots: [], cliCatalog: [],
      backend: { available: true, execute: async (input, signal, observe) => ({ ...await runProcess(input, signal, observe), effectsKnown: false }) } };
    this.runtime = await LocalRuntime.create(this.runtimeOptions);
    const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
    config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 60_000, cancelGraceMs: 1000 };
    this.host = await new ResilientWorkspaceBrowserFixture(this.id, { config, localRuntime: this.runtime,
      reopenLocalRuntime: async () => this.runtime = await LocalRuntime.create(this.runtimeOptions) }).open();
    this.page = this.host.page;
    this.other = this.host.service.createRoom('保留的会话乙'); await this.page.reload(); await this.host.selectRoom(this.other);
    this.otherDraft = '另一会话保留的未发送草稿';
    await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill(this.otherDraft);
    this.room = await this.host.createRoom();
    const engine = this.host.service.engine;
    this.taskId = engine.submit(this.room.id, { id: 'force-ui-prefix', text: '保留任务资料并执行受控命令' }).taskId;
    const work = engine.claim(this.room.id, this.taskId, engine.pending(this.room.id, this.taskId)[0].id);
    if (this.number === 96) {
      assert(engine.send(this.room.id, this.taskId, { type: 'DELIVER', id: randomUUID(), at: Date.now(), workId: work.id, fence: work,
        text: '可引用的已完成成果', artifactIds: [], artifacts: [{ name: 'target.md', content: '必须随目标清除的资料引用' }] }).ok);
      passFixtureCheck(engine, this.room.id, this.taskId, randomUUID(), Date.now());
      assert.equal(engine.view(this.room.id, this.taskId).context.outcome, 'complete');
      this.work = work;
    } else {
      const action = { type: 'runCli', executable: process.execPath, args: ['-e', 'console.log("已退出但外部效果未知")'] };
      const request = engine.requestLocal(this.room.id, this.taskId, work.id, work.attempt, action, [],
        this.runtime.workspaceId(work, engine.localNamespace(this.room.id, this.taskId)));
      const claim = engine.claimLocal(this.room.id, this.taskId, work.id, request.id, work.attempt); assert(claim.response.ok);
      const op = claim.operation;
      const execution = await this.runtime.execute(work, op, new AbortController().signal, () => {}, undefined,
        { roomId: this.room.id, taskId: this.taskId });
      assert(engine.send(this.room.id, this.taskId, { type: 'LOCAL_RESULT', id: randomUUID(), at: Date.now(),
        intentId: work.id, operationId: op.id, sessionId: op.sessionId, ...execution, effectsKnown: false }).ok);
      this.work = work;
      assert(engine.send(this.room.id, this.taskId, { type: 'ARTIFACT', id: randomUUID(), at: Date.now(),
        artifact: { id: 'target-material', name: 'target.md', content: '必须随目标清除的资料引用' } }).ok);
    }
    await this.page.reload(); await this.page.keyboard.press('Escape');
    await this.host.selectRoom(this.other);
    await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill(this.otherDraft);
    await this.host.selectRoom(this.room); await this.page.keyboard.press('Escape');
    if (this.number === 97) this.archiveResponse = await this.host.holdResponse('**/archive');
    await this.page.getByRole('button', { name: `归档群聊 ${this.room.title}`, exact: true }).click();
    await this.host.until(() => this.host.get('/rooms'), r => r.data.rooms.find(r => r.id === this.room.id)?.archived, 'target archived');
    await this.page.getByRole('button', { name: /^已归档/ }).click();
    if (this.number !== 119) {
      await this.page.getByRole('navigation', { name: '归档群聊列表', exact: true }).getByRole('button', { name: this.room.title, exact: true }).click();
      await this.page.keyboard.press('Escape');
      await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill('即将删除会话的草稿');
    }
    if (this.number === 96) {
      await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
      await this.page.getByRole('button', { name: '查看 target.md', exact: true }).click();
      await this.page.getByRole('button', { name: '引用到新任务', exact: true }).click();
      await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
      await this.page.getByRole('button', { name: '移除产物引用', exact: true }).waitFor();
      await this.page.getByRole('button', { name: '打开状态机调试', exact: true }).click();
      await this.page.getByRole('button', { name: '关闭状态机调试', exact: true }).waitFor();
    }
    if (this.number === 94) {
      const inventory = this.runtime.planRoomCleanup.bind(this.runtime); let first = true;
      this.runtime.planRoomCleanup = input => { if (first) { first = false; throw new Error('FORCE_CLEANUP_RETRY'); } return inventory(input); };
    }
    if ([96, 98, 119].includes(this.number)) {
      this.prepare = barrier(); this.entered = barrier(); this.gates.push(this.prepare);
      const inventory = this.runtime.planRoomCleanup.bind(this.runtime);
      this.runtime.planRoomCleanup = async input => { this.entered.release(); await this.prepare.promise; return inventory(input); };
    }
    await this.host.capture('given'); return this;
  }
  async additional() { assert(this.other); }
  async act() {
    const button = () => this.page.getByRole('button', { name: `删除归档群聊 ${this.room.title}`, exact: true });
    if (this.number === 95) {
      await this.page.route('**/delete', async route => {
        this.host.service.setRoomArchived(this.room.id, 'concurrent-restore', false); await route.continue();
      });
      const response = this.page.waitForResponse(r => r.url().endsWith('/delete'));
      await button().click(); assert.equal((await response).status(), 409); return;
    }
    if (this.number === 97) {
      this.oldList = await this.host.holdResponse('**/api/rooms', r => r.method() === 'GET');
      this.oldDetail = await this.host.holdResponse('**/api/rooms/' + this.room.id, r => r.method() === 'GET');
      await Promise.all([this.oldList.entered, this.oldDetail.entered]);
    }
    if (this.number === 99) {
      let first = true;
      await this.page.route('**/delete', route => { if (first) { first = false; return route.abort(); } return route.continue(); });
      await button().click(); await this.page.getByRole('alert').first().waitFor();
      assert.equal((await this.host.get('/rooms/' + this.room.id)).status, 200, 'Failed submission must preserve the target');
      this.heldDelete = await this.host.holdResponse('**/delete');
    }
    await button().focus(); await this.page.keyboard.press('Enter');
    await this.host.until(() => this.host.get('/rooms/' + this.room.id), r => r.status === 410, 'data deleted without review');
    assert.equal(await this.page.getByRole('button', { name: '确认永久删除', exact: true }).count(), 0);
    if (this.entered) await this.entered.promise;
    if (this.number === 98) {
      const reply = this.host.service.engine.send(this.room.id, this.taskId, { type: 'DELIVER', id: randomUUID(), at: Date.now(),
        workId: this.work.id, fence: this.work, text: '不得复活旧业务', artifactIds: [] });
      assert.equal(reply.ok, false);
    }
    if (this.heldDelete) {
      await this.heldDelete.entered;
      await this.page.getByRole('button', { name: '群聊', exact: true }).click();
      await this.host.selectRoom(this.other); await this.heldDelete.release();
    }
    await this.host.until(() => button().count(), count => count === 0, 'deleted target removed from sidebar');
    if (this.oldList) { await this.oldDetail.release(); await this.oldList.release(); await this.archiveResponse.release(); }
    if (this.prepare) this.prepare.release();
    await this.host.capture('when');
  }
  async verify() {
    if (this.number === 95) {
      const response = await this.host.get('/rooms/' + this.room.id);
      assert.equal(response.status, 200); assert.equal(response.data.room.archived, false);
      assert.equal(this.host.service.engine.roomDeletion(this.room.id)?.context.dataErased ?? false, false);
    } else {
      assert.equal((await this.host.get('/rooms/' + this.room.id)).status, 410);
      assert(!(await this.host.get('/rooms')).data.rooms.some(r => r.id === this.room.id));
      assert.equal(await this.page.getByRole('button', { name: `删除归档群聊 ${this.room.title}`, exact: true }).count(), 0);
      assert.equal(this.host.posts.filter(p => p.path.endsWith('/operation-reconcile') || p.path.endsWith('/delete-retry')).length, 0);
      if (this.number === 96) {
        assert.equal(await this.page.getByRole('button', { name: '移除产物引用', exact: true }).count(), 0);
        assert.equal(await this.page.getByRole('button', { name: '关闭状态机调试', exact: true }).count(), 0);
      }
      if (this.number === 99) {
        const attempts = this.host.posts.filter(p => p.path.endsWith('/delete'));
        assert.equal(attempts.length, 2); assert.equal(attempts[0].body.id, attempts[1].body.id);
      }
      if (!this.refreshed) {
        // Draft belongs to the other room; target completion must not clear it.
        await this.page.getByRole('button', { name: '群聊', exact: true }).click();
        await this.host.selectRoom(this.other);
        assert.equal(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), this.otherDraft);
        await this.page.reload(); this.refreshed = true;
      }
      await this.host.until(() => this.host.service.engine.roomDeletion(this.room.id)?.value, value => value === 'deleted', 'background files cleaned automatically');
      const rows = this.host.readDatabase();
      assert(!rows.rooms.some(r => r.id === this.room.id)); assert(!rows.webRooms.some(r => r.id === this.room.id));
      assert(!rows.events.some(r => r.roomId === this.room.id)); assert(!rows.receipts.some(r => r.room_id === this.room.id));
    }
    assert.equal((await this.host.get('/rooms/' + this.other.id)).status, 200);
    assert.equal(await readFile(join(this.source, 'keep.txt'), 'utf8'), '用户工程必须保留');
    await this.host.capture('then');
    if (!this.host.completed.includes(this.id)) this.host.completed.push(this.id);
  }
  async verifyDeletionAfterServiceRestart() {
    // Stop this fixture's polling before closing its server, including held pre-delete responses.
    await this.page.goto('about:blank');
    await this.host.restartService();
    assert.equal((await this.host.get('/rooms/' + this.room.id)).status, 410);
    await this.page.goto(this.host.url);
    await this.page.getByRole('heading', { name: this.other.title, exact: true }).waitFor();
  }
  markFailed(message) { if (this.host) { this.host.failed = true; this.host.failureReason = message; } }
  async close() { for (const gate of this.gates) gate.release(); await this.host?.close(); await this.runtime?.close(); if (this.outer) await rm(this.outer, { recursive: true, force: true }); }
}
