import assert from 'node:assert/strict';
import { ForceRoomDeletionBrowserCase } from './force-room-deletion-browser-case.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamConfig } from '../team.config.ts';
import { LocalRuntime } from '../src/local-runtime.ts';
import { runProcess } from '../src/local-cli.ts';
import { ResilientWorkspaceBrowserFixture, barrier } from './resilient-workspace-browser-fixture.mjs';
import { prepareArchiveDeleteFeedback, actArchiveDeleteFeedback, verifyArchiveDeleteFeedback } from './archive-delete-feedback-browser-case.mjs';
import { workspaceWaitAdapter, prepareWorkspaceWait, actWorkspaceWait, verifyWorkspaceWait } from './workspace-wait-browser-case.mjs';

/** Browser assertions use committed public Engine prefixes as Given data;
 * every decision, confirmation, retry, navigation and download is a real UI action. */
export class ResilientWorkspaceUICase {
  constructor(id) {
    if (/^BT_Y(?:9[2-9]|101|119)$/.test(id)) return new ForceRoomDeletionBrowserCase(id);
    this.id = id; this.number = Number(/Y(\d+)$/.exec(id)[1]); this.sequence = 0; this.facts = {}; }
  event(body) {
    const reply = this.host.service.engine.send(this.room.id, this.taskId,
      { id: `ui-host:${++this.sequence}`, at: Date.now(), ...body });
    assert(reply.ok, JSON.stringify(reply)); return reply;
  }
  get engine() { return this.host.service.engine; }
  context() { return this.engine.view(this.room.id, this.taskId).context; }
  snapshot() { return this.host.service.snapshot(this.room.id); }
  startTask() {
    this.taskId = this.host.service.submit(this.room.id, { id: randomUUID(), text: '可核对的目标甲' }).taskId;
    this.owner = this.engine.claim(this.room.id, this.taskId, this.engine.pending(this.room.id, this.taskId)[0].id);
    assert(this.owner); this.room = this.snapshot().room;
  }
  waitHuman(question = '请选择当前任务的处理方式') {
    this.event({ type: 'WAIT_USER', workId: this.owner.id, fence: this.owner, attempt: this.owner.attempt, question });
  }
  async unknownOperation() {
    this.event({ type: 'USER_INPUT', text: '请核查员同时核对', reviewTargets: ['B'] });
    const planner = this.engine.claim(this.room.id, this.taskId, this.engine.pending(this.room.id, this.taskId).find(work => work.kind === 'facilitator').id);
    this.event({ type: 'DISCUSSION_PLAN', workId: planner.id, fence: planner, attempt: planner.attempt, discussionId: planner.discussionId,
      decision: { action: 'review', question: '核对临时执行', expected: '真实回执', reason: '公开宿主前缀' } });
    const pending = this.engine.pending(this.room.id, this.taskId).find(work => work.kind === 'assistance');
    const work = this.engine.claim(this.room.id, this.taskId, pending.id);
    const action = { type: 'runCli', executable: process.execPath, args: ['-e', 'console.log("原操作已退出，外部效果仍需核对")'] };
    const operation = this.engine.requestLocal(this.room.id, this.taskId, work.id, work.attempt, action, [],
      this.runtime.workspaceId(work, this.engine.localNamespace(this.room.id, this.taskId)));
    const claim = this.engine.claimLocal(this.room.id, this.taskId, work.id, operation.id, work.attempt);
    assert(claim.response.ok);
    const execution = await this.runtime.execute(work, claim.operation, new AbortController().signal, metadata => {
      this.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: operation.id, sessionId: claim.operation.sessionId, ...metadata });
    }, undefined, { roomId: this.room.id, taskId: this.taskId }, metadata => {
      this.event({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: operation.id, sessionId: claim.operation.sessionId,
        fence: { epoch: work.epoch, goalVersion: work.goalVersion }, ...metadata });
    });
    this.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: operation.id, sessionId: claim.operation.sessionId, ...execution });
    this.operation = { workId: work.id, operationId: operation.id };
  }
  async partial() {
    this.event({ type: 'ARTIFACT', artifact: { id: 'old-material', name: 'old-goal.md', content: '旧目标资料' } });
    if (this.number === 92) {
      await writeFile(join(this.runtimeOptions.workspaceRoot, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node build.cjs' } }));
      await writeFile(join(this.runtimeOptions.workspaceRoot, 'build.cjs'), 'const fs=require("node:fs");fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/cancel-sentinel.txt","真实独占检查材料");console.log("owned validation output")');
    }
    const goal = this.number === 92 ? '新的目标；运行 npm run build' : '新的目标';
    this.event({ type: 'USER_INPUT', text: goal, goal: { text: goal, constraints: [], criteria: ['保留来源并如实交付'], requiredArtifacts: 0 } });
    this.event({ type: 'SETTLE', intentId: this.owner.id });
    const pending = this.engine.pending(this.room.id, this.taskId).find(work => work.kind === 'owner');
    this.owner = this.engine.claim(this.room.id, this.taskId, pending.id);
    this.event({ type: 'DELIVER', workId: this.owner.id, fence: this.owner, attempt: this.owner.attempt,
      text: '全部资料均已处理完成', artifactIds: [], artifacts: [{ name: 'new-goal.md', content: '全部资料均已处理完成' }] });
    const checkPending = this.engine.pending(this.room.id, this.taskId).find(work => work.kind === 'check');
    if (checkPending) {
      this.check = this.engine.claim(this.room.id, this.taskId, checkPending.id);
      if (this.number === 92) {
        const work = this.check;
        assert.equal(work.payload.verification.status, 'required');
        const action = structuredClone(work.payload.verification.action);
        const request = this.engine.requestLocal(this.room.id, this.taskId, work.id, work.attempt, action, [],
          this.runtime.workspaceId(work, this.engine.localNamespace(this.room.id, this.taskId)));
        const claim = this.engine.claimLocal(this.room.id, this.taskId, work.id, request.id, work.attempt); assert(claim.response.ok);
        const execution = await this.runtime.execute(work, claim.operation, new AbortController().signal, metadata => {
          this.event({ type: 'LOCAL_STARTED', intentId: work.id, operationId: request.id, sessionId: claim.operation.sessionId, ...metadata });
        }, undefined, { roomId: this.room.id, taskId: this.taskId }, metadata => {
          this.event({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: request.id, sessionId: claim.operation.sessionId,
            fence: { epoch: work.epoch, goalVersion: work.goalVersion }, ...metadata });
        });
        assert(execution.result.ok && execution.effectsKnown);
        this.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: request.id, sessionId: claim.operation.sessionId, ...execution });
        this.event({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt });
        const revisionRequest = this.engine.requestLocal(this.room.id, this.taskId, work.id, work.attempt,
          { type: 'verifyWorkspace', expectedRevision: execution.workspaceRevision }, [],
          this.runtime.workspaceId(work, this.engine.localNamespace(this.room.id, this.taskId)));
        const revisionClaim = this.engine.claimLocal(this.room.id, this.taskId, work.id, revisionRequest.id, work.attempt); assert(revisionClaim.response.ok);
        const verified = await this.runtime.execute(work, revisionClaim.operation, new AbortController().signal, () => {});
        assert(verified.result.ok);
        this.event({ type: 'LOCAL_RESULT', intentId: work.id, operationId: revisionRequest.id, sessionId: revisionClaim.operation.sessionId, ...verified });
      }
      if (this.number !== 92) this.event({ type: 'CONSUME', intentId: this.check.id, fence: this.check, attempt: this.check.attempt });
      this.event({ type: 'CHECK_RESULT', workId: this.check.id, fence: this.check, attempt: this.check.attempt,
        candidateRevision: this.context().candidate.revision, resultId: 'unverified-check',
        criteriaResults: this.context().candidate.acceptance.criteria.map(item => ({ criterionId: item.id,
          status: this.number === 96 ? 'passed' : 'unverified', reason: '保留明确核验结果' })) });
    }
    assert.equal(this.context().outcome, this.number === 96 ? 'complete' : 'partial');
    if (this.number === 92) {
      const inventory = await this.runtime.planRoomCleanup({ roomId: this.room.id, tasks: [this.engine.view(this.room.id, this.taskId)], quiescent: true });
      assert(inventory.complete && inventory.executionsSettled);
      const copy = inventory.assets.find(asset => asset.kind === 'copy' && asset.owner.workId === this.check.id && asset.identity !== null);
      assert(copy); this.cancelOwnedFile = join(this.runtimeOptions.dataRoot, copy.path, 'reports/cancel-sentinel.txt');
      this.facts.cancelOwnedHash = createHash('sha256').update(await readFile(this.cancelOwnedFile)).digest('hex');
      this.facts.cancelWork = this.context().intents.map(work => ({ id: work.id, status: work.status, attempt: work.attempt }));
    }
  }
  async prepareHostApproval() {
    this.hostMarker = join(this.outer, 'unapproved-host-started.txt'); this.hostStarted = 0;
    const action = { type: 'runCli', executable: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started")', this.hostMarker],
      execution: 'host', reason: '验证等待明确宿主权限；未批准不得启动' };
    const work = this.owner;
    const op = this.engine.requestLocal(this.room.id, this.taskId, work.id, work.attempt, action, [],
      this.runtime.workspaceId(work, this.engine.localNamespace(this.room.id, this.taskId)));
    const claim = this.engine.claimLocal(this.room.id, this.taskId, work.id, op.id, work.attempt); assert(claim.response.ok);
    const execution = await this.runtime.execute(work, claim.operation, new AbortController().signal, () => { this.hostStarted++; },
      undefined, { roomId: this.room.id, taskId: this.taskId }, metadata => {
        this.event({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: op.id, sessionId: claim.operation.sessionId,
          fence: { epoch: work.epoch, goalVersion: work.goalVersion }, ...metadata });
      });
    assert(execution.approval); this.approval = execution.approval;
    this.event({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: op.id,
      sessionId: claim.operation.sessionId, approval: execution.approval, fence: work });
    this.operation = { workId: work.id, operationId: op.id };
    this.facts.approvalGate = this.snapshot().blockers.find(gate => gate.operation?.approvalId === this.approval.id).id;
    assert.equal(this.hostStarted, 0); assert(!existsSync(this.hostMarker));
  }
  async open() {
    this.outer = await mkdtemp(join(tmpdir(), 'squad-ui-case-'));
    await mkdir(join(this.outer, 'source'));
    this.runtimeOptions = { dataRoot: join(this.outer, 'runtime'), workspaceRoot: join(this.outer, 'source'), skillRoots: [],
      backend: { available: true, execute: async (input, signal, observe) => ({ ...await runProcess(input, signal, observe), effectsKnown: this.number === 92 }) } };
    this.runtime = await LocalRuntime.create(this.runtimeOptions);
    const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
    config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 60_000, cancelGraceMs: 1000 };
    if ([84, 100].includes(this.number)) config.resilience.automaticTimeoutMs = 1000;
    if (this.number === 107) config.resilience.automaticTimeoutMs = 5000;
    if (this.number === 85) config.limits.ordinary = 1;
    this.host = await new ResilientWorkspaceBrowserFixture(this.id, { config, localRuntime: this.runtime,
      reopenLocalRuntime: async () => { this.runtime = await LocalRuntime.create(this.runtimeOptions); return this.runtime; },
      ...(this.number === 116 ? { adapter: workspaceWaitAdapter(this) } : {}),
      ...(this.number === 86 ? { adapter: { execute: async () => ({ type: 'askUser', question: '修复后仍需你明确回复' }) } } : {}) }).open();
    this.page = this.host.page; this.room = await this.host.createRoom(); this.startTask();
    if (this.number === 119) { await prepareArchiveDeleteFeedback(this); return; }
    if (this.number === 116) { await prepareWorkspaceWait(this); return; }
    if (this.number === 85) this.event({ type: 'CONSUME', intentId: this.owner.id, fence: this.owner, attempt: this.owner.attempt });
    if ([83, 93, 101].includes(this.number)) await this.unknownOperation();
    if (this.number === 107) await this.prepareHostApproval();
    else if ([87, 88, 89].includes(this.number) || this.number >= 92 && this.number <= 101 && ![93, 98, 101].includes(this.number)) await this.partial();
    else if (this.number === 86) {
      assert(this.engine.executionNotStarted(this.room.id, this.taskId, this.owner, '执行边界确认未发出外部请求').ok);
      const pending = this.engine.pending(this.room.id, this.taskId).find(work => work.kind === 'owner');
      this.owner = this.engine.claim(this.room.id, this.taskId, pending.id);
    } else this.waitHuman();
    if (this.number === 97) {
      this.facts.deletionInventory = await this.runtime.planRoomCleanup({ roomId: this.room.id,
        tasks: [this.engine.view(this.room.id, this.taskId)], quiescent: true });
      assert(this.facts.deletionInventory.complete && this.facts.deletionInventory.executionsSettled);
    }
    if ([90, 94, 96, 97, 99].includes(this.number)) {
      this.other = this.host.service.createRoom('会话乙');
      this.otherDraft = '会话乙自己的草稿';
      this.otherTask = this.host.service.submit(this.other.id, { id: randomUUID(), text: '会话乙自己的目标' }).taskId;
      const next = this.engine.pending(this.other.id, this.otherTask)[0];
      const owner = this.engine.claim(this.other.id, this.otherTask, next.id);
      assert(this.engine.send(this.other.id, this.otherTask, { id: 'other-human', at: Date.now(), type: 'WAIT_USER',
        workId: owner.id, fence: owner, attempt: owner.attempt, question: '乙需要自己的明确回复' }).ok);
      this.other = this.host.service.snapshot(this.other.id).room;
    }
    await this.page.reload();
    await this.page.getByRole('heading', { name: this.room.title, exact: true, includeHidden: true }).waitFor();
    if (this.other) {
      await this.dismissFresh(); await this.host.selectRoom(this.other); await this.dismissFresh();
      await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill(this.otherDraft);
      await this.host.selectRoom(this.room); await this.dismissFresh();
    }
    if (this.number >= 92 && this.number <= 99 || this.number === 101) {
      await this.dismissFresh();
      await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill('目标会话的未发送草稿');
      if (this.number === 97) this.archiveResponse = await this.host.holdResponse('**/archive');
      await this.page.getByRole('button', { name: `归档群聊 ${this.room.title}`, exact: true }).click();
      if (this.archiveResponse) await this.archiveResponse.entered;
      else {
        await this.host.until(() => this.page.evaluate(() => localStorage.getItem('squad-room')),
          id => id !== this.room.id, 'archive selects a valid other room or empty page');
        await this.dismissFresh();
      }
      await this.page.getByRole('button', { name: /^已归档/ }).click();
      await this.page.getByRole('navigation', { name: '归档群聊列表', exact: true }).getByRole('button', { name: this.room.title, exact: true, includeHidden: true }).click();
      await this.page.getByRole('heading', { name: this.room.title, exact: true, includeHidden: true }).waitFor();
      await this.dismissFresh();
      if (this.number === 92) {
        await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
        await this.page.getByText(/^历史产物（/).click();
        await this.page.getByRole('button', { name: '查看 old-goal.md', exact: true }).click();
        await this.page.getByRole('heading', { name: 'old-goal.md', exact: true }).waitFor();
      }
      if (this.number === 96) {
        await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
        await this.page.getByRole('complementary', { name: '任务详情', exact: true }).getByRole('button', { name: '查看 new-goal.md', exact: true }).click();
        await this.page.getByRole('button', { name: '引用到新任务', exact: true }).click();
        await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
        assert(await this.page.getByRole('button', { name: '移除产物引用', exact: true }).count());
      }
    }
    if (this.number === 94) {
      const original = this.runtime.planRoomCleanup.bind(this.runtime); let fail = true;
      this.runtime.planRoomCleanup = async input => { if (fail) { fail = false; throw new Error('UI_CLEANUP_PREPARATION_FAILED'); } return original(input); };
    }
    if ([96, 98].includes(this.number)) {
      this.prepareGate = barrier(); this.prepareEntered = barrier();
      const original = this.runtime.planRoomCleanup.bind(this.runtime);
      this.runtime.planRoomCleanup = async input => { this.prepareEntered.release(); await this.prepareGate.promise; return original(input); };
    }
    await this.host.capture('given');
  }
  async additional() { assert(this.other); }
  async dismiss() {
    await this.page.keyboard.press('Escape');
  }
  async dismissFresh() {
    const roomId = await this.page.evaluate(() => localStorage.getItem('squad-room'));
    if (roomId && this.host.service.snapshot(roomId).blockers?.some(gate => gate.status === 'open'))
      await this.page.getByRole('button', { name: '暂时关闭处理提示', exact: true }).waitFor();
    await this.dismiss();
  }
  async human() {
    await this.page.getByRole('button', { name: /需要你的回复：请选择当前任务的处理方式/, includeHidden: true }).waitFor();
    if (await this.page.getByRole('button', { name: '暂时关闭处理提示', exact: true }).count()) return;
    await this.page.getByRole('button', { name: /需要你的回复：请选择当前任务的处理方式/ }).click();
  }
  async deletion() {
    await this.page.getByRole('button', { name: `删除归档群聊 ${this.room.title}`, exact: true }).click();
    await this.page.getByRole('dialog').getByRole('button', { name: '确认永久删除', exact: true }).waitFor();
  }
  async prepareDeletionConfirmation() {
    await this.deletion(); this.facts.confirmation = await this.page.getByRole('dialog').textContent();
  }
  async verifyDeletionConfirmation() {
    assert(this.facts.confirmation.includes(this.room.title));
    for (const text of ['任务', '消息', '产物', '执行记录', '无法恢复', '未完成工作', '其他会话和共享工程不会删除'])
      assert(this.facts.confirmation.includes(text), text);
    assert.equal(this.host.posts.filter(post => post.path.endsWith('/delete')).length, 0);
    await this.page.getByRole('button', { name: '取消删除', exact: true }).waitFor();
  }
  async cancelDeletionConfirmation() {
    await this.page.getByRole('button', { name: '取消删除', exact: true }).click();
  }
  async closeDeletionProgress() {
    const close = this.page.getByRole('button', { name: '关闭删除提示', exact: true });
    if (await close.isVisible()) await close.click();
  }
  async verifyDeletionAfterServiceRestart() {
    await this.host.restartService();
    const room = await this.host.get('/rooms/' + encodeURIComponent(this.room.id));
    assert.equal(room.status, 410); assert.equal(room.data.code, 'ROOM_DELETED');
    const list = await this.host.get('/rooms'); assert(!list.data.rooms.some(item => item.id === this.room.id));
    const stored = this.host.readDatabase();
    assert(!stored.rooms.some(item => item.id === this.room.id)); assert(!stored.webRooms.some(item => item.id === this.room.id));
    assert(!stored.events.some(item => item.roomId === this.room.id)); assert(!stored.receipts.some(item => item.room_id === this.room.id));
    assert(await this.runtime.verifyRoomCleanup(this.facts.deletionInventory));
    for (const asset of this.facts.deletionInventory.assets) assert(!existsSync(join(this.runtimeOptions.dataRoot, asset.path)));
    await this.page.reload();
    await this.page.getByRole('heading', { name: this.other.title, exact: true, includeHidden: true }).waitFor();
    assert.equal(await this.page.getByRole('button', { name: this.room.title, exact: true, includeHidden: true }).count(), 0);
    const tombstones = await this.page.evaluate(() => JSON.parse(localStorage.getItem('squad-deleted-rooms') ?? '[]'));
    assert(tombstones.some(item => item.roomId === this.room.id));
    await this.host.capture('after-service-restart');
    await writeFile(join(this.host.evidence, 'sqlite-after-service-restart.json'), JSON.stringify(stored, null, 2));
  }
  async act() {
    if (this.number === 119) return actArchiveDeleteFeedback(this);
    const n = this.number;
    if (n === 116) return actWorkspaceWait(this);
    if (n === 81) { await this.dismiss(); this.facts.before = this.snapshot().blockers; await this.page.reload(); }
    if (n === 82) {
      await this.human(); this.facts.old = this.snapshot().blockers.find(gate => gate.scope !== 'cleanup');
      const stale = await this.host.holdResponse('**/api/rooms/' + this.room.id, request => request.method() === 'GET');
      await stale.entered;
      this.event({ type: 'HUMAN_GATE_DECISION', gateId: this.facts.old.id, decision: 'reply', text: '宿主已结算原请求，下一项需要新决定' });
      const work = this.engine.pending(this.room.id, this.taskId).find(item => item.kind === 'owner');
      if (work) { this.owner = this.engine.claim(this.room.id, this.taskId, work.id); this.waitHuman(); }
      await this.page.getByRole('textbox', { name: '决定回复' }).fill('明确选择保留已有内容');
      await this.page.getByRole('button', { name: '回复', exact: true }).click();
      this.facts.rejected = await this.page.getByRole('alert').first().textContent();
      await stale.release();
      await this.page.reload(); await this.human();
      await this.page.getByRole('textbox', { name: '决定回复' }).fill('明确选择保留已有内容');
      this.facts.currentGate = this.snapshot().blockers.find(gate => gate.scope !== 'cleanup').id;
      const current = await this.host.holdResponse('**/blocker-decision');
      await this.page.getByRole('button', { name: '回复', exact: true }).dblclick();
      await current.entered; await current.release();
    }
    if (n === 83) { await this.human(); await this.page.getByRole('button', { name: '跳过', exact: true }).click(); }
    if (n === 84) {
      await this.host.until(() => Date.now(), now => now >= this.context().resilience.window.hardDeadline, 'actual window elapsed');
      this.event({ type: 'SUPERVISE', at: this.context().resilience.window.hardDeadline, trigger: 'timer' });
      await this.page.reload();
    }
    if (n === 85) {
      await this.dismiss();
      await this.page.getByRole('textbox', { name: '群聊消息输入框' }).fill('保留的输入');
      await this.page.getByRole('spinbutton', { name: '追加执行额度', exact: true }).fill('-1');
      await this.page.getByRole('button', { name: '增加额度并继续', exact: true }).click();
      this.facts.invalid = await this.page.getByRole('alert').first().textContent();
      await this.page.getByRole('spinbutton', { name: '追加执行额度', exact: true }).fill('5');
      const held = await this.host.holdResponse('**/messages');
      await this.page.getByRole('button', { name: '增加额度并继续', exact: true }).dblclick();
      await held.entered; await held.release();
    }
    if (n === 86) {
      await this.page.getByText('正在修复推进', { exact: true }).waitFor();
      await this.page.route('**/api/rooms/**', route => route.abort());
      await this.page.getByText('连接中断', { exact: true }).first().waitFor();
      this.facts.offline = true; await this.page.unroute('**/api/rooms/**');
      this.originalNextWake = this.engine.nextWake.bind(this.engine);
      this.engine.nextWake = roomId => { if (roomId === this.room.id) throw new Error('公开宿主计时入口的可恢复故障'); return this.originalNextWake(roomId); };
      await this.host.until(() => this.snapshot().tasks.find(task => task.id === this.taskId).supervision.status,
        status => status === 'faulted', 'real timer routes a host failure');
      await this.page.reload(); await this.page.getByText('执行服务故障', { exact: true }).waitFor();
      this.facts.faultVisible = true;
      this.engine.nextWake = this.originalNextWake;
      await this.host.until(() => this.snapshot().tasks.find(task => task.id === this.taskId).supervision.status,
        status => status !== 'faulted', 'real timer recovers the host fault');
      await this.page.getByText('等待你的回复', { exact: true }).waitFor();
      this.facts.waitingVisible = true;
    }
    if ([87, 88, 89].includes(n)) {
      await this.page.locator('header').getByRole('button', { name: '查看任务详情', exact: true }).click();
      await this.page.getByRole('region', { name: '冻结交付说明' }).waitFor();
      if (n === 87) await this.page.getByText(/^历史产物（/).click();
      if (n === 88 || n === 89) this.facts.download = await this.host.download(this.page.getByRole('button', { name: '下载最终宿主报告', exact: true }), 'frozen-report.md');
      if (n === 88) await this.page.getByRole('complementary', { name: '任务详情', exact: true }).getByRole('button', { name: '查看 new-goal.md', exact: true }).click();
      if (n === 89 && this.check) {
        const c = this.context(); const reply = this.engine.send(this.room.id, this.taskId, { type: 'CHECK_RESULT', id: 'late-check', at: Date.now(),
          workId: this.check.id, attempt: this.check.attempt, fence: this.check, resultId: 'late-check', candidateRevision: c.candidate.revision,
          criteriaResults: c.candidate.acceptance.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) });
        this.facts.lateReply = reply;
        this.facts.secondDownload = await this.host.download(this.page.getByRole('button', { name: '下载最终宿主报告', exact: true }), 'frozen-report-again.md');
      }
    }
    if (n === 90) {
      await this.human(); const held = await this.host.holdResponse('**/blocker-decision');
      await this.page.getByRole('textbox', { name: '决定回复' }).fill('明确回复甲');
      await this.page.getByRole('button', { name: '回复', exact: true }).click(); await held.entered;
      await this.dismiss(); await this.page.getByRole('button', { name: this.other.title, exact: true }).click();
      await held.release(); this.facts.held = true;
    }
    if (n === 91) {
      await this.human(); let fail = true;
      await this.page.route('**/blocker-decision', route => { if (fail) { fail = false; return route.abort(); } return route.continue(); });
      await this.page.getByRole('textbox', { name: '决定回复' }).fill('明确回复并保留原结果');
      await this.page.getByRole('button', { name: '回复', exact: true }).click();
      await this.page.getByRole('alert').first().waitFor();
      await this.page.getByRole('button', { name: '回复', exact: true }).focus(); await this.page.keyboard.press('Enter');
    }
    if (n >= 92 && n <= 99 || n === 101) {
      await this.prepareDeletionConfirmation();
      if (n === 97) {
        this.oldList = await this.host.holdResponse('**/api/rooms', request => request.method() === 'GET');
        this.oldSnapshot = await this.host.holdResponse('**/api/rooms/' + this.room.id, request => request.method() === 'GET');
        await Promise.all([this.oldList.entered, this.oldSnapshot.entered]);
      }
      if (n === 99) {
        let fail = true;
        await this.page.route('**/delete', route => { if (fail) { fail = false; return route.abort(); } return route.continue(); });
        await this.page.getByRole('button', { name: '确认永久删除', exact: true }).click();
        this.facts.firstDeleteFailure = await this.page.getByRole('alert').first().textContent();
        this.deleteResponse = await this.host.holdResponse('**/delete');
      }
      if (n === 92) await this.cancelDeletionConfirmation();
      else if (n === 95) {
        this.host.service.setRoomArchived(this.room.id, 'concurrent-restore', false);
        await this.page.getByRole('button', { name: '确认永久删除', exact: true }).click();
        this.facts.rejected = await this.page.getByRole('alert').first().textContent();
      } else {
        await this.page.getByRole('button', { name: '确认永久删除', exact: true }).click();
        if (n === 96) {
          await this.prepareEntered.promise;
          await this.page.keyboard.press('Escape');
          await this.page.getByRole('button', { name: '打开状态机调试', exact: true }).click();
          await this.page.getByRole('button', { name: '关闭状态机调试', exact: true }).waitFor();
          this.facts.debugWasOpen = true; this.prepareGate.release();
        }
        if (n === 99) {
          await this.deleteResponse.entered;
          await this.page.keyboard.press('Escape');
          await this.page.getByRole('button', { name: '群聊', exact: true }).click();
          await this.host.selectRoom(this.other); await this.dismissFresh();
          await this.deleteResponse.release();
        }
        if ([93, 101].includes(n)) {
          await this.host.until(() => this.snapshot().room.deletion?.status, status => status === 'waiting', 'deletion waiting persisted');
          await this.closeDeletionProgress();
          await this.page.getByRole('button', { name: '查看删除状态 ' + this.room.title, exact: true }).click();
          this.facts.progress = await this.page.getByRole('dialog').textContent();
          await this.page.getByRole('button', { name: '关闭删除提示', exact: true }).click();
          await this.page.getByRole('button', { name: /执行效果等待核对：/, includeHidden: true }).waitFor();
          await this.dismiss();
          await this.page.getByRole('button', { name: /执行效果等待核对：/ }).click();
          const response = this.page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/operation-review'));
          await this.page.getByRole('button', { name: '核对执行', exact: true }).click();
          this.facts.reviewResponse = await (await response).json();
          await this.page.getByLabel('原执行回执和文件清单').waitFor();
          this.facts.review = await this.page.getByLabel('原执行回执和文件清单').textContent();
          if (n === 101) {
            assert.equal((await this.host.get('/rooms/' + this.room.id)).status, 200);
            assert.equal(this.context().intents.find(work => work.id === this.operation.workId).localOperations[0].status, 'uncertain');
            await this.page.getByRole('button', { name: '确认已核对执行效果', exact: true }).click();
          }
        }
        if (n === 94) {
          await this.host.until(() => this.snapshot().room.deletion?.status, value => value === 'paused', 'cleanup paused');
          await this.page.reload();
          await this.page.getByRole('button', { name: '查看删除状态 ' + this.room.title, exact: true }).click();
          this.facts.progress = await this.page.getByRole('dialog').textContent();
          await this.page.getByRole('button', { name: '重试清理', exact: true }).click();
        }
        if (n === 98) {
          await this.prepareEntered.promise;
          await this.page.keyboard.press('Escape');
          await this.page.getByRole('textbox', { name: '群聊消息输入框' }).waitFor();
          await this.host.until(() => this.page.getByRole('textbox', { name: '群聊消息输入框' }).isDisabled(), Boolean, 'deletion blocks composer');
          this.facts.frozen = true;
        }
        if ([96, 97, 99].includes(n)) {
          await this.host.until(() => this.host.get('/rooms/' + encodeURIComponent(this.room.id)), value => value.status === 410, 'confirmed deleted');
          if (n === 96) {
            await this.host.until(() => this.page.evaluate(() => JSON.parse(localStorage.getItem('squad-deleted-rooms') ?? '[]')),
              rooms => rooms.some(room => room.roomId === this.room.id), 'client receives confirmed deletion before clearing debug state');
            await this.host.until(() => this.page.getByRole('button', { name: '关闭状态机调试', exact: true }).count(), count => count === 0, 'target debug selection is cleared');
            await this.dismiss();
          }
          if (n === 97) {
            await this.closeDeletionProgress();
            await this.page.getByRole('button', { name: '群聊', exact: true }).click();
            await this.host.selectRoom(this.other); await this.dismissFresh();
            await this.host.until(() => this.page.evaluate(() => JSON.parse(localStorage.getItem('squad-deleted-rooms') ?? '[]')),
              rooms => rooms.some(room => room.roomId === this.room.id), 'fresh other-room snapshot commits deletion before old responses');
            await this.oldList.release(); await this.oldSnapshot.release(); await this.archiveResponse.release();
          }
          if (this.other) {
            const selected = await this.page.evaluate(() => localStorage.getItem('squad-room'));
            if (selected !== this.other.id) {
              await this.page.getByRole('button', { name: '群聊', exact: true }).click();
              await this.host.selectRoom(this.other); await this.dismissFresh();
            } else await this.dismiss();
            assert.equal(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), this.otherDraft);
          }
          this.facts.otherDraftPreserved = true;
          if (n === 97) {
            assert.equal(await this.page.getByRole('alert').filter({ hasText: '该群聊已删除' }).count(), 0,
              'a late operation for a deleted room must not publish an error into the current room');
            await this.page.reload();
          }
        }
      }
    }
    if (n === 100) {
      await this.host.until(() => Date.now(), now => now >= this.context().resilience.window.hardDeadline, 'old automatic window elapsed');
      this.facts.oldWindow = structuredClone(this.context().resilience.window);
      await this.page.getByRole('button', { name: '继续执行', exact: true }).click();
      await this.page.getByRole('button', { name: '取消继续', exact: true }).click();
      assert.deepEqual(this.context().resilience.window, this.facts.oldWindow);
      assert.equal(this.host.posts.filter(post => post.body.intent === 'continue').length, 0);
      await this.page.getByRole('button', { name: '继续执行', exact: true }).click();
      await this.page.getByRole('button', { name: '沿用原窗口继续', exact: true }).click();
      await this.host.until(() => this.host.posts.filter(post => post.body.intent === 'continue').length, count => count === 1, 'ordinary continue submitted');
      this.facts.expiredRejection = await this.page.getByRole('dialog').getByRole('alert').textContent();
      assert(this.facts.expiredRejection.includes('WINDOW_EXPIRED'));
      assert.deepEqual(this.context().resilience.window, this.facts.oldWindow);
      await this.page.getByRole('spinbutton', { name: '新处理时长（分钟）', exact: true }).fill('15');
      await this.page.getByRole('button', { name: '授权新窗口并继续', exact: true }).click();
    }
    if (n === 107) {
      const prompt = this.page.getByRole('dialog', { name: '需要你的回复', exact: true });
      const exactApproval = this.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true });
      await exactApproval.getByLabel('请求执行的完整命令').waitFor();
      assert((await exactApproval.getByLabel('请求执行的完整命令').textContent()).includes(this.hostMarker));
      assert.equal(await this.page.getByRole('dialog').count(), 1, 'the same permission request must not create two automatic dialogs');
      assert.equal(await exactApproval.getByRole('button', { name: '核对执行', exact: true }).count(), 0);
      this.facts.noUncertainReview = true;
      await this.dismiss(); await this.page.keyboard.press('Escape');
      assert.equal(this.host.posts.filter(post => post.path.endsWith('/host-approval') || post.path.endsWith('/blocker-decision')).length, 0);
      assert.equal(this.context().resilience.gates.find(gate => gate.id === this.facts.approvalGate).status, 'open');
      await this.host.until(() => Date.now(), now => now >= Math.max(this.approval.expiresAt, this.context().resilience.window.hardDeadline), 'actual approval token and processing window expire');
      this.engine.tick(this.room.id);
      assert.equal(this.context().resilience.gates.find(gate => gate.id === this.facts.approvalGate).status, 'open');
      assert.equal(this.engine.view(this.room.id, this.taskId).phase, 'waitingHuman');
      const expiredOperation = this.context().intents.find(work => work.id === this.operation.workId).localOperations.find(op => op.id === this.operation.operationId);
      assert.equal(expiredOperation.status, 'failed'); assert.equal(expiredOperation.result.code, 'HOST_APPROVAL_EXPIRED');
      this.facts.expiredOperation = structuredClone(expiredOperation.result);
      assert.equal(this.hostStarted, 0); assert(!existsSync(this.hostMarker)); this.facts.openAfterExpiry = true;
      await prompt.getByText(/请在宿主授权卡片核对完整命令/).waitFor();
      assert.equal(await prompt.getByRole('button', { name: '核对执行', exact: true }).count(), 0);
      assert.equal(await prompt.getByRole('button', { name: '查看宿主授权卡片', exact: true }).count(), 0);
      await prompt.getByText(/原授权当前不可用/).waitFor();
      await prompt.getByRole('button', { name: '跳过此命令', exact: true }).click();
    }
    await this.host.capture('when');
  }
  async verify() {
    if (this.number === 119) return verifyArchiveDeleteFeedback(this);
    const n = this.number;
    if (n === 116) return verifyWorkspaceWait(this);
    if (n === 81 || n === 84) {
      await this.page.getByRole('dialog').waitFor();
      assert(this.snapshot().blockers.some(gate => gate.status === 'open' && gate.requiredHuman));
      assert.equal(this.host.posts.filter(post => post.path.endsWith('blocker-decision')).length, 0);
      if (n === 84) {
        assert.equal(this.context().resilience.window.failure.code, 'WINDOW_EXPIRED');
        assert(this.context().resilience.window.hardDeadline <= this.context().resilience.lastSupervisedAt);
        await this.page.getByRole('dialog').getByText('自动处理窗口已耗尽，仍等待你的明确回复。', { exact: true }).waitFor();
      }
    }
    if ([82, 91].includes(n)) {
      await this.host.until(() => this.context().resilience.gates, gates => gates.some(gate => gate.status === 'answered'), 'human decision committed');
      assert(n === 82 ? this.facts.rejected : true);
      const posts = this.host.posts.filter(post => post.path.endsWith('blocker-decision'));
      if (n === 91) { assert.equal(posts.length, 2); assert.equal(posts[0].body.id, posts[1].body.id); }
      assert.equal(this.context().resilience.gates.filter(gate => gate.status === 'answered'
        && (n !== 82 || gate.id === this.facts.currentGate)).length, 1);
      if (n === 82) assert.equal(posts.filter(post => post.body.blockerId === this.facts.currentGate).length, 1);
    }
    if (n === 83) {
      await this.host.until(() => this.context().resilience.skips.length, count => count === 1, 'one explicit content skip');
      assert(this.context().resilience.cleanup.some(item => item.state === 'pending'));
      await this.page.getByText(/已按你的明确授权跳过内容：/).waitFor();
      await this.page.getByRole('button', { name: /执行效果等待核对：/, includeHidden: true }).waitFor();
      await this.dismiss();
      await this.page.getByRole('button', { name: /执行效果等待核对：/ }).waitFor();
      assert.notEqual(this.context().intents.find(work => work.id === this.operation.workId).localOperations[0].status, 'succeeded');
    }
    if (n === 85) {
      assert(this.facts.invalid.includes('正整数'));
      await this.host.until(() => this.context().config.limits.ordinary, count => count === 6, 'explicit budget reached engine');
      assert.equal(this.host.posts.filter(post => post.path.endsWith('/messages') && post.body.extraOrdinary === 5).length, 1);
    }
    if (n === 86) {
      assert(this.facts.offline && this.facts.faultVisible && this.facts.waitingVisible);
      assert(this.context().trace.some(trace => trace.event === 'SUPERVISE'));
      await this.page.getByText('等待你的回复', { exact: true }).waitFor();
    }
    if (n === 87) {
      await this.page.getByRole('button', { name: '查看 old-goal.md', exact: true }).waitFor();
      assert(!this.snapshot().tasks.find(task => task.id === this.taskId).delivery.currentArtifactIds.includes('old-material'));
      await this.page.getByText('部分交付，仍有缺失或未核验内容', { exact: true }).waitFor();
    }
    if (n === 88) {
      for (const word of ['partial', '目标版本', '未核验', '失败', '跳过', '未决']) assert(this.facts.download.includes(word), word);
      await this.page.getByText(/原始产物或历史资料；核验结论以最终宿主报告为准/).waitFor();
      assert.equal(this.context().artifacts.find(artifact => artifact.name === 'new-goal.md').content, '全部资料均已处理完成');
    }
    if (n === 89) { assert.equal(this.facts.download, this.facts.secondDownload); assert.equal(this.context().outcome, 'partial'); }
    if (n === 90) {
      assert(this.facts.held); await this.page.getByRole('heading', { name: this.other.title, exact: true, includeHidden: true }).waitFor();
      assert(this.context().resilience.gates.some(gate => gate.status === 'answered'));
      assert(this.engine.view(this.other.id, this.otherTask).context.resilience.gates.some(gate => gate.status === 'open'));
      await this.page.getByRole('button', { name: /需要你的回复：乙需要自己的明确回复/, includeHidden: true }).waitFor();
      await this.dismiss();
      await this.page.getByRole('button', { name: /需要你的回复：乙需要自己的明确回复/ }).waitFor();
    }
    if (n === 92) {
      assert(this.facts.confirmation.includes('无法恢复')); assert(this.facts.confirmation.includes('未完成工作'));
      assert.equal(this.host.posts.filter(post => post.path.endsWith('/delete')).length, 0);
      assert.equal(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), '目标会话的未发送草稿');
      assert(this.snapshot().tasks.length > 0);
      assert.equal(this.snapshot().room.archived, true);
      assert.equal(createHash('sha256').update(await readFile(this.cancelOwnedFile)).digest('hex'), this.facts.cancelOwnedHash);
      assert.deepEqual(this.context().intents.map(work => ({ id: work.id, status: work.status, attempt: work.attempt })), this.facts.cancelWork);
      await this.page.getByRole('heading', { name: 'old-goal.md', exact: true }).waitFor();
    }
    if (n === 93) {
      assert(this.facts.progress.includes('核对') || this.facts.progress.includes('未决'));
      assert(this.facts.review.includes('原操作已退出'));
      assert(this.snapshot().room.deletion);
      assert.equal((await this.host.get('/rooms/' + encodeURIComponent(this.room.id))).status, 200);
    }
    if (n === 95) {
      assert(this.facts.rejected); assert.equal(this.snapshot().room.archived, false); assert(!this.snapshot().room.deletion);
      assert.equal(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), '目标会话的未发送草稿');
    }
    if ([94, 96, 97, 99, 101].includes(n)) {
      const result = await this.host.until(() => this.host.get('/rooms/' + encodeURIComponent(this.room.id)), value => value.status === 410, 'deleted room unreadable');
      assert.equal(result.data.code, 'ROOM_DELETED');
      const list = await this.host.get('/rooms'); assert(!list.data.rooms.some(room => room.id === this.room.id));
      const stored = this.host.readDatabase(); assert(!stored.rooms.some(room => room.id === this.room.id));
      assert(!stored.webRooms.some(room => room.id === this.room.id)); assert(!stored.receipts.some(receipt => receipt.room_id === this.room.id));
      assert(!stored.events.some(event => event.roomId === this.room.id));
      const tombstones = await this.host.until(() => this.page.evaluate(() => JSON.parse(localStorage.getItem('squad-deleted-rooms') ?? '[]')),
        rooms => rooms.some(room => room.roomId === this.room.id), 'real client synchronized the tombstone');
      assert(tombstones.some(room => room.roomId === this.room.id));
      assert(!JSON.stringify(tombstones).includes(this.room.title));
      if (this.other) { assert((await this.host.get('/rooms/' + this.other.id)).status === 200); await this.page.getByRole('heading', { name: this.other.title, exact: true, includeHidden: true }).waitFor(); }
      assert.equal(await this.page.getByRole('button', { name: '移除产物引用', exact: true }).count(), 0);
      assert.equal(await this.page.getByRole('button', { name: this.room.title, exact: true, includeHidden: true }).count(), 0);
      if ([96, 99].includes(n)) {
        assert(this.facts.otherDraftPreserved);
        assert.equal(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), this.otherDraft);
        assert(this.engine.view(this.other.id, this.otherTask).context.resilience.gates.some(gate => gate.status === 'open'));
      }
      if (n === 96) { assert(this.facts.debugWasOpen); assert.equal(await this.page.getByRole('button', { name: '关闭状态机调试', exact: true }).count(), 0); }
      if (n === 99) {
        assert(this.facts.firstDeleteFailure);
        const posts = this.host.posts.filter(post => post.path.endsWith('/delete'));
        assert.equal(posts.length, 2); assert.equal(posts[0].body.id, posts[1].body.id);
      }
      if (n === 94) { assert(this.facts.progress.includes('UI_CLEANUP_PREPARATION_FAILED')); assert.equal(this.host.posts.filter(post => post.path.endsWith('/delete-retry')).length, 1); }
      if (n === 101) {
        const posts = this.host.posts.filter(post => post.path.endsWith('/operation-reconcile'));
        assert.equal(posts.length, 1); assert.equal(posts[0].body.taskId, this.taskId);
        assert.equal(posts[0].body.workId, this.operation.workId); assert.equal(posts[0].body.operationId, this.operation.operationId);
        assert.equal(posts[0].body.reviewDigest, this.facts.reviewResponse.reviewDigest);
        assert.equal(this.facts.reviewResponse.processState, 'exited');
      }
    }
    if (n === 98) {
      assert(this.facts.frozen); assert(await this.page.getByRole('textbox', { name: '群聊消息输入框' }).isDisabled());
      assert(await this.page.getByRole('button', { name: `恢复群聊 ${this.room.title}`, exact: true }).isDisabled());
    }
    if (n === 100) {
      await this.host.until(() => this.context().resilience.window.id, id => id !== this.facts.oldWindow.id, 'explicit new window accepted');
      const posts = this.host.posts.filter(post => post.body.intent === 'continue');
      assert.equal(posts.length, 2); assert.equal(posts[0].body.newWindowMs, undefined); assert.equal(posts[1].body.newWindowMs, 900_000);
      assert.equal(this.context().resilience.window.hardDeadline - this.context().resilience.window.openedAt, 900_000);
      assert.equal(this.context().resilience.window.authorizationId, posts[1].body.id);
    }
    if (n === 107) {
      await this.host.until(() => this.context().resilience.gates.find(gate => gate.id === this.facts.approvalGate)?.status,
        status => status === 'skipped', 'only explicit host-command skip resolves the gate');
      const operation = this.context().intents.find(work => work.id === this.operation.workId).localOperations.find(op => op.id === this.operation.operationId);
      assert(this.facts.openAfterExpiry && this.facts.noUncertainReview); assert.equal(operation.status, 'failed');
      assert.deepEqual(operation.result, this.facts.expiredOperation, 'explicit content skip preserves the original approval-expiry receipt');
      assert.equal(operation.startedAt, undefined); assert.notEqual(operation.approval.status, 'approved');
      assert.equal(this.hostStarted, 0); assert(!existsSync(this.hostMarker)); assert.notEqual(this.context().outcome, 'complete');
      const journal = await this.runtime.journal.read(operation.sessionId); assert(journal); assert.equal(journal.identity, undefined);
      assert.equal(this.host.posts.filter(post => post.path.endsWith('/host-approval') || post.path.endsWith('/operation-reconcile')).length, 0);
      const posts = this.host.posts.filter(post => post.path.endsWith('/blocker-decision'));
      assert.equal(posts.length, 1); assert.equal(posts[0].body.actionId, 'skip'); assert.equal(posts[0].body.blockerId, this.facts.approvalGate);
    }
    await this.host.capture('then');
    if (!this.host.completed.includes(this.id)) this.host.completed.push(this.id);
    await writeFile(join(this.host.evidence, 'sqlite-readback.json'), JSON.stringify(this.host.readDatabase(), null, 2));
  }
  async close() {
    if (this.originalNextWake) this.engine.nextWake = this.originalNextWake;
    this.prepareGate?.release();
    await this.host?.close();
    if (this.outer) await rm(this.outer, { recursive: true, force: true });
  }
  markFailed(message) { if (this.host) { this.host.failed = true; this.host.failureReason = message; } }
}
