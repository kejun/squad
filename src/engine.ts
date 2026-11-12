import { heldLocalResourceLeases, localAwaitingApproval, localEnabled, localPhysicalPending, type LocalAction, type LocalMessage, type LocalOperation } from './local-operation.js';
import { createHash, randomUUID } from 'node:crypto';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, startTaskExecution, executionState, workLaneAvailable, type TaskSnapshot } from './task.machine.js';
import { deletionStore, RoomDeletionError, type Store, type Transaction, type DeletionSettlementProof } from './store.js';
import { conversationHistory, requestedReviewTargets } from './conversation.js';
import { requestedRetryTarget, retryableAssistance, retryProblemText } from './assistance-retry.js';
import { inputControl, leadingInputMention } from './input-intent.js';
import { debugFrame, type DebugEvent, type DebugFrame } from './task-debug.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from './task-inspection.js';
import { validateConfig, type Goal, type Intent, type Reply, type TaskContext, type TaskEvent, type TeamConfig } from './types.js';
import { canRetireDiscussionWork, recoveryIssue } from './task/facts.js';
import { legacyTerminalConfig, taskProtocolChanged, taskStorageVersion } from './task/protocol.js';
import { restoreRoomArchive, stepRoomArchive } from './room.machine.js';
import { hostRetryAction, hostRetryBatchRetirable } from './host-retry.js';
import { parseArtifactRequest, resolveArtifactSource } from './source-artifact.js';
import type { ArtifactReference, ArtifactSource, ArtifactSourceMetadata } from './types.js';
import type { HostAcquisition } from './resource-acquisition.js';
import { processingWindow, taskHumanGate } from './task/resilience.js';
import { permissionProblem } from './task/policy.js';
import type { DeletionIntent, SavedRoomDeletion } from './room-deletion.machine.js';
import { runtimeCleanupPlan } from './runtime-ownership.js';
import { unconfinedEffectsKey, type LocalResourcePolicy } from './local-resource-policy.js';

