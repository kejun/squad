import { publicationIds } from '../task/delivery.js';
import { initialTransition, transition } from 'xstate';
import { serviceLifecycleMachine } from './service-lifecycle.js';
import { currentDeliveryIssues } from '../delivery-acceptance.js';
import { hostSessionActive } from '../host-session.js';
import type { LocalRuntime } from "../local-runtime.js";
import { isSavedRead, localAwaitingApproval } from '../local-operation.js';
import { findHostRetry, hostRetryProblem } from '../host-retry.js';
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as hostTimeout, clearTimeout as clearHostTimeout } from 'node:timers';
import { DatabaseSync } from "node:sqlite";
import { TeamEngine, type CommandResult, type Submission } from "../engine.js";
import { artifactSourceMetadata } from '../types.js';
import { assistanceRetryProblem } from "../task.machine.js";
import { retryableAssistance, retryProblemText } from "../assistance-retry.js";
import { OpenAICompatibleAdapter } from "../model-adapter.js";
import { measurementRun, type ExecutionObservation, type MeasurementContext, type MeasurementIdentity, type MeasurementRecord, type MeasurementRun } from "../measurement.js";
import { resolveModel } from "../model-config.js";
import {
  WorkFailure,
  WorkRunner,
  type WorkAdapter,
  type WorkScope,
} from "../runner.js";
import { SqliteStore } from "../store.js";
import { RoomDeletionCoordinator } from '../room-deletion-coordinator.js';
import type { RuntimeCleanupInventory, SavedRoomDeletion } from '../room-deletion.machine.js';
import { DebugJournal } from "./debug-journal.js";
import type { DebugFeed } from "../task-debug.js";
import type { Intent, TeamConfig } from "../types.js";
import { processingWindow } from '../task/resilience.js';
import type { WebTools } from "../web-tools.js";
import type {
  ExecutionEvent,
  RoomSnapshot,
  WebAgent,
  WebRoom,
  WebTask,
  WebWork,
  WebHostApproval,
  WebFailedSandboxCommand,
  WebBlocker,
  WebOperationReview,
  DeletedRoom,
} from "./contracts.js";

export class WebError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly commandResult?: CommandResult,
  ) {
    super(message);
  }
}

/** A local host for the existing execution engine. No client-supplied machine events are accepted. */
export class WebService {
  readonly engine: TeamEngine;
  private readonly db: DatabaseSync;
  private readonly store: SqliteStore;
  private readonly adapter: WorkAdapter;
  private readonly runners = new Map<string, WorkRunner>();
  private readonly running = new Map<string, { roomId: string; taskId: string; job: Promise<void> }>();
  private readonly cancellationJobs = new Map<string, { roomId: string; taskId: string; job: Promise<void> }>();
  private readonly cleanupJobs = new Map<string, Promise<void>>();
  private readonly retiredRooms = new Set<string>();
  private storageClosed = false;
  private hostFault = false;
  private readonly failedRooms = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private lifecycle = initialTransition(serviceLifecycleMachine)[0];
  private closePromise?: Promise<void>;
  private startup: Promise<void> = Promise.resolve();
  private get closing() { return this.lifecycle.matches('closing') || this.lifecycle.matches('closed'); }
  private get initialized() { return this.lifecycle.matches('ready'); }
  private readonly debugJournal: DebugJournal | null;
  private readonly measurement: MeasurementRun;
  private readonly deletions: RoomDeletionCoordinator;

