import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deletionStore, SqliteStore } from '../src/store.js';
import { RuntimeOwnership } from '../src/runtime-ownership.js';
import type { Phase, Outcome, Intent } from '../src/types.js';
import type { RoomDeletionEvent, RuntimeCleanupInventory } from '../src/room-deletion.machine.js';
import { ResilientWorkspaceUICase } from './resilient-workspace-ui-case.mjs';
import { DeletionServiceFixture, deletionUntil, directorySnapshot, deletionStoreAcceptance,
  deletionOperationAcceptance, deletionPathBoundaryAcceptance, deletionHistoricalRuntimeAcceptance,
  deletionOwnedFilesAcceptance, deletionPhysicalPreparationAcceptance, deletionRuntimeProjectionAcceptance, deletionMemoryServiceAcceptance, seedDeletionCopy } from './room-deletion-acceptance.js';

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

export class ArchivedRoomDeletionCase {
  host?: DeletionServiceFixture;
  browser?: ResilientWorkspaceUICase;
  argument = '';
  result: Record<string, unknown> = {};
  actions = 0;
  private sourceBefore?: Record<string, string>;
  private release?: () => void;
  private browserRestartVerified = false;
  constructor(readonly id: string) {}
  async given(argument?: string) {
    if (argument) this.argument = argument;
    if (this.id === 'BT_X01' || this.id === 'BT_X15' || this.id === 'BT_X24') {
      if (!this.browser) {
        this.browser = new ResilientWorkspaceUICase(this.id === 'BT_X01' ? 'BT_Y92' : this.id === 'BT_X15' ? 'BT_Y96' : 'BT_Y97');
        await this.browser.open();
        if (this.id === 'BT_X01') await this.browser.prepareDeletionConfirmation();
      }
    }
  }
  private async open() {
    if (!this.host) this.host = await new DeletionServiceFixture().open('', true, this.id === 'BT_X10');
    return this.host;
  }
  private async finish(host: DeletionServiceFixture) {
    await host.assertGone(); this.result = { ...this.result, deleted: true, dataGone: true, sharedSourcePreserved: true };
  }
  async act(argument?: string) {
    if (argument && !this.argument) this.argument = argument;
    this.actions++;
    if (this.browser) {
      if (this.id === 'BT_X01') await this.browser.cancelDeletionConfirmation();
      else if (this.actions === 1) await this.browser.act();
      return;
    }
    if (this.id === 'BT_X04') { this.result = await deletionOperationAcceptance(this.argument); return; }
    if (this.id === 'BT_X08') { this.result = await deletionOwnedFilesAcceptance(this.argument); return; }
    if (this.id === 'BT_X09') { this.result = await deletionPathBoundaryAcceptance(this.argument); return; }
    if (this.id === 'BT_X21') { this.result = await deletionHistoricalRuntimeAcceptance(); return; }
    if (this.id === 'BT_X22') { this.result = await deletionOwnedFilesAcceptance('尚无完成元数据的准备副本', true); return; }
    if (this.id === 'BT_X26') { if (this.actions === 1) this.result = await deletionPhysicalPreparationAcceptance(); return; }
    if (this.id === 'BT_X27') { if (this.actions === 1) this.result = await deletionMemoryServiceAcceptance(); return; }
    if (this.id === 'BT_X11') { if (this.actions === 1) await this.recovery(); else await this.finish(await this.open()); return; }
    if (this.id === 'BT_X02') { await this.invalid(); return; }
    if (this.id === 'BT_X05' || this.id === 'BT_X13') { await this.barrierRequests(); return; }
    if (this.id === 'BT_X06') { await this.archiveRace(); return; }
    if (this.id === 'BT_X12' || this.id === 'BT_X25') { await this.residue(); return; }
    if (this.id === 'BT_X23') { await this.orphan(); return; }
    const host = await this.open();
    if (this.actions > 1) { await this.finish(host); return; }
    if (this.id === 'BT_X03') await host.seedPhase(this.argument as Phase, this.argument === 'ended' ? 'partial' : null);
    else if (this.id === 'BT_X19') await host.seedPhase('ended', this.argument as Outcome);
    else if (this.id === 'BT_X18') await this.history(host);
    else if (this.id === 'BT_X16') {
      await host.seedPhase('ended', 'partial');
      const other = host.service.engine.submit(host.otherRoom, { id: 'independent-copy', text: '保留用户独立复制内容' }).taskId!;
      assert(host.event({ type: 'ARTIFACT', artifact: { id: 'independent-artifact', name: 'copied.md', content: '独立来源副本' } }, other, host.otherRoom).ok);
      this.result.otherTask = other;
    } else if (this.id === 'BT_X10') {
      await host.seedPhase();
      const engine = host.service.engine, owner = engine.claim(host.room, host.task, engine.pending(host.room, host.task)[0]!.id)!;
      const request = engine.requestLocal(host.room, host.task, owner.id, owner.attempt, { type: 'loadSkill', skillId: host.runtime.catalog().skills[0]!.skillId }, []);
      const op = engine.claimLocal(host.room, host.task, owner.id, request.id, owner.attempt).operation!;
      const loaded = await host.runtime.execute(owner, op, new AbortController().signal, () => assert.fail('Skill read does not spawn a process'), undefined, { roomId: host.room, taskId: host.task });
      assert(loaded.result.ok); assert(host.event({ type: 'LOCAL_RESULT', intentId: owner.id, operationId: op.id, sessionId: op.sessionId!, ...loaded }).ok);
      assert(host.context().intents.find(work => work.id === owner.id)!.localSkills!.length > 0);
      this.result.skillSource = await directorySnapshot(join(host.root, 'skills'));
      this.result.skillSnapshot = await directorySnapshot(join(host.root, 'runtime', 'skills'));
      assert(Object.keys(this.result.skillSnapshot as object).some(key => key.startsWith('bindings/')));
      assert(host.event({ type: 'EXHAUSTED', reason: '保留共享技能快照，只清当前会话引用' }).ok);
    } else await host.seedPhase('ended', 'partial');
    if (this.id === 'BT_X07' || this.id === 'BT_X20') {
      // Ordinary immutable artifacts represent each stored content category; cleanup reads the whole task tree.
      const second = host.service.engine.submit(host.room, { id: 'draft-history', text: '保存其他版本和检查材料' }).taskId!; host.task = second;
      for (const name of ['published.md', 'partial.md', 'failed-draft.md', 'candidate.md', 'old-revision.md', 'background.md', 'source-copy.md', 'frozen-check.md'])
        assert(host.event({ type: 'ARTIFACT', artifact: { id: name, name, content: '必须删除的会话内容:' + name } }).ok);
    }
    this.sourceBefore = await directorySnapshot(host.source);
    if (this.id === 'BT_X10') {
      const store = host.service.engine.store;
      store.transact(host.otherRoom, tx => { assert(tx.acquireWorkspace('other-room-exclusive', 'other-room-owner')); });
      this.result.sharedLease = true;
      this.result.lock = await readFile(join(host.root, 'runtime', 'service.lock'), 'utf8');
    }
    await host.archive(); assert.equal((await host.delete()).status, 202);
    if (this.id === 'BT_X18' && this.argument === '非active任务仍有未完成操作') {
      const waiting = await deletionUntil(() => host.service.engine.roomDeletion(host.room), saved => saved?.value === 'waiting', 'historical unknown held');
      assert(waiting!.context.blockers.length); await host.reviewUnknown();
    }
    await this.finish(host);
    assert.deepEqual(await directorySnapshot(host.source), this.sourceBefore);
    if (this.id === 'BT_X10') {
      assert.equal(await readFile(join(host.root, 'runtime', 'service.lock'), 'utf8'), this.result.lock);
      assert(host.readRows().leases.some(row => (row as { key: string }).key === 'other-room-exclusive'));
      assert.deepEqual(await directorySnapshot(join(host.root, 'skills')), this.result.skillSource);
      assert.deepEqual(await directorySnapshot(join(host.root, 'runtime', 'skills')), this.result.skillSnapshot);
    }
    if (this.id === 'BT_X16') assert(host.service.engine.view(host.otherRoom, String(this.result.otherTask))!.context.artifacts.some(item => item.content === '独立来源副本'));
    if (this.id === 'BT_X14') {
      const tombstone = host.service.engine.roomDeletion(host.room)!;
      assert.deepEqual(tombstone.context.allTasks, []); assert.deepEqual(tombstone.context.tasks, []);
      assert.deepEqual(tombstone.context.assets, []); assert.deepEqual(tombstone.context.sessions, []); assert.deepEqual(tombstone.context.intents, []);
      this.result.minimalTombstone = true;
    }
    if (this.id === 'BT_X17') {
      await host.restart();
      const endpoint = this.argument === '调试记录' ? '/api/debug/rooms/' + host.room
        : this.argument === '产物和导出' ? host.route() + '/artifacts/old' : this.argument === '列表' ? '/api/rooms' : host.route();
      const response = await host.request(endpoint);
      if (this.argument === '列表') assert(!(response.data.rooms as { id: string }[]).some(room => room.id === host.room));
      else assert([404, 410].includes(response.status));
      this.result.unreadable = true;
    }
  }
  private async invalid() {
    const host = await this.open();
    let version = 0;
    if (this.argument !== '会话未归档') version = (await host.archive()).archiveVersion!;
    if (this.argument === '确认后已经恢复') host.service.setRoomArchived(host.room, 'restore-before-confirm', false);
    const before = host.readRows(), source = await directorySnapshot(host.source);
    const target = ['会话不存在', '目标身份不匹配'].includes(this.argument) ? randomUUID() : host.room;
    const response = await host.request(host.route(target) + '/delete', { id: 'invalid-delete',
      expectedArchiveVersion: this.argument === '归档版本过期' ? version + 1 : version,
      ...(this.argument === '请求身份无效' ? { arbitraryPath: '/outside' } : {}) },
      { origin: this.argument === '未明确确认' ? null : host.url });
    assert([400, 403, 404, 409].includes(response.status), JSON.stringify(response));
    assert.deepEqual(host.readRows(), before); assert.deepEqual(await directorySnapshot(host.source), source);
    this.result = { rejected: true, status: response.status, noCleanup: true };
  }
  private async barrierRequests() {
    const host = await this.open(); await host.seedPhase(); await host.archive();
    const hold = barrier(), entered = barrier(); this.release = hold.release;
    const plan = host.runtime.planRoomCleanup.bind(host.runtime);
    host.runtime.planRoomCleanup = async input => { entered.release(); await hold.promise; return plan(input); };
    assert.equal((await host.delete()).status, 202); await entered.promise;
    const path = this.argument === '恢复归档' || this.argument === '旧恢复请求' ? '/restore'
      : this.argument === '批准旧宿主命令' || this.argument === '批准会话授权' || this.argument === '旧审批' ? '/host-approval'
        : this.argument === '申请宿主重试' ? '/host-retry' : '/messages';
    if (this.argument === '领取待执行工作' || this.argument === '派发新分片' || this.argument === '旧执行结果') {
      const current = host.context().intents.find(work => work.kind === 'owner')!;
      const result = host.event(this.argument === '旧执行结果' ? { type: 'DELIVER', workId: current.id, fence: current, text: '不能复活', artifactIds: [] }
        : this.argument === '派发新分片' ? { type: 'DISCUSSION_PLAN', workId: current.id, fence: current, discussionId: 'old', decision: { action: 'review', question: 'invalid', expected: 'invalid', reason: 'old' } }
          : { type: 'CLAIM', intentId: current.id });
      assert.equal(result.code, 'ROOM_DELETING');
    } else if (this.argument === '原删除命令重放' || this.argument === '不同命令重复删除') {
      assert.equal((await host.delete()).status, 202);
    } else if (this.argument === '旧列表轮询' || this.argument === '旧详情响应') {
      const response = await host.request(this.argument === '旧列表轮询' ? '/api/rooms' : host.route()); assert.equal(response.status, 200);
      assert(JSON.stringify(response.data).includes('deletion'));
    } else if (this.argument === '旧归档请求') {
      assert.equal((await host.request(host.route() + '/archive', { id: 'old-archive' })).status, 409);
    } else {
      const body = path === '/messages' ? { id: 'late-business', text: '不得继续执行' }
        : path === '/restore' ? { id: 'late-restore' }
          : path === '/host-retry' ? { id: 'late-retry', taskId: host.task, workId: 'old', operationId: 'old', sourceRequestHash: 'a'.repeat(64) }
            : { id: 'late-approval', taskId: host.task, workId: 'old', operationId: 'old', approvalId: 'old', decision: 'approve' };
      assert([400, 409].includes((await host.request(host.route() + path, body)).status));
    }
    const current = host.context().intents.find(work => work.kind === 'owner')!;
    assert(host.event({ type: 'SETTLE', intentId: current.id, attempt: current.attempt }).ok);
    assert.equal(host.calls, 0); hold.release(); await this.finish(host);
    assert.equal(host.calls, 0); this.result.barrierProtected = true;
  }
  private async archiveRace() {
    const host = await this.open(); const archived = await host.archive();
    if (this.argument === '恢复先提交') {
      host.service.setRoomArchived(host.room, 'restore-first', false);
      const response = await host.request(host.route() + '/delete', { id: 'stale-delete', expectedArchiveVersion: archived.archiveVersion });
      assert.equal(response.status, 409); assert.equal(host.service.rooms().find(room => room.id === host.room)!.archived, false);
      assert.equal(host.service.engine.roomDeletion(host.room), undefined);
    } else {
      assert.equal((await host.delete()).status, 202);
      const restore = await host.request(host.route() + '/restore', { id: 'restore-after-barrier' });
      assert([409, 410].includes(restore.status)); await this.finish(host);
    }
    this.result.versionAdjudicated = true;
  }
  private async history(host: DeletionServiceFixture) {
    if (this.argument === '从未建立任务快照的空会话') return;
    for (const [index, outcome] of (['complete', 'partial', 'failed', 'stopped'] as const).entries())
      await host.seedPhase('ended', outcome, 'old-' + index);
    if (this.argument === '非active任务仍有未完成操作') {
      await host.seedOperation('uncertain'); assert(host.event({ type: 'ARTIFACT', artifact: { id: 'known-partial', name: 'partial.md', content: '确实已保存的独立部分' } }).ok);
      assert(host.event({ type: 'EXHAUSTED', reason: '旧任务逻辑结束，物理责任保留' }).ok);
      const oldTask = host.task; assert(host.service.engine.submit(host.room, { id: 'newer-task', text: '另一任务' }).ok); host.task = oldTask;
      assert.notEqual(host.service.snapshot(host.room).activeTaskId, oldTask);
    } else await host.seedPhase('waitingHuman', null, 'unfinished-latest');
  }
  private async recovery() {
    const host = await this.open();
    if (this.argument === '取消正在执行') {
      await host.seedOperation('uncertain'); await host.archive(); await host.delete();
      await deletionUntil(() => host.service.engine.roomDeletion(host.room), saved => saved?.value === 'waiting', 'unknown retained across restart');
      await host.restart(); await host.reviewUnknown(); await this.finish(host); this.result.resumed = true; return;
    }
    await host.seedOperation('succeeded'); const archived = await host.archive();
    const store = deletionStore(host.service.engine.store);
    if (this.argument === '屏障提交前') {
      (store as SqliteStore).failNextCommit = true;
      assert.throws(() => host.service.engine.requestRoomDeletion(host.room, 'same-delete', archived.archiveVersion!), /Injected commit failure/);
      assert.equal(store.readDeletion(host.room), undefined);
    }
    let saved = host.service.engine.requestRoomDeletion(host.room, 'same-delete', archived.archiveVersion!);
    const step = (event: Record<string, unknown>) => saved = store.stepDeletion(host.room,
      { id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!, ...event } as RoomDeletionEvent);
    const claim = () => { const pending = saved.context.intents.find(intent => intent.status === 'pending')!; assert(pending);
      step({ type: 'CLAIM', intentId: pending.id }); return saved.context.intents.find(intent => intent.id === pending.id)!; };
    const prepare = claim(); host.service.engine.prepareRoomDeletion(host.room, saved.context.deletionId!, prepare, true);
    if (!['屏障提交前', '屏障提交后'].includes(this.argument)) {
      const inventory = await host.runtime.planRoomCleanup({ roomId: host.room, tasks: [host.service.engine.view(host.room, host.task)!], quiescent: true });
      step({ type: 'PREPARED', intentId: prepare.id, attempt: prepare.attempt, inventory });
      while (saved.context.intents.some(intent => intent.kind === 'removeAsset' && intent.status === 'pending')) {
        const current = claim(), asset = saved.context.assets.find(asset => asset.id === current.assetId)!;
        const result = await host.runtime.cleanupRoom({ roomId: host.room, deletionId: saved.context.deletionId!, intentId: current.id, attempt: current.attempt, asset }, new AbortController().signal);
        if (this.argument === '清理部分文件后') break;
        step({ type: 'ASSET_REMOVED', intentId: current.id, attempt: current.attempt, ...result });
      }
      if (this.argument === '数据库清理提交前' || this.argument === '完成核对之前') {
        const erase = claim(); assert.equal(erase.kind, 'eraseData');
        if (this.argument === '数据库清理提交前') {
          (store as SqliteStore).failNextCommit = true;
          assert.throws(() => step({ type: 'DATA_ERASED', intentId: erase.id, attempt: erase.attempt }), /Injected commit failure/);
        } else step({ type: 'DATA_ERASED', intentId: erase.id, attempt: erase.attempt });
      }
    }
    const deletionId = saved.context.deletionId;
    await host.restart(); await this.finish(host); assert.equal(host.service.engine.roomDeletion(host.room)!.context.deletionId, deletionId);
    this.result.resumed = true;
  }
  private async residue() {
    if (this.actions > 1) return;
    if (this.argument === '数据库已清后仍保留目标会话的工作区准备缓存') { this.result = await deletionRuntimeProjectionAcceptance(); return; }
    const host = await this.open();
    if (this.argument === '仍在使用会话内容的执行或等待器') { this.result = await deletionPhysicalPreparationAcceptance(); this.result.retainedBeforeReview = true; return; }
    const unknown = this.argument === '新发现未决效果' || this.argument === '必要journal和未知效果证据';
    if (unknown) await host.seedOperation('uncertain'); else await host.seedOperation('succeeded');
    const journal = host.context().intents.flatMap(work => work.localOperations ?? [])[0]!;
    const path = join(host.root, 'runtime', 'sessions', createHash('sha256').update(journal.sessionId!).digest('hex') + '.json');
    const original = await readFile(path, 'utf8');
    let fail = true;
    const plan = host.runtime.planRoomCleanup.bind(host.runtime);
    if (!unknown && /归属/.test(this.argument)) host.runtime.planRoomCleanup = async input => {
      const value = await plan(input);
      if (fail) { value.complete = false; value.blockers.push({ id: 'ownership-review', kind: 'ownership', human: true, reason: '历史资源所有权需要核对' }); }
      return value;
    };
    else if (!unknown) {
      const cleanup = host.runtime.cleanupRoom.bind(host.runtime);
      host.runtime.cleanupRoom = async (claim, signal) => {
        if (fail && this.argument !== '数据库提交失败') throw Object.assign(new Error('EACCES: 当前独占资源不可写'), { code: 'EACCES' });
        const value = await cleanup(claim, signal);
        // Fail the real transaction that acknowledges a claimed, actually removed asset.
        if (fail) (deletionStore(host.service.engine.store) as SqliteStore).failNextCommit = true;
        return value;
      };
    }
    await host.archive(); await host.delete();
    const saved = await deletionUntil(() => host.service.engine.roomDeletion(host.room), saved => ['waiting', 'paused'].includes(saved?.value ?? ''), 'visible incomplete deletion');
    assert.equal(await readFile(path, 'utf8'), original); assert(saved!.context.reason); assert.equal(saved!.context.completedAt, null);
    assert.equal((await host.request(host.route())).status, 200); this.result.retainedBeforeReview = true;
    if (this.id === 'BT_X12') {
      if (unknown) await host.reviewUnknown();
      else {
        fail = false; const current = host.service.engine.roomDeletion(host.room)!;
        assert.equal((await host.request(host.route() + '/delete-retry', { id: randomUUID(), deletionId: current.context.deletionId, expectedDeletionVersion: current.context.revision })).status, 202);
      }
      await this.finish(host); this.result.retried = true;
    }
  }
  private async orphan() {
    const host = await this.open();
    if (this.argument === '资源租约没有可见active任务') {
      if (this.actions === 1) {
        await host.seedOperation('uncertain');
        assert(host.event({ type: 'ARTIFACT', artifact: { id: 'orphan-partial', name: 'partial.md', content: '逻辑任务结束后仍需核对的实际成果' } }).ok);
        assert(host.event({ type: 'EXHAUSTED', reason: '逻辑窗口结束，保留原操作的物理责任' }).ok);
        assert.equal(host.service.snapshot(host.room).activeTaskId, null);
        const leases = host.readRows().leases; assert(leases.length > 0);
        await host.archive(); await host.delete();
        const saved = await deletionUntil(() => host.service.engine.roomDeletion(host.room), saved => saved?.value === 'waiting', 'non-active operation lease retained');
        assert(saved!.context.blockers.some(blocker => blocker.kind === 'effects'));
        assert.deepEqual(host.readRows().leases, leases); this.result.retainedBeforeReview = true;
      } else { await host.reviewUnknown(); await this.finish(host); }
      return;
    }
    if (this.actions === 1) {
      await host.seedOperation('succeeded'); const work = host.context().intents.find(work => work.kind === 'owner')!;
      assert(host.event({ type: 'SETTLE', intentId: work.id }).ok);
      const op = work.localOperations![0]!, sessionId = 'reviewed-legacy-' + randomUUID();
      await host.runtime.journal.write({ operationId: op.id, sessionId, phase: 'settled', completion: { result: { ok: false, code: 'historical-failure', data: {} }, settled: true, effectsKnown: true } });
      await writeFile(join(host.root, 'runtime', 'logs', createHash('sha256').update(sessionId).digest('hex') + '.log'), 'legacy evidence retained');
      this.result.legacySession = sessionId; this.result.work = work;
      await host.archive(); await host.delete();
      const saved = await deletionUntil(() => host.service.engine.roomDeletion(host.room), saved => saved?.value === 'waiting', 'orphan ownership blocked');
      assert(saved!.context.blockers.some(blocker => blocker.kind === 'ownership')); this.result.retainedBeforeReview = true;
      if (this.argument === '删除中断留下清理记录') {
        const deletionId = saved!.context.deletionId; await host.restart();
        const recovered = host.service.engine.roomDeletion(host.room)!;
        assert.equal(recovered.context.deletionId, deletionId); assert.equal(recovered.value, 'waiting');
        assert.equal(await readFile(join(host.root, 'runtime', 'logs', createHash('sha256').update(sessionId).digest('hex') + '.log'), 'utf8'), 'legacy evidence retained');
      }
    } else {
      // Trusted fixture attestation represents the explicit ownership review; it cannot be submitted by a model/HTTP raw event.
      const work = this.result.work as Intent, op = work.localOperations![0]!;
      await new RuntimeOwnership(join(host.root, 'runtime'), host.source).register(work, { ...op, sessionId: String(this.result.legacySession), attempt: op.attempt + 1 }, { roomId: host.room, taskId: host.task });
      const saved = host.service.engine.roomDeletion(host.room)!;
      assert.equal((await host.request(host.route() + '/delete-retry', { id: randomUUID(), deletionId: saved.context.deletionId, expectedDeletionVersion: saved.context.revision })).status, 202);
      await this.finish(host);
    }
  }
  async verify() {
    if (this.browser) {
      if (this.id === 'BT_X01' && this.actions === 0) await this.browser.verifyDeletionConfirmation();
      else {
        await this.browser.verify();
        if (this.id === 'BT_X24' && !this.browserRestartVerified) {
          await this.browser.verifyDeletionAfterServiceRestart(); this.browserRestartVerified = true;
        }
      }
      return;
    }
    assert(this.actions > 0, this.id + ' must execute an observable event');
    if (this.id === 'BT_X02') { assert.equal(this.result.rejected, true); assert.equal(this.result.noCleanup, true); }
    else if (this.id === 'BT_X09') { assert.equal(this.result.rejected, true); assert.equal(this.result.outsidePreserved, true); }
    else if (this.id === 'BT_X06') assert.equal(this.result.versionAdjudicated, true);
    else if (this.id === 'BT_X12' || this.id === 'BT_X25' || this.id === 'BT_X23' && this.actions === 1) assert.equal(this.result.retainedBeforeReview, true);
    else if (this.id === 'BT_X21') { assert.equal(this.result.sessions, 2); assert.equal(this.result.collidingOperationId, true); assert.equal(this.result.otherRoomUnchanged, true); }
    else if (this.id === 'BT_X26') { assert.equal(this.result.waitedForActualIo, true); assert.equal(this.result.processLaunches, 0); }
    else { assert.equal(this.result.deleted, true); }
    if (this.id === 'BT_X11') assert.equal(this.result.resumed, true);
    if (this.id === 'BT_X14') assert.equal(this.result.minimalTombstone, true);
    if (this.id === 'BT_X17') assert.equal(this.result.unreadable, true);
  }
  markFailed() { this.browser?.markFailed(); }
  async close() { this.release?.(); await this.browser?.close(); await this.host?.close(); }
}