interface StoredTask { version: 1 | 2 | 3; snapshot: unknown }
const protocolBoundEvents = new Set<TaskEvent['type']>([
  'CLAIM', 'CONSUME', 'REGENERATE_MODEL_OUTPUT', 'LOCAL_REQUEST', 'LOCAL_CLAIM', 'LOCAL_STARTED',
  'LOCAL_APPROVAL_REQUIRED', 'LOCAL_APPROVAL_DECISION', 'LOCAL_PREPARED', 'DELIVER', 'CHECK_RESULT', 'HELP_RESULT', 'WORK_FAILED',
]);
export interface CommandResult extends Reply { taskId?: string; duplicate?: boolean; sourceCandidates?: ArtifactSourceMetadata[]; roomId?: string; deletionVersion?: number }
export interface Submission {
  id: string; text: string; mentions?: string[]; goal?: Goal;
  intent?: 'new' | 'supplement' | 'decision' | 'continue' | 'retry'; replyToTaskId?: string;
  retryAssistanceId?: string;
  extraOrdinary?: number;
  newWindowMs?: number;
  sourceArtifact?: ArtifactReference;
}
export interface TaskView { phase: ReturnType<typeof taskPhase>; context: TaskContext }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function fingerprint(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function decode(value: unknown): TaskSnapshot {
  const record = value as StoredTask;
  if (record?.version !== 1 && record?.version !== 2 && record?.version !== 3) throw new Error('Incompatible machine snapshot');
  const result = restoreTask(record.snapshot);
  if (result.context.schemaVersion !== 1) throw new Error('Incompatible task context');
  return result;
}
function storeTask(tx: Transaction, snapshot: TaskSnapshot, activate = false) {
  const id = snapshot.context.taskId;
  tx.room.tasks[id] = { version: taskStorageVersion(snapshot.context.config), snapshot: persistTask(snapshot) } satisfies StoredTask;
  if (taskPhase(snapshot) === 'ended') { if (tx.room.activeTaskId === id) tx.room.activeTaskId = null; }
  else if (activate && !tx.room.activeTaskId) tx.room.activeTaskId = id;
}

const windowExpiryUnobserved = (c: TaskContext) => c.outcome === null && !processingWindow(c).failure;

/** All public commands cross the same transaction seam; no effect is executed here. */
export class TeamEngine {
  private storageFault = false;
  private readonly instanceId = randomUUID();
  private pendingObservations: DebugFrame[] | null = null;
  private observationTransaction: string | null = null;
  get healthy(): boolean { return !this.storageFault; }
  constructor(readonly store: Store, readonly config: TeamConfig, private readonly clock: () => number = Date.now,
    private readonly observe?: (roomId: string, frame: DebugFrame) => void) { validateConfig(config); }

  private record(snapshot: TaskSnapshot, event: DebugEvent, from: ReturnType<typeof taskPhase> | null, evidence?: DebugEvidence) {
    if (!this.observe || !this.pendingObservations) return;
    // Debug serialization must never change the result of a business transaction.
    try { this.pendingObservations.push({ ...debugFrame(snapshot, event, from, evidence), transactionId: this.observationTransaction! }); } catch { /* Best-effort observation. */ }
  }
  private step(snapshot: TaskSnapshot, event: TaskEvent): TaskSnapshot {
    let next: TaskSnapshot, evidence: DebugEvidence | undefined;
    if (this.observe) {
      try { const inspected = inspectTask(snapshot, event); next = inspected.snapshot; evidence = inspected.evidence; }
      catch { next = stepTask(snapshot, event); }
    } else next = stepTask(snapshot, event);
    this.record(next, event, taskPhase(snapshot), evidence);
    return next;
  }

  private transact<T>(roomId: string, fn: (tx: Transaction) => T, proof?: DeletionSettlementProof): T {
    if (this.storageFault) throw new Error('Storage fault: reopen engine before dispatching more work');
    const observations: DebugFrame[] = [];
    this.pendingObservations = this.observe ? observations : null;
    this.observationTransaction = this.observe ? randomUUID() : null;
    let result: T;
    try { result = proof ? deletionStore(this.store).transactDeletionSettlement(roomId, proof, fn) : this.store.transact(roomId, fn); }
    catch (error) {
      // Domain rejections are values; thrown errors at this seam are storage/program faults.
      if (!(error instanceof RoomDeletionError)) this.storageFault = true;
      throw error;
    }
    finally { this.pendingObservations = null; this.observationTransaction = null; }
    // The commit already succeeded. Observer failures cannot poison the engine or its receipt.
    for (const observation of observations) {
      try { this.observe?.(roomId, observation); } catch { /* The next read supplies the current baseline. */ }
    }
    return result;
  }
  roomDeletion(roomId: string): SavedRoomDeletion | undefined {
    return 'readDeletion' in this.store ? deletionStore(this.store).readDeletion(roomId) : undefined;
  }
  private deletionRejection(roomId: string): CommandResult | undefined {
    const deletion = this.roomDeletion(roomId);
    if (deletion && deletion.value !== 'idle') return { ok: false, code: deletion.value === 'deleted' ? 'ROOM_DELETED' : 'ROOM_DELETING', detail: '会话正在删除或已删除，不能再提交业务操作。' };
    return undefined;
  }
  requestRoomDeletion(roomId: string, id: string, expectedArchiveVersion: number, force = false, includeRuntimeFiles = true): SavedRoomDeletion {
    const room = this.store.read(roomId), previous = this.roomDeletion(roomId);
    const archive = previous?.context.dataErased
      ? { archived: true, archiveVersion: previous.context.archiveVersion! } : this.roomArchive(roomId);
    const inventory = previous?.context.dataErased
      ? { tasks: previous.context.tasks, sessions: previous.context.sessions, assets: previous.context.assets,
        complete: true, executionsSettled: false, blockers: [] }
      : runtimeCleanupPlan(roomId, Object.values(room.tasks).map(stored => {
        const snapshot = decode(stored); return { phase: taskPhase(snapshot), context: snapshot.context };
      }));
    if (!includeRuntimeFiles && !previous?.context.assets.length) { inventory.assets = []; inventory.sessions = []; }
    return deletionStore(this.store).stepDeletion(roomId, { type: 'REQUEST', id, at: this.clock(), roomId,
      deletionId: `deletion:${fingerprint({ roomId, id })}`, requestDigest: fingerprint({ roomId, id, expectedArchiveVersion }),
      confirmed: true, authorized: true, archived: archive.archived, archiveVersion: archive.archiveVersion, expectedArchiveVersion,
      allTasks: inventory.tasks.map(({ taskId, namespace }) => ({ taskId, namespace })),
      ...(force ? { force: true, inventory } : {}) });
  }
  prepareRoomDeletion(roomId: string, deletionId: string, intent: DeletionIntent, afterQuiescence = false): void {
    // Verification retries retain the deletion manifest after business data is erased.
    // Preparing an empty room again would recreate the row that verification must find absent.
    const deletion = this.roomDeletion(roomId);
    if (deletion?.context.deletionId === deletionId && deletion.context.dataErased) return;
    this.transact(roomId, tx => {
      for (const [taskId, stored] of Object.entries(tx.room.tasks)) {
        let next = decode(stored);
        next = this.step(next, { type: 'STOP', id: `${deletionId}:stop:${taskId}`, at: this.clock() });
        next = this.step(next, { type: 'RECOVER', id: `${deletionId}:recover:${taskId}:${intent.attempt}`, at: this.clock(), config: this.config });
        next = this.step(next, { type: 'SUPERVISE', id: `${deletionId}:custody:${taskId}:${intent.attempt}`, at: this.clock(), trigger: 'recover' });
        if (afterQuiescence) for (const work of next.context.intents) {
          if (work.replay !== 'unsafe' && work.kind !== 'tool' && !localPhysicalPending(work) && ['pending', 'inflight', 'uncertain'].includes(work.status))
            next = this.step(next, { type: 'SETTLE', id: `${deletionId}:retire:${work.id}:${intent.attempt}`, at: this.clock(), intentId: work.id });
          for (const op of work.localOperations ?? []) if (['succeeded', 'failed', 'cancelled'].includes(op.status) && op.workspaceId)
            { const owner = fingerprint({ roomId, taskId, operationId: op.id });
              tx.releaseWorkspace(op.workspaceId, owner); tx.releaseResources?.(heldLocalResourceLeases(op).map(lease => lease.key), owner); }
        }
        storeTask(tx, next);
      }
    }, { deletionId, intentId: intent.id, attempt: intent.attempt });
  }
  private receipt(tx: Transaction, id: string, payload: unknown, operation: () => CommandResult,
    remember: (result: CommandResult) => boolean = () => true): CommandResult {
    const hash = fingerprint(payload);
    const previous = tx.receipt(id);
    if (previous) {
      if (previous.fingerprint !== hash) return { ok: false, code: 'REQUEST_ID_CONFLICT', detail: 'A request identity cannot be reused for different content' };
      return { ...(previous.result as CommandResult), duplicate: true };
    }
    const result = operation();
    if (remember(result)) tx.remember(id, hash, result);
    return result;
  }
  roomArchive(roomId: string) {
    const state = restoreRoomArchive(this.store.read(roomId).archive);
    return { archived: state.value === 'archived', archiveVersion: state.context.revision };
  }
  setRoomArchived(roomId: string, id: string, archived: boolean): CommandResult {
    const blocked = this.deletionRejection(roomId); if (blocked) return blocked;
    if (!id || id.length > 120) return { ok: false, code: 'INVALID_REQUEST', detail: '缺少请求标识。' };
    return this.transact(roomId, tx => this.receipt(tx, id, { type: archived ? 'archiveRoom' : 'restoreRoom', id }, () => {
      tx.room.archive = stepRoomArchive(tx.room.archive, { type: archived ? 'ARCHIVE' : 'RESTORE', at: this.clock() });
      return { ok: true, code: 'OK', detail: archived ? '已归档' : '已恢复' };
    }));
  }
  submit(roomId: string, input: Submission): CommandResult {
    const blocked = this.deletionRejection(roomId); if (blocked) return blocked;
    return this.transact(roomId, tx => this.receipt(tx, input.id, input, () => {
      if (input.replyToTaskId !== undefined && !tx.room.tasks[input.replyToTaskId])
        return { ok: false, code: 'TASK_NOT_FOUND', detail: '指定的任务不存在，请重新选择任务。' };
      if (input.sourceArtifact && (input.intent !== undefined && input.intent !== 'new'
        || input.replyToTaskId !== undefined || input.retryAssistanceId !== undefined || input.extraOrdinary !== undefined
        || inputControl(input.text) || requestedRetryTarget(input.text, this.config.bots))) {
        return { ok: false, code: 'INVALID_SOURCE_COMMAND', detail: '产物引用不能与停止、继续、重试或人工决策控制同时提交，请移除引用或重新发送修改要求。' };
      }
      const control = input.intent === undefined || input.intent === 'decision' || input.intent === 'supplement' ? inputControl(input.text) : undefined;
      if (control === 'continue') input = { ...input, intent: 'continue' };
      const mention = leadingInputMention(input.text);
      if (!input.mentions?.length && mention) input = { ...input, mentions: [mention] };
      const at = this.clock();
      const referencedId = input.replyToTaskId ?? tx.room.activeTaskId ?? Object.keys(tx.room.tasks).at(-1);
      const referenced = referencedId && tx.room.tasks[referencedId] ? decode(tx.room.tasks[referencedId]).context : undefined;
      if (control === 'stop') {
        if (!referencedId || !referenced) return { ok: false, code: 'TASK_NOT_FOUND', detail: '没有可停止的任务' };
        const next = this.step(decode(tx.room.tasks[referencedId]), { type: 'STOP', id: input.id, text: input.text, at });
        storeTask(tx, next);
        return { ...next.context.reply, taskId: referencedId };
      }
      const retryBots = [...this.config.bots, ...(referenced?.config.bots ?? []),
        ...(referenced?.assists ?? []).map(h => ({ id: h.target, name: h.target, instructions: '', tools: [] }))];
      const retryTarget = ['new', 'continue'].includes(input.intent ?? '') ? undefined : requestedRetryTarget(input.text, retryBots);
      const retryRequested = input.intent === 'retry' || retryTarget !== undefined;
      const retryReject = (code: string): CommandResult => ({ ok: false, code, detail: retryProblemText(code) });
      const artifactRequest = control || retryRequested || input.intent === 'continue' ? undefined : parseArtifactRequest(input.text);
      let sourceArtifact: ArtifactSource | undefined;
      if (input.sourceArtifact || artifactRequest) {
        const sources = Object.values(tx.room.tasks).map(task => {
          const snapshot = decode(task); return { phase: taskPhase(snapshot), context: snapshot.context };
        });
        const resolution = resolveArtifactSource(sources, input.sourceArtifact, artifactRequest);
        if (resolution.kind !== 'none' && tx.room.activeTaskId) return {
          ok: false, code: 'ROOM_BUSY', detail: '请等待当前任务结束后重新发送，输入和产物引用会保留。' };
        if (resolution.kind === 'rejected') return { ok: false, code: resolution.code, detail: resolution.detail,
          ...(resolution.sourceCandidates ? { sourceCandidates: resolution.sourceCandidates } : {}) };
        if (resolution.kind === 'resolved') {
          sourceArtifact = resolution.sourceArtifact;
        }
      }
      if (input.intent === 'retry' && (!input.replyToTaskId || !input.retryAssistanceId)) return retryReject('RETRY_REFERENCE_REQUIRED');
      const existingId = sourceArtifact ? null : input.replyToTaskId ?? tx.room.activeTaskId ?? (['decision', 'continue'].includes(input.intent ?? '') || retryRequested ? Object.keys(tx.room.tasks).at(-1) : null);
      if (existingId && tx.room.tasks[existingId]) {
        const current = decode(tx.room.tasks[existingId]);
        if (tx.room.activeTaskId && tx.room.activeTaskId !== existingId)
          return { ok: false, code: 'ROOM_BUSY', detail: '另一任务正在执行，请等待结束后再继续原任务。' };
        if (retryRequested) {
          if (tx.room.activeTaskId && tx.room.activeTaskId !== existingId) return retryReject('ROOM_BUSY');
          const candidates = current.context.assists.filter(h => h.target === retryTarget && retryableAssistance(h)
            && h.epoch === current.context.epoch && h.goalVersion === current.context.goalVersion
            && !current.context.assists.some(next => next.retryOf === h.id));
          const requestId = input.intent === 'retry' ? input.retryAssistanceId : candidates.length === 1 ? candidates[0]!.id : undefined;
          if (!requestId) return retryReject(candidates.length > 1 ? 'AMBIGUOUS_ASSISTANCE' : 'ASSISTANCE_NOT_FOUND');
          const next = this.step(current, { type: 'RETRY_ASSISTANCE', id: input.id, at, text: input.text, requestId, config: this.config });
          storeTask(tx, next, next.context.reply.ok);
          return { ...next.context.reply, detail: next.context.reply.ok ? '协助重试已受理' : retryProblemText(next.context.reply.code), taskId: existingId };
        }
        const history = conversationHistory(Object.entries(tx.room.tasks).filter(([id]) => id !== existingId).map(([, task]) => decode(task).context), current.context.sourceArtifact);
        const reviewTargets = requestedReviewTargets(input.text, input.mentions ?? [], this.config.bots, current.context.owner);
        const conversation = { history, ...(reviewTargets ? { reviewTargets } : {}) };
        if (input.intent === 'decision') {
          const next = this.step(current, { type: 'HUMAN_DECISION', id: input.id, at, text: input.text, ...conversation }); storeTask(tx, next);
          return { ...next.context.reply, taskId: existingId };
        }
        if (input.intent === 'continue') {
          if (tx.room.activeTaskId && tx.room.activeTaskId !== existingId) return { ok: false, code: 'ROOM_BUSY', detail: 'Another task is active' };
          const event: TaskEvent = { type: 'CONTINUE', id: input.id, text: input.text, at, currentConfig: this.config,
            ...(input.newWindowMs === undefined ? {} : { newWindowMs: input.newWindowMs }),
            ...(input.extraOrdinary === undefined ? {} : { extraOrdinary: input.extraOrdinary }) };
          const next = this.step(current, event); storeTask(tx, next, next.context.reply.ok);
          return { ...next.context.reply, taskId: existingId };
        }
        if (taskPhase(current) === 'ended') return { ok: false, code: 'EXPLICIT_CONTINUATION_REQUIRED', detail: 'Explicitly continue the referenced ended task' };
        if (input.intent === 'new') {
          tx.room.notices.push({ id: input.id, text: '另开群或等待当前工作结束' });
          return { ok: false, code: 'ROOM_BUSY', detail: '另开群或等待当前工作结束' };
        }
        const next = this.step(current, { type: 'USER_INPUT', id: input.id, at, text: input.text, ...conversation, ...(input.goal ? { goal: input.goal } : {}) });
        storeTask(tx, next);
        return { ...next.context.reply, taskId: existingId };
      }
      if (retryRequested) return retryReject('TASK_NOT_FOUND');
      if (input.intent === 'continue') return { ok: false, code: 'TASK_NOT_FOUND', detail: 'Provide an existing task to continue' };
      if (input.intent === 'decision' || input.intent === 'supplement')
        return { ok: false, code: 'TASK_NOT_FOUND', detail: '没有可接收本次输入的任务。' };
      if (tx.room.activeTaskId) return { ok: false, code: 'ROOM_BUSY', detail: '当前任务仍在执行。' };
      const owner = input.mentions?.[0] ?? sourceArtifact?.owner ?? this.config.defaultBot;
      if (!this.config.bots.some(bot => bot.id === owner)) return sourceArtifact && !input.mentions?.length
        ? { ok: false, code: 'SOURCE_OWNER_UNAVAILABLE', detail: '原负责人已不在当前配置中，请直接 @ 一位现有成员后重新发送。' }
        : { ok: false, code: 'UNKNOWN_BOT', detail: owner };
      const taskId = `task:${input.id}`;
      const goal = input.goal ?? { text: input.text, constraints: [], criteria: ['Answer the user request'], requiredArtifacts: 0 };
      const history = conversationHistory(Object.values(tx.room.tasks).map(task => decode(task).context), sourceArtifact);
      const reviewTargets = requestedReviewTargets(input.text, input.mentions ?? [], this.config.bots, owner);
      const taskInput = { taskId, owner, goal, config: this.config, at,
        message: { id: input.id, text: input.text, author: 'user', at, taskId, kind: 'user' as const }, history,
        ...(sourceArtifact ? { sourceArtifact } : {}), ...(reviewTargets ? { reviewTargets } : {}) };
      let snapshot: TaskSnapshot, evidence: DebugEvidence | undefined;
      if (this.observe) {
        try { const inspected = inspectInitialTask(taskInput); snapshot = inspected.snapshot; evidence = inspected.evidence; }
        catch { snapshot = initialTask(taskInput); }
      } else snapshot = initialTask(taskInput);
      this.record(snapshot, { type: '@init', id: input.id, at }, null, evidence);
      storeTask(tx, snapshot, true);
      return { ok: true, code: 'OK', detail: 'created', taskId };
    }));
  }
  send(roomId: string, taskId: string, event: TaskEvent): CommandResult {
    if (event.type.startsWith('EXECUTION_') || event.type === 'RECORD_ACQUISITION') return { ok: false, code: 'HOST_ONLY_EVENT', detail: 'Execution protocol requires the trusted runner' };
    return this.dispatch(roomId, taskId, event);
  }
  executionNotStarted(roomId: string, taskId: string, work: Intent, reason: string): CommandResult {
    const blocked = this.deletionRejection(roomId); if (blocked) return blocked;
    const event: TaskEvent = { type: 'EXECUTION_NOT_STARTED', id: `not-started:${work.id}:${work.attempt}`,
      at: this.clock(), intentId: work.id, attempt: work.attempt, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, reason };
    return this.transact(roomId, tx => this.receipt(tx, event.id, { taskId, workId: work.id, attempt: work.attempt, reason }, () => {
      const stored = tx.room.tasks[taskId]; if (!stored) return { ok: false, code: 'TASK_NOT_FOUND', detail: taskId };
      const current = decode(stored), phase = executionState(current, work.id, work.attempt);
      if (phase !== 'authorized' && phase !== 'cancelled') return { ok: false, code: 'EXECUTION_START_UNVERIFIED', detail: '执行许可已经使用或无法证明从未启动。', taskId };
      const next = this.step(current, event); storeTask(tx, next); return { ...next.context.reply, taskId };
    }));
  }
  recordAcquisition(roomId: string, taskId: string, receipt: HostAcquisition): CommandResult {
    return this.dispatch(roomId, taskId, { type: 'RECORD_ACQUISITION', id: `acquisition:${receipt.id}`, at: this.clock(),
      intentId: receipt.workId, attempt: receipt.attempt, fence: { epoch: receipt.epoch, goalVersion: receipt.goalVersion }, receipt });
  }
  private dispatch(roomId: string, taskId: string, event: TaskEvent): CommandResult {
    const deletion = this.roomDeletion(roomId);
    let proof: DeletionSettlementProof | undefined;
    if (deletion && deletion.value !== 'idle') {
      if (deletion.value === 'deleted' || !['LOCAL_RESULT', 'LOCAL_RECONCILE', 'LOCAL_STARTED', 'LOCAL_APPROVAL_REQUIRED', 'SETTLE', 'WORK_FAILED'].includes(event.type))
        return this.deletionRejection(roomId)!;
      const workId = 'intentId' in event ? event.intentId : event.workId;
      if (!workId) return this.deletionRejection(roomId)!;
      proof = { deletionId: deletion.context.deletionId!, taskId, workId,
        ...('operationId' in event ? { operationId: event.operationId } : {}),
        ...('sessionId' in event ? { sessionId: event.sessionId } : {}), ...(event.attempt === undefined ? {} : { attempt: event.attempt }) };
    }
    const { at: _at, ...identity } = event;
    return this.transact(roomId, tx => {
      const value = tx.room.tasks[taskId];
      const needsProtocol = protocolBoundEvents.has(event.type) || (event.workId !== undefined && event.type !== 'SETTLE');
      const checked = value && needsProtocol ? decode(value) : undefined;
      const cancellationId = event.type === 'CLAIM' || event.type === 'WORK_FAILED' ? event.intentId : undefined;
      if (checked && taskProtocolChanged(checked.context.config, this.config)
        && (!cancellationId || checked.context.intents.find(work => work.id === cancellationId)?.kind !== 'cancel')) {
        // Reject before taking the receipt key; existing physical operations can still settle.
        return { ok: false, code: 'INCOMPATIBLE_EXECUTION', detail: '运行协议与任务不兼容', taskId };
      }
      return this.receipt(tx, event.id, { taskId, event: identity }, () => {
        if (!value) return { ok: false, code: 'TASK_NOT_FOUND', detail: taskId };
        const current = checked ?? decode(value);
        if (event.type === 'CLAIM') {
          const work = current.context.intents.find(work => work.id === (event as Extract<TaskEvent, { type: 'CLAIM' }>).intentId);
          if (work?.replay === 'unsafe' && work.kind !== 'cancel' && work.status === 'pending' && !permissionProblem(current.context, event)) {
            const owner = fingerprint({ roomId, taskId, operationId: work.id });
            if (!tx.acquireResources?.([{ key: unconfinedEffectsKey, mode: 'write', phase: 'execute' }], owner))
              return { ok: false, code: 'WORK_BUSY', detail: '实际执行资源仍由其他未决效果占用。', taskId };
            // On commit the unsafe inflight snapshot becomes the durable barrier, including legacy stores.
            tx.releaseResources?.([unconfinedEffectsKey], owner);
          }
        }
        let leasedKey: string | undefined;
        let leasedOwner: string | undefined;
        let leasedResources: string[] | undefined;
        if (event.type === 'LOCAL_CLAIM') {
          const local = event;
          const op = current.context.intents.find(i => i.id === local.intentId)?.localOperations?.find(o => o.id === local.operationId);
          if (op?.workspaceId && op.status === 'queued') {
            leasedKey = op.workspaceId; leasedOwner = fingerprint({ roomId, taskId, operationId: event.operationId });
            if (op.resourceLeases?.length) {
              const leases = heldLocalResourceLeases(op);
              const available = tx.acquireResources?.(leases, leasedOwner) ?? false;
              if (available) leasedResources = leases.map(lease => lease.key);
              leasedKey = undefined;
              event = { ...event, leaseAvailable: available };
            } else event = { ...event, leaseAvailable: tx.acquireWorkspace(leasedKey, leasedOwner) };
          }
        }
        let next = this.step(current, event);
        if (event.type === 'LOCAL_CLAIM' && !next.context.reply.ok && leasedKey && leasedOwner) tx.releaseWorkspace(leasedKey, leasedOwner);
        if (event.type === 'LOCAL_CLAIM' && !next.context.reply.ok && leasedResources && leasedOwner) tx.releaseResources?.(leasedResources, leasedOwner);
        if (event.type === 'LOCAL_PREPARED' && next.context.reply.ok) {
          const op = next.context.intents.find(w => w.id === (event as Extract<TaskEvent, { type: 'LOCAL_PREPARED' }>).intentId)?.localOperations?.find(op => op.id === (event as Extract<TaskEvent, { type: 'LOCAL_PREPARED' }>).operationId);
          if (op) tx.releaseResources?.(op.resourceLeases?.filter(lease => lease.phase === 'prepare').map(lease => lease.key) ?? [], fingerprint({ roomId, taskId, operationId: op.id }), 'prepare');
        }
        if (event.type === 'LOCAL_RESULT' || event.type === 'LOCAL_RECONCILE' || event.type === 'LOCAL_APPROVAL_REQUIRED') {
          const local = event;
          const op = next.context.intents.find(i => i.id === local.intentId)?.localOperations?.find(o => o.id === local.operationId);
          if (op?.workspaceId && ['succeeded', 'failed', 'cancelled', 'queued', 'awaitingApproval'].includes(op.status) && next.context.reply.ok) {
            tx.releaseWorkspace(op.workspaceId, fingerprint({ roomId, taskId, operationId: event.operationId }));
            tx.releaseResources?.(op.resourceLeases?.map(lease => lease.key) ?? [], fingerprint({ roomId, taskId, operationId: event.operationId }));
          }
        }
        const reply = { ...next.context.reply, taskId };
        if (event.type === 'CLAIM' && ['BUDGET_EXHAUSTED', 'DISCUSSION_BUDGET_RESERVED', 'WORK_EXPIRED'].includes(reply.code)
          && current.context.intents.find(work => work.id === (event as Extract<TaskEvent, { type: 'CLAIM' }>).intentId)?.discussionId) {
          next = this.step(next, { type: 'WORK_FAILED', id: `${event.id}:discussion`, at: event.at, intentId: event.intentId, reason: reply.code, transient: false });
        } else if (event.type === 'CLAIM' && reply.code === 'BUDGET_EXHAUSTED') {
          next = this.step(next, { type: 'EXHAUSTED', id: `${event.id}:budget`, at: event.at, reason: 'Execution budget exhausted' });
        } else if (event.type === 'CLAIM' && ['REVIEW_SYNTHESIS_RESERVED', 'ASSISTANCE_SYNTHESIS_RESERVED'].includes(reply.code)) {
          // A recovered reviewer must settle through the review queue, preserving the owner's final request.
          next = this.step(next, { type: 'WORK_FAILED', id: `${event.id}:reserved`, at: event.at, intentId: event.intentId,
            reason: `${reply.code}: 已保留负责人续办额度，当前协助工作无法继续`, transient: false });
        }
        storeTask(tx, next);
        return reply;
      }, result => {
        if (!result.ok && event.type === 'RECORD_ACQUISITION' && result.code === 'ACQUISITION_WORK_UNAVAILABLE') return false;
        return event.type !== 'CLAIM' || result.ok || !['WORK_BUSY', 'WORK_NOT_PENDING', 'HOST_APPROVAL_REQUIRED', 'WAIT_FOR_BOUNDARY'].includes(result.code);
      });
    }, proof);
  }
  localNamespace(roomId: string, taskId: string): string { return fingerprint({ roomId, taskId }); }
  requestHostRetry(roomId: string, taskId: string, sourceWorkId: string, sourceOperationId: string, sourceRequestHash: string, commandId: string): CommandResult {
    const blocked = this.deletionRejection(roomId); if (blocked) return blocked;
    return this.transact(roomId, tx => this.receipt(tx, commandId, { taskId, sourceWorkId, sourceOperationId, sourceRequestHash }, () => {
      if (!tx.room.tasks[taskId]) return { ok: false, code: 'TASK_NOT_FOUND', detail: '找不到原任务' };
      if ((tx.room.activeTaskId ?? Object.keys(tx.room.tasks).at(-1)) !== taskId) return { ok: false, code: 'ROOM_BUSY', detail: '另一任务已成为当前任务' };
      const current = decode(tx.room.tasks[taskId]), c = current.context;
      if (recoveryIssue(c, this.config) && !legacyTerminalConfig(c, this.config)) {
        return { ok: false, code: 'INCOMPATIBLE_EXECUTION', detail: '运行配置已变化，请先恢复任务' };
      }
      const source = c.intents.find(w => w.id === sourceWorkId), op = source?.localOperations?.find(o => o.id === sourceOperationId);
      if (!op || op.action.type !== 'runCli') return { ok: false, code: 'NOT_FAILED_SANDBOX_COMMAND', detail: '找不到失败的沙箱命令' };
      if (!localEnabled(this.config, c.owner) || source && !localEnabled(this.config, source.target)) return { ok: false, code: 'LOCAL_TOOLS_DISABLED', detail: '本地工具权限已关闭' };
      const next = this.step(current, { type: 'REQUEST_HOST_RETRY', id: commandId, at: this.clock(), sourceWorkId, sourceOperationId, sourceRequestHash,
        requestHash: fingerprint({ action: hostRetryAction(op), workspaceId: op.workspaceId, namespace: op.namespace }), currentConfig: this.config, fence: { epoch: c.epoch, goalVersion: c.goalVersion } });
      storeTask(tx, next, next.context.reply.ok); return { ...next.context.reply, taskId };
    }));
  }
  decideHostApproval(roomId: string, taskId: string, intentId: string, operationId: string, approvalId: string, decision: 'approve' | 'approveSession' | 'deny', commandId: string): CommandResult {
    const work = this.view(roomId, taskId)?.context.intents.find(i => i.id === intentId);
    if (!work) return { ok: false, code: 'UNKNOWN_WORK', detail: '找不到授权请求' };
    if (!localEnabled(this.config, work.target)) return { ok: false, code: 'LOCAL_TOOLS_DISABLED', detail: '本地工具权限已关闭' };
    return this.send(roomId, taskId, { type: 'LOCAL_APPROVAL_DECISION', id: commandId, at: this.clock(), intentId, operationId, approvalId, decision,
      fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
  }
  revokeHostSession(roomId: string, taskId: string, grantId: string, commandId: string): CommandResult {
    const c = this.view(roomId, taskId)?.context;
    if (!c) return { ok: false, code: 'TASK_NOT_FOUND', detail: taskId };
    return this.send(roomId, taskId, { type: 'REVOKE_HOST_SESSION', id: commandId, at: this.clock(), grantId,
      fence: { epoch: c.epoch, goalVersion: c.goalVersion } });
  }
  requestLocal(roomId: string, taskId: string, intentId: string, parentAttempt: number, action: LocalAction, messages: LocalMessage[], workspaceId?: string, resources?: LocalResourcePolicy): LocalOperation {
    const work = this.view(roomId, taskId)?.context.intents.find(i => i.id === intentId);
    if (!work) throw new Error('UNKNOWN_WORK');
    const operationId = `${intentId}:local:${work.localCheckpoint?.nextOperation ?? 0}`;
    const requestHash = fingerprint({ action, workspaceId: workspaceId ?? null, namespace: this.localNamespace(roomId, taskId), ...(resources ? { resources } : {}) });
    // A rejected action creates no operation. A different action at that slot needs its own receipt.
    const receiptHash = fingerprint({ requestHash, parentAttempt, messages });
    const response = this.send(roomId, taskId, { type: 'LOCAL_REQUEST', id: `local-request:${operationId}:${receiptHash}`, at: this.clock(),
      intentId, operationId, parentAttempt, namespace: this.localNamespace(roomId, taskId), requestHash, action, messages,
      ...(resources ? { conflictKey: resources.conflictKey, resourceLeases: resources.resourceLeases } : {}),
      ...(workspaceId ? { workspaceId } : {}), fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
    if (!response.ok) throw new Error(response.code);
    return this.view(roomId, taskId)!.context.intents.find(i => i.id === intentId)!.localOperations!.find(o => o.id === operationId)!;
  }
  claimLocal(roomId: string, taskId: string, intentId: string, operationId: string, parentAttempt: number): { response: CommandResult; operation?: LocalOperation } {
    const work = this.view(roomId, taskId)?.context.intents.find(i => i.id === intentId);
    if (!work) return { response: { ok: false, code: 'UNKNOWN_WORK', detail: intentId } };
    const response = this.send(roomId, taskId, { type: 'LOCAL_CLAIM', id: `local-claim:${randomUUID()}`, at: this.clock(), intentId, operationId, parentAttempt,
      sessionId: randomUUID(), leaseAvailable: true, fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
    const operation = this.view(roomId, taskId)!.context.intents.find(i => i.id === intentId)!.localOperations?.find(o => o.id === operationId);
    return { response, ...(operation ? { operation } : {}) };
  }
  view(roomId: string, taskId?: string): TaskView | null {
    const room = this.store.read(roomId);
    const id = taskId ?? room.activeTaskId;
    if (!id || !room.tasks[id]) return null;
    const snapshot = decode(room.tasks[id]);
    return structuredClone({ phase: taskPhase(snapshot), context: snapshot.context });
  }
  /** One consistent room read; storage decoding and snapshot recovery stay inside the trusted engine. */
  viewTasks(roomId: string): TaskView[] {
    const room = this.store.read(roomId);
    return structuredClone(Object.values(room.tasks).map(value => {
      const snapshot = decode(value);
      return { phase: taskPhase(snapshot), context: snapshot.context };
    }));
  }
  timeline(roomId: string) {
    return Object.values(this.store.read(roomId).tasks).flatMap(value => decode(value).context.messages).sort((a, b) => a.at - b.at);
  }
  pending(roomId: string, taskId: string): Intent[] {
    if (this.deletionRejection(roomId)) return [];
    const view = this.view(roomId, taskId);
    if (!view) return [];
    const kind: Partial<Record<TaskView['phase'], Intent['kind'][]>> = {
      interpreting: ['interpretation'], running: ['owner', 'tool'], waitingAssistance: ['assistance'], coordinating: ['facilitator'], checking: ['check'],
    };
    const compatible = !taskProtocolChanged(view.context.config, this.config);
    return view.context.intents.filter(i => i.status === 'pending' && !localAwaitingApproval(i) && (i.kind === 'cancel'
      || (compatible && !view.context.stopped && view.context.outcome === null && (i.discussionId || kind[view.phase]?.includes(i.kind)) && workLaneAvailable(view.context, i))));
  }
  claim(roomId: string, taskId: string, intentId: string): Intent | null {
    const view = this.view(roomId, taskId);
    const item = view?.context.intents.find(i => i.id === intentId);
    if (!item || item.status !== 'pending') return null;
    const result = this.send(roomId, taskId, { id: `claim:${intentId}:${item.attempt + 1}`, type: 'CLAIM', intentId, at: this.clock() });
    if (!result.ok || result.duplicate) return null;
    return this.view(roomId, taskId)!.context.intents.find(i => i.id === intentId)!;
  }
  /** The claim and one-use execution permit must both commit before any external adapter call. */
  beginExecution(roomId: string, taskId: string, work: Intent): boolean {
    if (this.deletionRejection(roomId)) return false;
    return this.transact(roomId, tx => {
      if (!tx.room.tasks[taskId]) return false;
      const current = decode(tx.room.tasks[taskId]);
      const actual = current.context.intents.find(intent => intent.id === work.id && intent.attempt === work.attempt);
      if (!actual || actual.kind !== 'cancel' && recoveryIssue(current.context, this.config)) return false;
      const result = startTaskExecution(current, work.id, work.attempt, this.clock(), (snapshot, event) => this.step(snapshot, event));
      if (!result.allowed) return false;
      storeTask(tx, result.snapshot);
      return true;
    });
  }
  executionPhase(roomId: string, taskId: string, work: Pick<Intent, 'id' | 'attempt'>) {
    const value = this.store.read(roomId).tasks[taskId];
    return value ? executionState(decode(value), work.id, work.attempt) : undefined;
  }
  flushResults(roomId: string, taskId: string): boolean {
    if (this.deletionRejection(roomId)) return false;
    if (!this.view(roomId, taskId)?.context.results.some(r => !r.consumed)) return false;
    return this.transact(roomId, tx => {
      if (!tx.room.tasks[taskId]) return false;
      const current = decode(tx.room.tasks[taskId]);
      const c = current.context;
      if (taskProtocolChanged(c.config, this.config)) return false;
      const result = c.results.find(r => !r.consumed);
      if (!result) return false;
      if (!c.stopped && c.outcome === null
        && c.intents.some(i => !i.discussionId && i.kind !== 'cancel' && i.status === 'inflight' && i.payload.requestId !== result.requestId)) return false;
      const checkpoint = this.pendingObservations?.length ?? 0;
      const next = this.step(current, { type: 'HELP_RESULT', id: `consume:${result.resultId}`, at: this.clock(),
        requestId: result.requestId, resultId: result.resultId, status: result.status, answer: result.answer,
        ...(result.summary === undefined ? {} : { summary: result.summary }), ...(result.artifactIds ? { artifactIds: result.artifactIds } : {}),
        fence: { epoch: result.epoch, goalVersion: result.goalVersion } });
      // A temporary rejection must not commit a receipt that prevents a later safe handoff.
      // The consumed result and successor intent are the durable deduplication boundary.
      if (!next.context.results.find(r => r.resultId === result.resultId)?.consumed) {
        this.pendingObservations?.splice(checkpoint);
        return false;
      }
      storeTask(tx, next);
      return true;
    });
  }
  recover(roomId: string): void {
    if (this.deletionRejection(roomId)) return;
    const room = this.store.read(roomId);
    for (const [id, value] of Object.entries(room.tasks)) {
      const snapshot = decode(value);
      if (taskPhase(snapshot) === 'ended' && !snapshot.context.resilience?.cleanup.some(item => item.state === 'pending')
        && !snapshot.context.intents.some(work => canRetireDiscussionWork(snapshot.context, work) || localPhysicalPending(work)
          || work.kind !== 'cancel' && work.replay !== 'unsafe' && ['pending', 'inflight'].includes(work.status))) continue;
      this.send(roomId, id, { type: 'RECOVER', id: `recover:${this.instanceId}:${id}`, at: this.clock(), config: this.config });
      while (this.flushResults(roomId, id)) { /* Each durable result is consumed at most once. */ }
    }
    this.tick(roomId);
  }
  tick(roomId: string): void {
    if (this.deletionRejection(roomId)) return;
    for (const taskId of Object.keys(this.store.read(roomId).tasks)) {
      const view = this.view(roomId, taskId);
      if (view) this.tickTask(roomId, view);
    }
  }
  private tickTask(roomId: string, view: TaskView): void {
    if (view.phase === 'ended' && !view.context.resilience?.cleanup.some(item => item.state === 'pending')
      && !view.context.intents.some(work => localPhysicalPending(work) || work.replay === 'unsafe' && ['inflight', 'uncertain'].includes(work.status))) return;
    if (taskProtocolChanged(view.context.config, this.config)) {
      if (!taskHumanGate(view.context)) this.send(roomId, view.context.taskId, { type: 'RECOVER', id: `incompatible:${this.instanceId}:${view.context.taskId}`, at: this.clock(), config: this.config });
      const recovered = this.view(roomId, view.context.taskId)!.context;
      if (windowExpiryUnobserved(recovered) && processingWindow(recovered).hardDeadline <= this.clock()
        || recovered.resilience?.cleanup.some(item => item.state === 'pending' && item.nextCheckAt <= this.clock()))
        this.send(roomId, view.context.taskId, { type: 'SUPERVISE', id: `incompatible-cleanup:${view.context.taskId}:${this.clock()}`, at: this.clock(), trigger: 'recover' });
      return;
    }
    const c = view.context; const at = this.clock();
    if (c.hostRetryRequests?.some(r => r.deadline <= at && (r.status === 'pending' || r.status === 'active' && !r.operationId)))
      this.send(roomId, c.taskId, { type: 'HOST_RETRY_EXPIRE', id: `host-retry-sweep:${at}`, at });
    else if (!c.stopped && hostRetryBatchRetirable(c))
      this.send(roomId, c.taskId, { type: 'HOST_RETRY_RECONCILE', id: `host-retry-reconcile:${c.hostRetryBatch!.id}:${at}`, at });
    for (const work of c.intents) for (const op of work.localOperations ?? []) {
      if (op.deadline !== undefined && op.deadline <= at && ['queued', 'awaitingApproval'].includes(op.status))
        this.send(roomId, c.taskId, { type: 'LOCAL_RETRY_EXPIRED', id: `host-retry-expiry:${op.id}`, at, intentId: work.id, operationId: op.id });
      else if (op.approval && ['awaitingApproval', 'queued'].includes(op.status) && op.approval.expiresAt <= at)
        this.send(roomId, c.taskId, { type: 'LOCAL_APPROVAL_EXPIRED', id: `expire:${op.approval.id}`, at, intentId: work.id, operationId: op.id });
    }
    for (const op of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && i.kind !== 'cancel' && i.deadline !== null && i.deadline <= at)) {
      if (localPhysicalPending(op)) continue; // The local runner enforces the parent deadline and awaits session settlement.
      if (op.kind === 'assistance' && !op.discussionId) {
        this.send(roomId, c.taskId, { id: `timeout:${op.id}`, type: 'HELP_RESULT', requestId: String(op.payload.requestId), resultId: `timeout:${op.id}`, status: 'timeout', answer: '协助已超时', at, fence: { epoch: op.epoch, goalVersion: op.goalVersion } });
      } else {
        this.send(roomId, c.taskId, { id: `timeout:${op.id}`, type: 'WORK_FAILED', intentId: op.id, reason: 'Tool or model deadline exceeded', transient: false, resultUncertain: op.replay === 'unsafe', at, fence: { epoch: op.epoch, goalVersion: op.goalVersion } });
      }
    }
    const latest = this.view(roomId, c.taskId)!;
    if (latest.phase === 'running' && (!latest.context.discussion || ['delivered', 'cancelled'].includes(latest.context.discussion.status))
      && latest.context.nextCheckAt <= at) this.send(roomId, c.taskId, { type: 'TICK', id: `progress:${c.taskId}:${latest.context.epoch}:${latest.context.nextCheckAt}`, at });
    const supervised = this.view(roomId, c.taskId)!.context;
    const due = supervised.resilience?.nextSupervisionAt;
    if (due !== null && (due === undefined || due <= at) || windowExpiryUnobserved(supervised) && processingWindow(supervised).hardDeadline <= at)
      this.send(roomId, c.taskId, { type: 'SUPERVISE', id: `supervise:${c.taskId}:${supervised.epoch}:${at}`, at, trigger: 'timer' });
  }
  nextWake(roomId: string): number | null {
    if (this.deletionRejection(roomId)) return null;
    const wakes = Object.keys(this.store.read(roomId).tasks).map(id => this.view(roomId, id)).filter((v): v is TaskView => v !== null)
      .map(view => this.nextTaskWake(roomId, view)).filter((value): value is number => value !== null);
    return wakes.length ? Math.min(...wakes) : null;
  }
  private nextTaskWake(roomId: string, view: TaskView): number | null {
    if (view.phase === 'ended' && !view.context.resilience?.cleanup.some(item => item.state === 'pending')
      && !view.context.intents.some(work => localPhysicalPending(work) || work.replay === 'unsafe' && ['inflight', 'uncertain'].includes(work.status))) return null;
    if (taskProtocolChanged(view.context.config, this.config) && !taskHumanGate(view.context)) return this.clock();
    const r = view.context.resilience;
    const supervision = [taskHumanGate(view.context) && !r?.cleanup.some(item => item.state === 'pending') ? null : r?.nextSupervisionAt,
      ...(r?.cleanup.filter(item => item.state === 'pending').map(item => item.nextCheckAt) ?? []),
      ...(windowExpiryUnobserved(view.context) ? [processingWindow(view.context).hardDeadline] : [])]
      .filter((n): n is number => typeof n === 'number');
    const earliest = (values: number[]) => [...values, ...supervision].length ? Math.min(...values, ...supervision) : null;
    if (view.phase === 'ended') return earliest([]);
    if (!view.context.stopped && hostRetryBatchRetirable(view.context)) return this.clock();
    const discussing = view.context.discussion && !['delivered', 'cancelled'].includes(view.context.discussion.status);
    const retryDeadlines = (view.context.hostRetryRequests ?? []).filter(r => r.status === 'pending' || r.status === 'active' && !r.operationId).map(r => r.deadline);
    if (view.phase === 'waitingHuman' && !discussing) return earliest(retryDeadlines);
    if (view.context.results.some(r => !r.consumed)) return this.clock();
    const work = view.context.intents.filter(i => ['pending', 'inflight'].includes(i.status) && i.deadline !== null).map(i => i.deadline!);
    work.push(...retryDeadlines);
    for (const intent of view.context.intents) for (const op of intent.localOperations ?? []) {
      if (op.status === 'awaitingApproval' && op.approval) work.push(op.approval.expiresAt);
      if (op.deadline !== undefined && ['queued', 'awaitingApproval'].includes(op.status)) work.push(op.deadline);
    }
    if (view.phase === 'running' && !discussing && !view.context.intents.some(localAwaitingApproval)) work.push(view.context.nextCheckAt);
    return earliest(work);
  }
}