  constructor(
    readonly config: TeamConfig,
    path: string,
    adapter?: WorkAdapter,
    private readonly webTools?: WebTools,
    readonly debugEnabled = false,
    private readonly localRuntime?: LocalRuntime,
    measurementIdentity?: MeasurementIdentity,
  ) {
    this.measurement = measurementRun(config, measurementIdentity);
    // Web projections and task/deletion transactions share one database even for
    // :memory:. This service owns the connection; its store only borrows it.
    this.db = new DatabaseSync(path);
    this.store = new SqliteStore(this.db);
    this.debugJournal = debugEnabled ? new DebugJournal() : null;
    this.engine = new TeamEngine(this.store, config, Date.now,
      this.debugJournal ? (roomId, frame) => this.debugJournal!.append(roomId, frame) : undefined);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_rooms(id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL, taskId TEXT NOT NULL,
        workId TEXT NOT NULL, agentId TEXT NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_events_room ON web_events(roomId, id);
    `);
    this.adapter =
      adapter ??
      (config.models
        ? new OpenAICompatibleAdapter(config)
        : {
            execute: async () => {
              throw new WorkFailure("请先在 .env 配置模型服务，然后重启应用。");
            },
          });
    this.deletions = new RoomDeletionCoordinator(this.store, this.engine, {
      prepare: async roomId => {
        this.retiredRooms.add(roomId);
        const runner = this.runners.get(roomId);
        runner?.abortExecutions(roomId);
        if (runner) { await runner.drainExecutions(this.config.resilience?.cancelGraceMs ?? 5000); runner.detachExecutions(); }
        if (this.localRuntime) for (const taskId of Object.keys(this.store.read(roomId).tasks)) {
          const c = this.engine.view(roomId, taskId)!.context;
          for (const work of c.intents) for (const op of work.localOperations ?? []) if (op.status === 'uncertain' && op.sessionId) {
            const reconciliation = await this.localRuntime.reconcile(op);
            if (this.closing) return;
            if (reconciliation) this.engine.send(roomId, taskId, { type: 'LOCAL_RECONCILE', id: randomUUID(), at: Date.now(),
              intentId: work.id, operationId: op.id, sessionId: op.sessionId, ...reconciliation });
          }
        }
      },
      inventory: (roomId, saved) => this.deletionInventory(roomId, saved),
      remove: (claim, signal) => {
        if (!this.localRuntime) throw new Error('CLEANUP_RUNTIME_UNAVAILABLE');
        return this.localRuntime.cleanupRoom(claim, signal);
      },
      filesGone: inventory => this.localRuntime ? this.localRuntime.verifyRoomCleanup(inventory) : Promise.resolve(inventory.assets.length === 0 && inventory.sessions.length === 0),
      retire: roomId => { this.retiredRooms.add(roomId); this.debugJournal?.removeRoom(roomId); this.runners.get(roomId)?.detachExecutions(); this.runners.delete(roomId); this.failedRooms.delete(roomId); },
      projectionsGone: roomId => !this.runners.has(roomId) && !this.failedRooms.has(roomId) && !(this.debugJournal?.read(roomId).records.length),
      failed: roomId => { this.hostFault = true; this.hostError(roomId, new Error('DELETION_STORAGE_FAULT')); },
    });
    this.deletions.resume();
    if (localRuntime) {
      this.startup = this.recoverLocal().then(() => {
        this.advanceLifecycle('RECOVERED');
        if (this.initialized) for (const room of this.rooms()) this.kick(room.id);
      }).catch(error => {
        this.advanceLifecycle('RECOVERY_FAILED');
        throw error;
      });
      // Startup errors remain observable via ready, even if close is called first.
      void this.startup.catch(() => {});
    } else {
      this.advanceLifecycle('RECOVERED');
      for (const room of this.rooms()) { this.engine.recover(room.id); this.kick(room.id); }
    }
    this.timer = setInterval(() => {
      if (this.closing || !this.initialized) return;
      let rooms: WebRoom[];
      try { this.deletions.tick(); rooms = this.rooms(); } catch { this.hostFault = true; return; }
      for (const room of rooms) {
        try {
          if (this.failedRooms.has(room.id)) {
            if (!this.engine.healthy) continue;
            this.engine.recover(room.id); this.failedRooms.delete(room.id);
          }
          this.scheduleCleanup(room.id);
          const wake = this.engine.nextWake(room.id);
          if (wake !== null && wake <= Date.now()) this.engine.tick(room.id);
          this.kick(room.id);
        } catch (error) { this.hostError(room.id, error); }
      }
    }, 1000);
    this.timer.unref();
  }

  private advanceLifecycle(type: 'RECOVERED' | 'RECOVERY_FAILED' | 'CLOSE' | 'CLOSED') {
    this.lifecycle = transition(serviceLifecycleMachine, this.lifecycle, { type })[0];
  }
  async ready(): Promise<void> {
    await this.startup;
    if (!this.initialized) throw new WebError(503, '执行服务未就绪或已经关闭。');
  }
  health() {
    return { healthy: this.initialized && !this.closing && !this.hostFault && this.engine.healthy,
      hostId: process.env.SQUAD_SUPERVISION_ID ?? null };
  }
  private async recoverLocal(): Promise<void> {
    const rooms = this.rooms().filter(room => !room.deletion);
    for (const room of rooms) { if (this.closing) return; this.engine.recover(room.id); }
    for (const room of rooms) {
      for (const taskId of Object.keys(this.store.read(room.id).tasks)) {
        const context = this.engine.view(room.id, taskId)!.context;
        for (const work of context.intents) for (const op of work.localOperations ?? []) {
          if (op.status !== 'uncertain' || !op.sessionId) continue;
          if (this.closing) return;
          const reconciliation = await this.localRuntime!.reconcile(op);
          if (this.closing) return;
          if (reconciliation) {
            const reply = this.engine.send(room.id, taskId, { type: 'LOCAL_RECONCILE', id: `startup-local:${randomUUID()}`, at: Date.now(),
              intentId: work.id, operationId: op.id, sessionId: op.sessionId, ...reconciliation });
            if (reply.ok) this.append(room.id, work, 'tool-result', '已核对本地操作回执', JSON.stringify({ operationId: op.id, ...reconciliation }));
          } else this.append(room.id, work, 'error', '本地操作等待核对', JSON.stringify({ operationId: op.id, sessionId: op.sessionId, status: 'uncertain' }));
        }
        // Projection from committed child receipts also fills a crash between DB commit and UI append.
        const latest = this.engine.view(room.id, taskId)!.context;
        for (const work of latest.intents) for (const op of work.localOperations ?? []) {
          if (!op.result || !['succeeded', 'failed', 'cancelled'].includes(op.status)) continue;
          const shown = this.db.prepare("SELECT 1 FROM web_events WHERE roomId=? AND workId=? AND kind='tool-result' AND instr(detail,?)>0 LIMIT 1").get(room.id, work.id, op.id);
          if (!shown) {
            const receipt = isSavedRead(op.action) ? { ok: op.result.ok, code: op.result.code } : op.result;
            this.append(room.id, work, 'tool-result', '本地操作持久回执', JSON.stringify({ operationId: op.id, ...receipt }));
          }
        }
      }
    }
  }
  rooms(): WebRoom[] {
    const rooms = this.db
      .prepare(
        "SELECT id, title, createdAt FROM web_rooms ORDER BY createdAt, rowid",
      )
      .all() as unknown as WebRoom[];
    // Scheduling and recovery use this complete list, including archived rooms.
    const all: WebRoom[] = rooms.map(room => ({ ...room, ...this.engine.roomArchive(room.id) }));
    for (const saved of this.store.listDeletions()) {
      if (saved.value === 'idle') continue;
      const index = all.findIndex(room => room.id === saved.context.roomId);
      if (saved.value === 'deleted') { if (index >= 0) all.splice(index, 1); continue; }
      const deletion = { id: saved.context.deletionId!, version: saved.context.revision, status: saved.value as 'preparing' | 'waiting' | 'deleting' | 'paused',
        reason: saved.context.reason, remaining: [...saved.context.blockers.map(b => b.reason),
          ...saved.context.assets.filter(a => a.status !== 'removed').map(a => `${a.kind}: ${a.id}`)], canRetry: ['waiting', 'paused'].includes(saved.value) };
      const room: WebRoom = { ...(index >= 0 ? all[index]! : { id: saved.context.roomId, title: '正在删除的会话', createdAt: saved.context.requestedAt ?? 0,
        archived: true, archiveVersion: saved.context.archiveVersion ?? 0 }), deletion };
      if (index >= 0) all[index] = room; else all.push(room);
    }
    return all;
  }
  deletedRooms(): DeletedRoom[] { return this.store.listDeletions().filter(saved => saved.value === 'deleted').map(saved => ({ roomId: saved.context.roomId, deletionVersion: saved.context.revision, status: 'deleted' })); }
  async deleteRoom(roomId: string, data: { id: string; expectedArchiveVersion: number; expectedDeletionVersion?: number }): Promise<WebRoom | DeletedRoom> {
    const before = this.engine.roomDeletion(roomId);
    if (before?.value === 'deleted') return { roomId, deletionVersion: before.context.revision, status: 'deleted' };
    this.room(roomId);
    if (data.expectedDeletionVersion !== undefined && before?.context.revision !== data.expectedDeletionVersion) throw new WebError(409, '删除状态已更新，请重新确认。');
    const saved = this.engine.requestRoomDeletion(roomId, data.id, data.expectedArchiveVersion);
    if (!saved.context.reply.ok) throw new WebError(409, saved.context.reply.detail, saved.context.reply);
    this.deletions.kick(roomId); return this.room(roomId);
  }
  async retryRoomDeletion(roomId: string, data: { id: string; deletionId: string; expectedDeletionVersion: number }): Promise<WebRoom | DeletedRoom> {
    const saved = this.engine.roomDeletion(roomId);
    if (!saved || saved.context.deletionId !== data.deletionId || saved.context.revision !== data.expectedDeletionVersion) throw new WebError(409, '删除请求已失效，请查看最新状态。');
    if (saved.value === 'deleted') return { roomId, deletionVersion: saved.context.revision, status: 'deleted' };
    const next = this.store.stepDeletion(roomId, { type: 'RETRY', id: data.id, at: Date.now(), deletionId: data.deletionId });
    if (!next.context.reply.ok) throw new WebError(409, next.context.reply.detail);
    this.deletions.kick(roomId); return this.room(roomId);
  }
  private async deletionInventory(roomId: string, saved: SavedRoomDeletion): Promise<RuntimeCleanupInventory> {
    const tasks = Object.keys(this.store.read(roomId).tasks).map(taskId => this.engine.view(roomId, taskId)!);
    const previous: RuntimeCleanupInventory = { tasks: saved.context.tasks, sessions: saved.context.sessions, assets: saved.context.assets,
      complete: saved.context.tasks.length === saved.context.allTasks.length, executionsSettled: saved.context.blockers.length === 0, blockers: saved.context.blockers };
    if (this.localRuntime) return this.localRuntime.planRoomCleanup({ roomId, tasks, previous, databaseErased: saved.context.dataErased, quiescent: this.localRuntime.roomQuiescent(roomId) });
    const local = tasks.some(t => t.context.intents.some(w => w.localOperations?.length)) || previous.assets.length > 0 || previous.sessions.length > 0;
    const unknown = tasks.some(t => t.context.intents.some(w => w.status === 'uncertain' && w.replay === 'unsafe'));
    return { tasks: tasks.map(t => ({ taskId: t.context.taskId, namespace: this.engine.localNamespace(roomId, t.context.taskId), phase: t.phase,
      outcome: t.context.outcome, workIds: t.context.intents.map(w => w.id), operationIds: t.context.intents.flatMap(w => w.localOperations?.map(op => op.id) ?? []) })),
      sessions: [], assets: [], complete: !local, executionsSettled: !unknown && !local,
      blockers: local || unknown ? [{ id: 'runtime-unavailable', kind: local ? 'ownership' : 'effects', human: true, reason: '原执行或文件需要本地运行时核对，尚未清理完成。' }] : [] };
  }
  createRoom(title = "新的群聊"): WebRoom {
    const room = {
      id: randomUUID(),
      title: title.trim().slice(0, 80) || "新的群聊",
      createdAt: Date.now(),
      archived: false,
      archiveVersion: 0,
    };
    this.db
      .prepare("INSERT INTO web_rooms(id, title, createdAt) VALUES(?, ?, ?)")
      .run(room.id, room.title, room.createdAt);
    return room;
  }
  private room(id: string): WebRoom {
    const deletion = this.engine.roomDeletion(id);
    if (deletion?.value === 'deleted') throw new WebError(410, '这个群聊已删除。', { ok: false, code: 'ROOM_DELETED', detail: '这个群聊已删除。', roomId: id, deletionVersion: deletion.context.revision });
    const room = this.rooms().find((room) => room.id === id);
    if (!room) throw new WebError(404, "找不到这个群聊。");
    return room;
  }
  setRoomArchived(roomId: string, commandId: string, archived: boolean): WebRoom {
    this.room(roomId);
    const reply = this.engine.setRoomArchived(roomId, commandId, archived);
    if (!reply.ok) throw new WebError(409, reply.detail);
    // A repeated old receipt returns current metadata, never reapplies its old target state.
    return this.room(roomId);
  }
  decideHostApproval(roomId: string, data: { id: string; taskId: string; workId: string; operationId: string; approvalId: string; decision: 'approve' | 'approveSession' | 'deny' }) {
    this.room(roomId);
    let work: Intent | undefined;
    try { work = this.engine.view(roomId, data.taskId)?.context.intents.find(item => item.id === data.workId); }
    catch { /* Recording the approval is best effort. */ }
    const operation = work?.localOperations?.find(op => op.id === data.operationId);
    const approval = operation?.approval;
    const result = this.engine.decideHostApproval(roomId, data.taskId, data.workId, data.operationId, data.approvalId, data.decision, data.id);
    if (!result.ok) throw new WebError(409, `授权请求已失效或不可用 (${result.code})`);
    if (work && approval?.id === data.approvalId && approval.status === "pending") {
      this.recordMeasurement({ roomId, taskId: data.taskId, workId: work.id, agentId: work.target, attempt: work.attempt,
        epoch: work.epoch, goalVersion: work.goalVersion },
      { phase: "local.approvalDecision", action: "runCli", operationId: data.operationId, approvalId: data.approvalId,
        ...(operation?.hostRetryRequestId ? { retryRequestId: operation.hostRetryRequestId } : {}),
        decisionId: createHash("sha256").update(data.id).digest("hex"), decision: data.decision });
    }
    this.localRuntime?.notifyWorkspace(`approval:${data.operationId}`);
    if (data.decision === 'approveSession') for (const work of this.engine.view(roomId, data.taskId)?.context.intents ?? [])
      for (const op of work.localOperations ?? []) if (op.approval?.sessionGrantId) this.localRuntime?.notifyWorkspace(`approval:${op.id}`);
    this.kick(roomId);
    return result;
  }
  revokeHostSession(roomId: string, data: { id: string; taskId: string; grantId: string }) {
    this.room(roomId);
    const result = this.engine.revokeHostSession(roomId, data.taskId, data.grantId, data.id);
    if (!result.ok) throw new WebError(409, `无法撤销会话授权 (${result.code})`);
    this.kick(roomId); return result;
  }
  requestHostRetry(roomId: string, data: { id: string; taskId: string; workId: string; operationId: string; sourceRequestHash: string }) {
    this.room(roomId);
    if (!this.localRuntime) throw new WebError(409, '本地运行时未开启。');
    let previousRequest: string | null | undefined;
    try {
      const before = this.engine.view(roomId, data.taskId)?.context;
      if (before) previousRequest = findHostRetry(before, data.workId, data.operationId)?.id ?? null;
    } catch { /* Recording the accepted request is best effort. */ }
    const reply = this.engine.requestHostRetry(roomId, data.taskId, data.workId, data.operationId, data.sourceRequestHash, data.id);
    if (!reply.ok) throw new WebError(409, `无法从该记录申请宿主执行 (${reply.code})`);
    if (previousRequest === null) {
      try {
        const after = this.engine.view(roomId, data.taskId)?.context;
        const request = after && findHostRetry(after, data.workId, data.operationId);
        const source = request && after?.intents.find(work => work.id === request.sourceWorkId);
        if (request && source && reply.detail === request.id) {
          this.recordMeasurement({ roomId, taskId: data.taskId, workId: source.id, agentId: source.target, attempt: source.attempt,
            epoch: source.epoch, goalVersion: request.goalVersion },
          { phase: 'local.retryQueued', action: 'runCli', operationId: request.sourceOperationId,
            sourceOperationId: request.sourceOperationId, retryRequestId: request.id });
        }
      } catch { /* Recording the accepted request is best effort. */ }
    }
    this.kick(roomId); return reply;
  }
  snapshot(roomId: string): RoomSnapshot {
    const room = this.room(roomId);
    const stored = this.store.read(roomId);
    const tasks: WebTask[] = [];
    const works: WebWork[] = [];
    const hostApprovals: WebHostApproval[] = [];
    const hostSessions: { taskId: string; grantId: string; host: string; account: string }[] = [];
    const failedSandboxCommands: WebFailedSandboxCommand[] = [];
    const blockers: WebBlocker[] = [];
    const agents: WebAgent[] = this.config.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      tools: bot.tools,
      model: resolveModel(this.config, "owner", bot.id)?.service.model ?? null,
    }));
    for (const taskId of Object.keys(stored.tasks)) {
      const { phase, context: c } = this.engine.view(roomId, taskId)!;
      const currentArtifactIds = publicationIds(c);
      const deliveryGaps = currentDeliveryIssues(c);
      for (const gate of c.resilience?.gates ?? []) if (['open', 'skipped'].includes(gate.status) && (gate.scope === 'cleanup' || gate.epoch === c.epoch && gate.goalVersion === c.goalVersion)) {
        const actions: WebBlocker['actions'] = gate.scope === 'cleanup' || gate.status === 'skipped' ? [] : gate.approvalId
          ? [{ id: 'skip', label: '跳过此命令' }, { id: 'stop', label: '停止任务' }]
          : [{ id: 'reply', label: '回复', requiresText: true }, { id: 'skip', label: '跳过' },
            { id: 'stop', label: '停止任务' }, { id: 'newWindow', label: '授权新窗口', requiresText: true, allowsNewWindowMs: true }];
        blockers.push({ id: gate.id, version: gate.createdAt, taskId, epoch: gate.epoch, goalVersion: gate.goalVersion,
          scope: gate.scope, ...(gate.workId && gate.operationId ? { operation: { workId: gate.workId, operationId: gate.operationId,
            ...(gate.approvalId ? { approvalId: gate.approvalId } : {}) } } : {}),
          title: gate.scope === 'cleanup' ? '执行效果等待核对' : gate.status === 'skipped' ? '内容已明确跳过'
            : gate.cause === 'incompatibleExecution' ? '执行配置需要重新核对' : '需要你的回复', question: gate.question, requiredHuman: gate.required, status: gate.status === 'skipped' ? 'skipped' : 'open',
          actions: gate.decisions ? actions.filter(action => gate.decisions!.includes(action.id)) : actions });
      }
      const frozen = c.resilience?.frozen;
      const cleanup = c.resilience?.cleanup.some(item => item.state === 'pending');
      tasks.push({
        supervision: { status: this.failedRooms.has(roomId) ? 'faulted' : cleanup ? 'cleaning' : c.resilience?.gates.some(g => g.scope === 'task' && g.status === 'open') ? 'waitingHuman'
          : c.outcome !== null ? 'settled' : c.resilience?.window.repairUsed ? 'repairing' : 'running', reason: this.failedRooms.has(roomId) ? '执行服务发生错误，正在自动核查与恢复。' : c.reason,
          nextWakeAt: c.resilience?.nextSupervisionAt ?? null, hardDeadlineAt: processingWindow(c).hardDeadline },
        ...(frozen ? { delivery: { epoch: frozen.epoch, goalVersion: frozen.goalVersion, revision: frozen.id, status: frozen.verification,
          currentArtifactIds: [...frozen.artifactIds], reportArtifactId: frozen.reportArtifactId } } : {}),
        id: taskId,
        goal: c.goal.text,
        owner: c.owner,
        phase,
        outcome: c.outcome,
        reason: c.reason,
        usage: { ordinary: c.usage.ordinary, checks: c.usage.checks },
        limits: {
          ordinary: c.config.limits.ordinary,
          checks: c.config.limits.checks,
        },
        artifacts: c.artifacts,
        ...(c.sourceArtifact ? { sourceArtifact: artifactSourceMetadata(c.sourceArtifact) } : {}),
        ...(currentArtifactIds ? { currentArtifactIds } : {}),
        ...(deliveryGaps.length ? { deliveryGaps } : {}),
        board: c.board,
        trace: c.trace,
        ...(c.inputAnalyses ? { inputAnalyses: c.inputAnalyses } : {}),
        assists: c.assists.filter(retryableAssistance).map((help) => {
          const problem = stored.activeTaskId && stored.activeTaskId !== taskId
            ? "ROOM_BUSY" : assistanceRetryProblem(c, help.id, this.config);
          return { id: help.id, taskId, target: help.target, retryable: problem === null,
            reason: problem ? retryProblemText(problem) : "" };
        }),
        ...(c.review
          ? {
              review: {
                targets: c.review.targets,
                completed: c.review.completed,
                status: c.review.status,
              },
            }
          : {}),
      });
      for (const bot of c.config.bots) {
        if (!agents.some((agent) => agent.id === bot.id))
          agents.push({ ...bot, model: null, retired: true });
      }
      if (hostSessionActive(c)) {
        const g = c.hostSession!; hostSessions.push({ taskId, grantId: g.id, host: g.host, account: g.account });
      }
      for (const i of c.intents) {
        for (const op of i.localOperations ?? []) {
          if (op.action.type !== 'runCli' || op.action.execution === 'host' || op.status !== 'failed' || op.result?.ok !== false) continue;
          const currentTask = stored.activeTaskId ?? Object.keys(stored.tasks).at(-1);
          const request = findHostRetry(c, i.id, op.id);
          const retryOp = c.intents.find(w => w.id === request?.workId)?.localOperations?.find(child => child.id === request?.operationId);
          const status = retryOp?.status === 'awaitingApproval' || retryOp?.status === 'running' ? retryOp.status : request?.status;
          const problem = !this.localRuntime ? 'LOCAL_RUNTIME_NOT_CONFIGURED' : currentTask !== taskId ? 'ROOM_BUSY' : hostRetryProblem(c, i.id, op.id, op.requestHash);
          const visible: WebFailedSandboxCommand = { taskId, workId: i.id, operationId: op.id, sourceRequestHash: op.requestHash, executable: op.action.executable, args: op.action.args,
            error: String(op.result.data.stderr ?? op.result.code).slice(0, 1000), canRequest: !problem && !request, unavailableReason: problem ?? '',
            ...(request && status ? { retry: { id: request.id, status, ...(request.reason ? { reason: request.reason } : {}),
              ...(request.workId ? { workId: request.workId } : {}), ...(request.operationId ? { operationId: request.operationId } : {}) } } : {}) };
          failedSandboxCommands.push(this.localRuntime ? this.localRuntime.clean(visible) : visible);
        }
        if (!c.stopped && c.outcome === null && ['pending', 'inflight'].includes(i.status) && i.epoch === c.epoch && i.goalVersion === c.goalVersion)
          for (const op of i.localOperations ?? []) {
            const a = op.approval;
            if (op.status !== 'awaitingApproval' || !a || a.status !== 'pending' || a.expiresAt <= Date.now()) continue;
            const { executable, args, cwd, host, account, reason } = a.plan;
            const visible = { taskId, workId: i.id, operationId: op.id, approvalId: a.id, expiresAt: a.expiresAt, executable, args, cwd, host, account, reason };
            hostApprovals.push(this.localRuntime ? this.localRuntime.clean(visible) : visible);
          }
        works.push({
          id: i.id,
          agentId: i.target,
          taskId,
          kind: i.kind,
          status: i.status,
          attempt: i.attempt,
          requestCount: i.requestCount,
          model: i.model?.service.model ?? null,
          reason:
            i.kind === "assistance"
              ? String(i.payload.question ?? "")
              : i.kind === "check"
                ? "核对交付是否符合任务要求"
                : String(i.payload.reason ?? i.payload.plan ?? c.goal.text),
          epoch: i.epoch,
        });
      }
      for (const work of c.intents) for (const op of work.localOperations ?? []) {
        if (!op.result || (op.action.type !== 'verifyWorkspace' && !op.hostRetryRequestId)) continue;
        const shown = this.db.prepare(`SELECT 1 FROM web_events WHERE roomId=? AND workId=? AND kind='tool-result'
          AND CASE WHEN json_valid(detail) THEN json_extract(detail,'$.operationId') END = ? LIMIT 1`).get(roomId, work.id, op.id);
        if (!shown) this.append(roomId, work, 'tool-result', op.hostRetryRequestId ? '宿主续办回执' : '工程版本复核',
          JSON.stringify({ operationId: op.id, ...op.result }));
      }
    }
    const events = this.db
      .prepare(
        "SELECT id, taskId, workId, agentId, at, kind, title, detail FROM web_events WHERE roomId = ? AND kind != 'measurement' ORDER BY id",
      )
      .all(roomId) as unknown as ExecutionEvent[];
    return {
      room,
      agents,
      tasks,
      works,
      events,
      hostApprovals,
      hostSessions,
      failedSandboxCommands,
      blockers,
      deletedRooms: this.deletedRooms(),
      messages: this.engine.timeline(roomId),
      activeTaskId: stored.activeTaskId,
      modelConfigured: !!this.config.models,
      serverTime: Date.now(),
    };
  }
  debugSnapshot(roomId: string, after = 0, sessionId?: string, taskId?: string): DebugFeed {
    if (!this.debugJournal) throw new WebError(404, "调试未开启。");
    this.room(roomId);
    const room = this.store.read(roomId);
    const tasks = Object.keys(room.tasks).map(id => ({ id, phase: this.engine.view(roomId, id)!.phase }));
    const id = taskId ?? room.activeTaskId ?? tasks.at(-1)?.id;
    if (taskId && !room.tasks[taskId]) throw new WebError(404, "找不到这个任务。");
    const stored = id ? room.tasks[id] as { snapshot: unknown } : undefined;
    return { ...this.debugJournal.read(roomId, after, sessionId), tasks,
      current: id && stored ? { taskId: id, snapshot: structuredClone(stored.snapshot) } : null };
  }
  submit(roomId: string, input: Submission) {
    if (!this.initialized) throw new WebError(503, "本地执行会话正在恢复，请稍后重试。");
    this.room(roomId);
    if (
      !input.id ||
      input.id.length > 120 ||
      !input.text.trim() ||
      input.text.length > 32_000
    )
      throw new WebError(400, "请输入 1–32000 字的消息。");
    if (
      input.mentions?.some(
        (id) => !this.config.bots.some((bot) => bot.id === id),
      )
    )
      throw new WebError(400, "点名的成员不存在。");
    const first = this.engine.timeline(roomId).length === 0;
    const result = this.engine.submit(roomId, input);
    if (!result.ok) throw new WebError(409, result.detail, result);
    if (result.taskId && this.engine.view(roomId, result.taskId)?.context.stopped) {
      this.scheduleCancellation(roomId, result.taskId);
    }
    if (first) {
      const title =
        input.text
          .replace(/@[\w-]+\s*/g, "")
          .trim()
          .slice(0, 24) || "新的群聊";
      this.db
        .prepare("UPDATE web_rooms SET title = ? WHERE id = ?")
        .run(title, roomId);
    }
    this.kick(roomId);
    return result;
  }
  stop(roomId: string, taskId: string, commandId: string) {
    this.room(roomId);
    const result = this.engine.send(roomId, taskId, {
      type: "STOP",
      id: commandId,
      at: Date.now(),
    });
    if (!result.ok) throw new WebError(409, result.detail);
    // Cancellation must be dispatched while execute() is still awaiting the model.
    this.scheduleCancellation(roomId, taskId);
    return result;
  }
  decideBlocker(roomId: string, data: { id: string; taskId: string; blockerId: string; blockerVersion: number;
    actionId: 'reply' | 'skip' | 'stop' | 'newWindow'; text?: string; newWindowMs?: number }) {
    this.room(roomId);
    const c = this.engine.view(roomId, data.taskId)?.context;
    const gate = c?.resilience?.gates.find(g => g.id === data.blockerId);
    if (!gate || gate.createdAt !== data.blockerVersion || gate.epoch !== c!.epoch || gate.goalVersion !== c!.goalVersion)
      throw new WebError(409, '这个请求已失效，请查看最新任务状态。');
    if (gate.scope === 'cleanup') throw new WebError(409, '执行效果必须通过真实核对结算。');
    const result = this.engine.send(roomId, data.taskId, { type: 'HUMAN_GATE_DECISION', id: data.id, at: Date.now(), gateId: gate.id,
      decision: data.actionId, fence: { epoch: gate.epoch, goalVersion: gate.goalVersion },
      ...(data.text === undefined ? {} : { text: data.text }), ...(data.newWindowMs === undefined ? {} : { newWindowMs: data.newWindowMs }) });
    if (!result.ok) throw new WebError(409, result.detail, result);
    this.failedRooms.delete(roomId); this.kick(roomId); return result;
  }
  private operation(roomId: string, taskId: string, workId: string, operationId: string) {
    this.room(roomId);
    if (!this.localRuntime) throw new WebError(409, '本地运行时不可用，无法核对执行。');
    const work = this.engine.view(roomId, taskId)?.context.intents.find(w => w.id === workId);
    const op = work?.localOperations?.find(o => o.id === operationId);
    if (!work || !op || op.status !== 'uncertain' || !op.sessionId || op.action.type !== 'runCli')
      throw new WebError(409, '找不到可核对的未决执行。');
    return { work, op };
  }
  async operationReview(roomId: string, data: { taskId: string; workId: string; operationId: string }): Promise<WebOperationReview> {
    const { work, op } = this.operation(roomId, data.taskId, data.workId, data.operationId);
    return this.localRuntime!.reviewOperation(work, op);
  }
  async reconcileOperation(roomId: string, data: { id: string; taskId: string; workId: string; operationId: string; reviewDigest: string }) {
    const { work, op } = this.operation(roomId, data.taskId, data.workId, data.operationId);
    const receipt = await this.localRuntime!.acknowledgeOperation(work, op, data.reviewDigest);
    if (this.closing) throw new WebError(503, '服务正在关闭，持久回执将在重启后继续核对。');
    const result = this.engine.send(roomId, data.taskId, { type: 'LOCAL_RECONCILE', id: data.id, at: Date.now(), intentId: work.id,
      operationId: op.id, sessionId: op.sessionId!, ...receipt });
    if (!result.ok) throw new WebError(409, result.detail, result);
    this.localRuntime!.notifyWorkspace(op.workspaceId ?? ''); this.kick(roomId); return result;
  }
  private async drainCancellation(roomId: string, taskId: string) {
    const runner = this.runner(roomId);
    while (!this.storageClosed && this.engine.pending(roomId, taskId).some((i) => i.kind === "cancel"))
      if (!await runner.runOne(roomId, taskId)) break;
  }
  private scheduleCancellation(roomId: string, taskId: string) {
    const key = JSON.stringify([roomId, taskId]); if (this.cancellationJobs.has(key)) return;
    const job = this.drainCancellation(roomId, taskId).catch(error => this.hostError(roomId, error)).finally(() => { this.cancellationJobs.delete(key); });
    this.cancellationJobs.set(key, { roomId, taskId, job });
  }
  private scheduleCleanup(roomId: string) {
    if (!this.localRuntime || this.closing || this.retiredRooms.has(roomId) || this.engine.roomDeletion(roomId)?.value && this.engine.roomDeletion(roomId)?.value !== 'idle') return;
    for (const taskId of Object.keys(this.store.read(roomId).tasks)) {
      const c = this.engine.view(roomId, taskId)!.context;
      for (const item of c.resilience?.cleanup ?? []) {
        if (item.state !== 'pending' || item.nextCheckAt > Date.now()) continue;
        const key = JSON.stringify([roomId, taskId, item.operationId]); if (this.cleanupJobs.has(key)) continue;
        const work = c.intents.find(w => w.id === item.workId), op = work?.localOperations?.find(o => o.id === item.operationId);
        if (!work || !op?.sessionId || op.status !== 'uncertain') continue;
        const job = this.localRuntime.reconcile(op).then(receipt => {
          if (!receipt || this.closing || this.retiredRooms.has(roomId)) return;
          this.engine.send(roomId, taskId, { type: 'LOCAL_RECONCILE', id: randomUUID(), at: Date.now(), intentId: work.id,
            operationId: op.id, sessionId: op.sessionId!, ...receipt });
          this.kick(roomId);
        }).catch(error => this.hostError(roomId, error)).finally(() => { this.cleanupJobs.delete(key); });
        this.cleanupJobs.set(key, job);
      }
    }
  }
  private append(
    roomId: string,
    work: Intent,
    kind: ExecutionEvent["kind"],
    title: string,
    detail: string,
  ) {
    if (this.storageClosed || this.retiredRooms.has(roomId) || this.engine.roomDeletion(roomId)?.value && this.engine.roomDeletion(roomId)?.value !== 'idle') return;
    // Never serialize service bindings, headers, environment variables or provider secrets.
    for (const service of Object.values(this.config.models?.services ?? {})) {
      const key = service.apiKeyEnv
        ? process.env[service.apiKeyEnv]
        : undefined;
      if (key) detail = detail.replaceAll(key, "[redacted]");
    }
    const taskId = work.id.slice(0, work.id.lastIndexOf(":E"));
    this.db
      .prepare(
        "INSERT INTO web_events(roomId, taskId, workId, agentId, at, kind, title, detail) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM web_rooms WHERE id=?) AND NOT EXISTS(SELECT 1 FROM room_deletions WHERE room_id=? AND json_extract(data,'$.value') <> 'idle')",
      )
      .run(
        roomId,
        taskId,
        work.id,
        work.target,
        Date.now(),
        kind,
        title,
        detail.slice(0, 64_000),
        roomId,
        roomId,
      );
  }
  private recordMeasurement(context: MeasurementContext, observation: ExecutionObservation) {
    if (this.storageClosed || this.retiredRooms.has(context.roomId) || this.engine.roomDeletion(context.roomId)?.value && this.engine.roomDeletion(context.roomId)?.value !== 'idle') return;
    const record: MeasurementRecord = { ...context, run: this.measurement, at: Date.now(), monotonicMs: performance.now(), observation };
    try {
      this.db.prepare("INSERT INTO web_events(roomId, taskId, workId, agentId, at, kind, title, detail) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM web_rooms WHERE id=?) AND NOT EXISTS(SELECT 1 FROM room_deletions WHERE room_id=? AND json_extract(data,'$.value') <> 'idle')")
        .run(record.roomId, record.taskId, record.workId, record.agentId, record.at, "measurement", observation.phase, JSON.stringify(record), record.roomId, record.roomId);
    } catch { /* Failed observation must never affect a completed operation or retry policy. */ }
  }
  private runner(roomId: string): WorkRunner {
    let runner = this.runners.get(roomId);
    if (runner) return runner;
    const observed: WorkAdapter = {
      execute: async (work, signal, scope) => {
        this.append(
          roomId,
          work,
          "started",
          work.kind === "interpretation" ? "开始理解输入" : work.kind === "check" ? "开始检查交付" : "开始执行",
          String(
            work.payload.question ??
              work.payload.reason ??
              (work.payload.goal as { text?: string } | undefined)?.text ??
              "",
          ),
        );
        const tracedScope: WorkScope = {
          sessionId: roomId,
          ...(scope.observeModel ? { observeModel: scope.observeModel } : {}),
          ...(scope.recordToolFailure ? { recordToolFailure: scope.recordToolFailure } : {}),
          ...(scope.localTools ? { localTools: {
            get catalog() { return scope.localTools!.catalog; },
            get checkpoint() { return scope.localTools!.checkpoint; },
            get sharedToolKnowledge() { return scope.localTools!.sharedToolKnowledge; },
            get toolGuidance() { return scope.localTools!.toolGuidance; },
            invoke: async (action, messages, toolSignal, requested) => {
              const labels = { discoverHost: "发现宿主能力", listSkills: "查看本地技能", loadSkill: "激活本地技能", readSkillResource: "读取技能资源", readEvidence: "查读执行证据", readArtifact: "查读历史产物", runCli: "执行本地命令", verifyWorkspace: "核对工程版本" };
              this.append(roomId, work, "tool-start", labels[action.type], JSON.stringify(this.localRuntime!.clean(action)));
              let operationId: string | undefined;
              const result = await scope.localTools!.invoke(action, messages, toolSignal, id => {
                operationId = id;
                requested?.(id);
              });
              const receipt = isSavedRead(action) ? { ok: result.ok, code: result.code } : result;
              this.append(roomId, work, "tool-result", action.type === "runCli" ? "本地命令结束" : isSavedRead(action) ? "保存内容查读结束" : "本地技能操作完成", JSON.stringify({ operationId, ...receipt }));
              return result;
            },
            resume: async (operationId, toolSignal) => {
              this.append(roomId, work, "tool-start", "续办本地操作", operationId);
              const result = await scope.localTools!.resume(operationId, toolSignal);
              const receipt = (result.code.startsWith("EVIDENCE_") || result.code.startsWith("ARTIFACT_")) ? { ok: result.ok, code: result.code } : result;
              this.append(roomId, work, "tool-result", "已读取本地操作回执", JSON.stringify({ operationId, ...receipt }));
              return result;
            },
          } satisfies NonNullable<WorkScope["localTools"]> } : {}),
          regenerateModelOutput: (issue) => {
            if (!scope.regenerateModelOutput) throw new Error('Model output repair authorization unavailable');
            scope.regenerateModelOutput(issue);
            this.append(roomId, work, "error", "模型输出格式不合规，重新生成", issue);
          },
          authorizeAdditionalRequest: (id) => {
            scope.authorizeAdditionalRequest(id);
            this.append(roomId, work, "request", "发起后续请求", id);
          },
          findSkills: async (query, toolSignal) => {
            this.append(roomId, work, "tool-start", "搜索技能", query);
            try {
              const skills = await scope.findSkills(query, toolSignal);
              this.append(
                roomId,
                work,
                "tool-result",
                "技能搜索完成",
                JSON.stringify(skills, null, 2),
              );
              return skills;
            } catch (error) {
              this.append(roomId, work, "error", "技能搜索失败", String(error));
              throw error;
            }
          },
          webSearch: async (input, toolSignal) => {
            this.append(roomId, work, "tool-start", "搜索网页", input.query);
            try {
              const result = await scope.webSearch(input, toolSignal);
              this.append(roomId, work, "tool-result", "网页搜索完成", result.text);
              return result;
            } catch (error) {
              this.append(roomId, work, "error", "网页搜索失败", String(error));
              throw error;
            }
          },
          webFetch: async (input, toolSignal) => {
            this.append(roomId, work, "tool-start", "读取网页", input.url);
            try {
              const result = await scope.webFetch(input, toolSignal);
              this.append(roomId, work, "tool-result", "网页读取完成", result.text);
              return result;
            } catch (error) {
              this.append(roomId, work, "error", "网页读取失败", String(error));
              throw error;
            }
          },
        };
        try {
          const output = await this.adapter.execute(work, signal, tracedScope);
          this.append(
            roomId,
            work,
            signal.aborted ? "cancelled" : "output",
            signal.aborted ? "执行已取消" : work.kind === "interpretation" ? "输入理解完成" : "返回执行结果",
            JSON.stringify(output, null, 2),
          );
          return output;
        } catch (error) {
          this.append(
            roomId,
            work,
            signal.aborted ? "cancelled" : "error",
            signal.aborted ? "执行已取消" : "执行失败",
            String(error),
          );
          throw error;
        }
      },
      cancel: async (work) => {
        await this.adapter.cancel?.(work);
      },
    };
    runner = new WorkRunner(this.engine, observed, Date.now, globalThis.fetch, this.webTools, this.localRuntime,
      (context, observation) => this.recordMeasurement(context, observation));
    this.runners.set(roomId, runner);
    return runner;
  }
  private hostError(roomId: string, error: unknown) {
    if (this.storageClosed || this.retiredRooms.has(roomId)) return;
    this.failedRooms.add(roomId);
    console.error(
      `Web host failure in room ${roomId}:`,
      error instanceof Error ? error.name : "Unknown error",
    );
    // Surface unexpected host failures instead of leaving a task looking healthy.
    try {
      const view = this.engine.view(roomId);
      if (view) {
        this.engine.send(roomId, view.context.taskId, {
          type: "SUPERVISE",
          id: randomUUID(),
          at: Date.now(),
          trigger: 'hostFailure', reason: '执行服务发生错误，正在核查并尝试恢复。',
        });
      }
    } catch { this.hostFault = true; /* A storage fault cannot claim durable recovery; the independent watchdog restarts it. */ }
  }
  private kick(roomId: string) {
    if (this.closing || !this.initialized || this.failedRooms.has(roomId) || this.engine.roomDeletion(roomId)?.value && this.engine.roomDeletion(roomId)?.value !== 'idle') return;
    for (const taskId of Object.keys(this.store.read(roomId).tasks)) {
    while (this.engine.flushResults(roomId, taskId)) { /* Consume durable handoffs before projecting successors. */ }
    for (const work of this.engine.pending(roomId, taskId)) {
      const key = `${roomId}:${work.id}`;
      if (this.running.has(key)) continue;
      let progressed = false;
      // The machine supplies eligibility; the transactional claim still checks every lock and budget.
      const job = Promise.resolve()
        .then(() => this.closing ? false : this.runner(roomId).runOne(roomId, taskId, work.id))
        .then(value => { progressed = value; })
        .catch((error) => this.hostError(roomId, error))
        .finally(() => {
          this.running.delete(key);
          if (progressed) this.kick(roomId);
        });
      this.running.set(key, { roomId, taskId, job });
    }
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.advanceLifecycle('CLOSE');
    clearInterval(this.timer);
    this.closePromise = this.shutdown();
    return this.closePromise;
  }
  private async shutdown(): Promise<void> {
    // ready owns startup failure; it cannot bypass resource cleanup.
    const grace = this.config.resilience?.cancelGraceMs ?? 5000;
    await this.deletions.close(grace);
    await this.bounded(this.startup.catch(() => {}), grace);
    try {
      await this.stopRunning();
    } finally {
      this.storageClosed = true;
      try { this.db.close(); }
      finally {
        try { this.store.close(); }
        finally { this.advanceLifecycle('CLOSED'); }
      }
    }
  }
  private async stopRunning(): Promise<void> {
    for (const room of this.rooms()) {
      const roomId = room.id;
      if (this.engine.roomDeletion(roomId)?.value && this.engine.roomDeletion(roomId)?.value !== 'idle') continue;
      for (const taskId of Object.keys(this.store.read(roomId).tasks)) {
        const active = this.engine.view(roomId, taskId)!.context.intents.filter(work => work.kind !== 'cancel' && work.status === 'inflight');
        if (active.length && active.every(localAwaitingApproval)) {
          this.runner(roomId).suspendApprovals(roomId, taskId);
          continue;
        }
        if (active.length) this.engine.send(roomId, taskId, {
          type: "STOP",
          id: randomUUID(),
          at: Date.now(),
        });
        if (active.length) this.scheduleCancellation(roomId, taskId);
      }
    }
    for (const runner of this.runners.values()) runner.abortExecutions();
    await Promise.all([...this.runners.values()].map(runner => runner.drainExecutions(this.config.resilience?.cancelGraceMs ?? 5000)));
    for (const room of this.rooms()) for (const taskId of Object.keys(this.store.read(room.id).tasks)) {
      if (this.engine.roomDeletion(room.id)?.value && this.engine.roomDeletion(room.id)?.value !== 'idle') continue;
      const c = this.engine.view(room.id, taskId)!.context;
      if (!c.intents.some(work => work.status === 'inflight' && !localAwaitingApproval(work) || work.status === 'uncertain')) continue;
      this.engine.send(room.id, taskId, { type: 'RECOVER', id: randomUUID(), at: Date.now(), config: this.config });
      this.engine.send(room.id, taskId, { type: 'SUPERVISE', id: randomUUID(), at: Date.now(), trigger: 'recover' });
    }
    for (const runner of this.runners.values()) runner.detachExecutions();
    await this.bounded(Promise.allSettled([...this.running.values(), ...this.cancellationJobs.values()].map(work => work.job).concat([...this.cleanupJobs.values()])), 100);
  }
  private async bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof hostTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = hostTimeout(() => resolve(undefined), timeoutMs); })]); }
    finally { if (timer) clearHostTimeout(timer); }
  }
}
