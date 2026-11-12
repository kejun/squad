import { assign, initialTransition, setup, transition, type SnapshotFrom } from 'xstate';
import type { Outcome, Phase, Reply } from './types.js';

export type DeletionPhase = 'idle' | 'preparing' | 'waiting' | 'deleting' | 'paused' | 'deleted';
export interface DeletionTaskIdentity { taskId: string; namespace: string }
export interface DeletionTaskFacts extends DeletionTaskIdentity {
  phase: Phase; outcome: Outcome | null;
  workIds: string[]; operationIds: string[];
}
export interface RuntimeOperationOwner {
  roomId: string; taskId: string; namespace: string; workId: string;
  operationId: string; parentAttempt: number; attempt: number; sessionId: string;
}
export interface RuntimeAssetOwner extends DeletionTaskIdentity {
  roomId: string;
  workId?: string; operationId?: string; parentAttempt?: number; attempt?: number; sessionId?: string;
}
export type RuntimeAssetKind = 'workspace' | 'copy' | 'copyMarker' | 'journal' | 'journalPending' | 'log' | 'ownership';
export interface RuntimeCleanupAsset {
  id: string; kind: RuntimeAssetKind; path: string; owner: RuntimeAssetOwner;
  /** Hash of the server-observed file identity; null for missing paths or an unobserved force-delete plan. */
  identity: string | null;
  status: 'pending' | 'removed';
}
export interface DeletionBlocker {
  id: string; kind: 'execution' | 'effects' | 'ownership' | 'dependency' | 'projection' | 'verification';
  reason: string; human: boolean;
  taskId?: string; operationId?: string;
}
export interface RuntimeCleanupInventory {
  tasks: DeletionTaskFacts[]; sessions: RuntimeOperationOwner[]; assets: RuntimeCleanupAsset[];
  complete: boolean; executionsSettled: boolean; blockers: DeletionBlocker[];
}
export type DeletionIntentKind = 'prepare' | 'removeAsset' | 'eraseData' | 'verify';
export interface DeletionIntent {
  id: string; kind: DeletionIntentKind; status: 'pending' | 'claimed' | 'done' | 'failed';
  attempt: number; createdAt: number; claimedAt?: number; assetId?: string;
}
export interface DeletionVerification {
  inventoryComplete: boolean; filesGone: boolean; databaseGone: boolean;
  executionsSettled: boolean; projectionsCleared: boolean; dependenciesPreserved: boolean;
}
export interface RoomDeletionContext {
  roomId: string; deletionId: string | null; revision: number;
  archiveVersion: number | null; requestDigest: string | null; requestedAt: number | null; completedAt: number | null;
  allTasks: DeletionTaskIdentity[]; tasks: DeletionTaskFacts[]; sessions: RuntimeOperationOwner[];
  assets: RuntimeCleanupAsset[]; blockers: DeletionBlocker[]; intents: DeletionIntent[];
  force?: boolean;
  dataErased: boolean; nextSequence: number; nextWake: number | null; reason: string; reply: Reply;
}
interface DeletionEnvelope { id: string; at: number }
interface ClaimedDeletionEvent extends DeletionEnvelope { deletionId: string; intentId: string; attempt: number }
export type RoomDeletionEvent =
  | (DeletionEnvelope & { type: 'REQUEST'; roomId: string; deletionId: string; requestDigest: string;
      confirmed: boolean; authorized: boolean; archived: boolean; archiveVersion: number; expectedArchiveVersion: number;
      allTasks: DeletionTaskIdentity[]; force?: boolean; inventory?: RuntimeCleanupInventory })
  | (DeletionEnvelope & { type: 'CLAIM'; deletionId: string; intentId: string })
  | (ClaimedDeletionEvent & { type: 'PREPARED'; inventory: RuntimeCleanupInventory; nextWake?: number })
  | (ClaimedDeletionEvent & { type: 'ASSET_REMOVED'; assetId: string; identityVerified: boolean; forceRemoved?: boolean; result: 'deleted' | 'absent' })
  | (ClaimedDeletionEvent & { type: 'DATA_ERASED' })
  | (ClaimedDeletionEvent & { type: 'VERIFIED'; checks: DeletionVerification })
  | (ClaimedDeletionEvent & { type: 'FAILED'; reason: string; retryAt?: number })
  | (DeletionEnvelope & { type: 'RETRY' | 'RECOVER' | 'TICK'; deletionId: string });
export interface SavedRoomDeletion { version: 1; value: DeletionPhase; context: RoomDeletionContext }
export interface RoomDeletionStatus {
  roomId: string; deletionId: string | null; revision: number; phase: DeletionPhase;
  remaining: number; reason: string; nextWake: number | null; blockers: DeletionBlocker[];
}

function initialContext(roomId: string): RoomDeletionContext {
  return { roomId, deletionId: null, revision: 0, archiveVersion: null, requestDigest: null,
    requestedAt: null, completedAt: null, allTasks: [], tasks: [], sessions: [], assets: [], blockers: [], intents: [],
    dataErased: false, nextSequence: 1, nextWake: null, reason: '', reply: { ok: true, code: 'OK', detail: 'idle' } };
}

const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2048 && !value.includes('\0');
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const phases = new Set<Phase>(['interpreting', 'running', 'waitingAssistance', 'coordinating', 'waitingHuman', 'checking', 'stopping', 'ended']);
const outcomes = new Set<Outcome>(['complete', 'partial', 'failed', 'stopped']);
const unique = (values: string[]) => new Set(values).size === values.length;
function currentIntent(c: RoomDeletionContext, event: RoomDeletionEvent, kind?: DeletionIntentKind) {
  if (!('intentId' in event) || !('attempt' in event) || event.deletionId !== c.deletionId) return undefined;
  return c.intents.find(intent => intent.id === event.intentId && intent.status === 'claimed'
    && intent.attempt === event.attempt && (!kind || intent.kind === kind));
}
function taskOwner(c: RoomDeletionContext, owner: RuntimeAssetOwner): boolean {
  return owner?.roomId === c.roomId && c.allTasks.some(task => task.taskId === owner.taskId && task.namespace === owner.namespace);
}
export function validRuntimeOwner(owner: RuntimeOperationOwner): boolean {
  return !!owner && [owner.roomId, owner.taskId, owner.workId, owner.operationId, owner.sessionId].every(text)
    && hash(owner.namespace) && time(owner.parentAttempt) && owner.parentAttempt > 0 && time(owner.attempt) && owner.attempt > 0;
}
export function validRuntimeAsset(asset: RuntimeCleanupAsset): boolean {
  if (!asset || !text(asset.id) || !text(asset.path) || !asset.owner || !text(asset.owner.roomId)
    || !text(asset.owner.taskId) || !hash(asset.owner.namespace) || asset.identity !== null && !hash(asset.identity)
    || !['pending', 'removed'].includes(asset.status)) return false;
  const paths: Record<RuntimeAssetKind, RegExp> = {
    workspace: /^workspaces\/[a-f0-9]{64}$/,
    copy: /^copies\/[a-f0-9]{64}$/,
    copyMarker: /^copies\/[a-f0-9]{64}\.json$/,
    journal: /^sessions\/[a-f0-9]{64}\.json$/,
    journalPending: /^sessions\/[a-f0-9]{64}\.json\.pending$/,
    log: /^logs\/[a-f0-9]{64}\.log$/,
    ownership: /^ownership\/[a-f0-9]{64}\.json(?:\.pending)?$/,
  };
  if (!paths[asset.kind]?.test(asset.path)) return false;
  if (['copy', 'copyMarker'].includes(asset.kind) && !text(asset.owner.workId)) return false;
  return !['journal', 'journalPending', 'log', 'ownership'].includes(asset.kind) || validRuntimeOwner(asset.owner as RuntimeOperationOwner);
}
function validInventory(c: RoomDeletionContext, inventory: RuntimeCleanupInventory): boolean {
  if (!inventory || typeof inventory.complete !== 'boolean' || typeof inventory.executionsSettled !== 'boolean'
    || !Array.isArray(inventory.tasks) || !Array.isArray(inventory.sessions) || !Array.isArray(inventory.assets) || !Array.isArray(inventory.blockers)) return false;
  if (inventory.tasks.length !== c.allTasks.length || !unique(inventory.tasks.map(task => task.taskId))
    || !inventory.tasks.every(task => c.allTasks.some(saved => saved.taskId === task.taskId && saved.namespace === task.namespace)
      && phases.has(task.phase) && (task.outcome === null || outcomes.has(task.outcome))
      && Array.isArray(task.workIds) && task.workIds.every(text) && unique(task.workIds)
      && Array.isArray(task.operationIds) && task.operationIds.every(text) && unique(task.operationIds))) return false;
  if (!unique(inventory.sessions.map(owner => owner.sessionId))
    || !inventory.sessions.every(owner => validRuntimeOwner(owner) && taskOwner(c, owner)
      && inventory.tasks.some(task => task.taskId === owner.taskId && task.workIds.includes(owner.workId) && task.operationIds.includes(owner.operationId)))) return false;
  if (!unique(inventory.assets.map(asset => asset.id)) || !unique(inventory.assets.map(asset => asset.path))
    || !inventory.assets.every(asset => validRuntimeAsset(asset) && taskOwner(c, asset.owner)
      && (!asset.owner.workId || inventory.tasks.some(task => task.taskId === asset.owner.taskId && task.workIds.includes(asset.owner.workId!)))
      && (!asset.owner.sessionId || inventory.sessions.some(owner => owner.sessionId === asset.owner.sessionId
        && owner.workId === asset.owner.workId && owner.operationId === asset.owner.operationId && owner.attempt === asset.owner.attempt)))) return false;
  if (!c.assets.filter(asset => asset.status !== 'removed').every(old => inventory.assets.some(asset => asset.id === old.id && asset.path === old.path))) return false;
  return unique(inventory.blockers.map(blocker => blocker.id)) && inventory.blockers.every(blocker => text(blocker.id) && text(blocker.reason)
    && ['execution', 'effects', 'ownership', 'dependency', 'projection', 'verification'].includes(blocker.kind) && typeof blocker.human === 'boolean'
    && (blocker.taskId === undefined || c.allTasks.some(task => task.taskId === blocker.taskId)));
}
export function deletionEventProblem(c: RoomDeletionContext, event: RoomDeletionEvent): string | null {
  if (!text(event.id) || !time(event.at)) return 'INVALID_DELETION_EVENT';
  if (event.type === 'REQUEST') {
    if (event.roomId !== c.roomId) return 'DELETION_TARGET_MISMATCH';
    if ((!event.force && !event.confirmed) || !event.authorized) return 'DELETION_CONFIRMATION_REQUIRED';
    if (!event.archived) return 'ROOM_NOT_ARCHIVED';
    if (!time(event.archiveVersion) || !event.force && event.archiveVersion !== event.expectedArchiveVersion) return 'ARCHIVE_VERSION_CONFLICT';
    if (!text(event.deletionId) || !hash(event.requestDigest) || !Array.isArray(event.allTasks)
      || !event.allTasks.every(task => text(task.taskId) && hash(task.namespace)) || !unique(event.allTasks.map(task => task.taskId))) return 'INVALID_DELETION_REQUEST';
    if (event.force && (!event.inventory || !validInventory({ ...c, allTasks: event.allTasks, assets: [] }, event.inventory))) return 'INVALID_DELETION_INVENTORY';
    return null;
  }
  if (event.deletionId !== c.deletionId || !c.deletionId) return 'STALE_DELETION';
  if (event.type === 'CLAIM') {
    const first = c.intents.find(intent => intent.status === 'pending');
    return first?.id === event.intentId && !c.intents.some(intent => intent.status === 'claimed') ? null : 'DELETION_INTENT_NOT_PENDING';
  }
  if (['RETRY', 'RECOVER', 'TICK'].includes(event.type)) return null;
  const kind = event.type === 'PREPARED' ? 'prepare' : event.type === 'ASSET_REMOVED' ? 'removeAsset'
    : event.type === 'DATA_ERASED' ? 'eraseData' : event.type === 'VERIFIED' ? 'verify' : undefined;
  const intent = currentIntent(c, event, kind);
  if (!intent) return 'STALE_DELETION_RESULT';
  if (event.type === 'PREPARED') return validInventory(c, event.inventory) ? null : 'INVALID_DELETION_INVENTORY';
  if (event.type === 'ASSET_REMOVED') return event.assetId === intent.assetId && (event.identityVerified || c.force && event.forceRemoved === true)
    && ['deleted', 'absent'].includes(event.result) ? null : 'DELETION_ASSET_NOT_VERIFIED';
  if (event.type === 'FAILED') return text(event.reason) ? null : 'INVALID_DELETION_FAILURE';
  if (event.type === 'VERIFIED') return c.dataErased && c.assets.every(asset => asset.status === 'removed')
    && !!event.checks && ['inventoryComplete', 'filesGone', 'databaseGone', 'executionsSettled', 'projectionsCleared', 'dependenciesPreserved']
      .every(key => key === 'executionsSettled' && c.force || (event.checks as unknown as Record<string, unknown>)[key] === true) ? null : 'DELETION_VERIFICATION_INCOMPLETE';
  return null;
}
function queue(c: RoomDeletionContext, kind: DeletionIntentKind, at: number, assetId?: string) {
  c.intents.push({ id: `${c.deletionId}:cleanup:${c.nextSequence++}`, kind, status: 'pending', attempt: 0, createdAt: at,
    ...(assetId ? { assetId } : {}) });
  c.nextWake = at;
}
function advance(c: RoomDeletionContext, at: number) {
  if (c.intents.some(intent => ['pending', 'claimed'].includes(intent.status))) return;
  const asset = c.assets.find(item => item.status !== 'removed');
  if (asset) queue(c, 'removeAsset', at, asset.id);
  else queue(c, c.dataErased ? 'verify' : 'eraseData', at);
}
function finishIntent(c: RoomDeletionContext, event: RoomDeletionEvent) {
  const intent = currentIntent(c, event);
  if (intent) intent.status = 'done';
}
function prepareAgain(c: RoomDeletionContext, at: number) {
  for (const intent of c.intents) if (['pending', 'claimed'].includes(intent.status)) intent.status = 'done';
  c.reason = ''; c.nextWake = at; queue(c, 'prepare', at);
}
function reduceDeletion(context: RoomDeletionContext, event: RoomDeletionEvent): RoomDeletionContext {
  const c = structuredClone(context);
  c.reply = { ok: true, code: 'OK', detail: c.deletionId ?? 'accepted' }; c.revision++;
  switch (event.type) {
    case 'REQUEST':
      c.deletionId = event.deletionId; c.archiveVersion = event.archiveVersion; c.requestDigest = event.requestDigest;
      c.requestedAt = event.at; c.allTasks = structuredClone(event.allTasks);
      if (event.force) {
        c.force = true; c.tasks = structuredClone(event.inventory!.tasks); c.sessions = structuredClone(event.inventory!.sessions);
        c.assets = structuredClone(event.inventory!.assets); c.blockers = []; c.intents = []; c.reason = '';
      }
      queue(c, event.force ? 'eraseData' : 'prepare', event.at); break;
    case 'CLAIM': {
      const intent = c.intents.find(item => item.id === event.intentId)!;
      intent.status = 'claimed'; intent.attempt++; intent.claimedAt = event.at; c.nextWake = null; break;
    }
    case 'PREPARED': {
      finishIntent(c, event);
      c.tasks = structuredClone(event.inventory.tasks); c.sessions = structuredClone(event.inventory.sessions);
      c.assets = event.inventory.assets.map(asset => ({ ...structuredClone(asset),
        status: asset.identity === null && c.assets.some(old => old.id === asset.id && old.status === 'removed') ? 'removed' : 'pending' }));
      c.blockers = event.inventory.blockers.map(blocker => ({ ...structuredClone(blocker), human: c.force ? false : blocker.human }));
      if (!event.inventory.complete && !c.blockers.some(blocker => blocker.kind === 'ownership'))
        c.blockers.push({ id: 'inventory-incomplete', kind: 'ownership', reason: '运行文件清单暂不可用', human: !c.force });
      if (!c.force && !event.inventory.executionsSettled && !c.blockers.some(blocker => ['execution', 'effects'].includes(blocker.kind)))
        c.blockers.push({ id: 'executions-unsettled', kind: 'execution', reason: '实际执行或物理效果尚未结算', human: false });
      if (c.blockers.length) {
        c.reason = c.blockers.map(blocker => blocker.reason).join('；');
        c.nextWake = c.blockers.some(blocker => !blocker.human)
          ? Math.max(event.at + 1000, event.nextWake ?? event.at + 5000) : null;
      } else { c.reason = ''; advance(c, event.at); }
      break;
    }
    case 'ASSET_REMOVED':
      finishIntent(c, event); c.assets.find(asset => asset.id === event.assetId)!.status = 'removed'; advance(c, event.at); break;
    case 'DATA_ERASED':
      finishIntent(c, event); c.dataErased = true;
      if (c.force) queue(c, 'prepare', event.at); else advance(c, event.at); break;
    case 'VERIFIED': {
      const tombstone = initialContext(c.roomId);
      return { ...tombstone, deletionId: c.deletionId, revision: c.revision, archiveVersion: c.archiveVersion,
        force: c.force === true, requestDigest: c.requestDigest, requestedAt: c.requestedAt, completedAt: event.at, dataErased: true,
        reply: { ok: true, code: 'ROOM_DELETED', detail: c.deletionId! } };
    }
    case 'FAILED': {
      const intent = currentIntent(c, event)!; intent.status = 'failed'; c.reason = event.reason;
      c.nextWake = time(event.retryAt) && event.retryAt > event.at ? event.retryAt : event.at + 5000; break;
    }
    case 'RETRY': prepareAgain(c, event.at); break;
    case 'RECOVER':
      for (const intent of c.intents) if (intent.status === 'claimed') { intent.status = 'pending'; delete intent.claimedAt; }
      c.nextWake = c.intents.some(intent => intent.status === 'pending') ? event.at : c.nextWake; break;
    case 'TICK': prepareAgain(c, event.at); break;
  }
  return c;
}
const valid = ({ context, event }: { context: RoomDeletionContext; event: RoomDeletionEvent }) => !deletionEventProblem(context, event);
const prepared = ({ context, event }: { context: RoomDeletionContext; event: RoomDeletionEvent }) => event.type === 'PREPARED' && !!currentIntent(context, event, 'prepare');
const blocked = ({ context, event }: { context: RoomDeletionContext; event: RoomDeletionEvent }) => event.type === 'PREPARED'
  && !deletionEventProblem(context, event) && (!event.inventory.complete || !context.force && !event.inventory.executionsSettled || !!event.inventory.blockers.length);

export const roomDeletionMachine = setup({
  types: { context: {} as RoomDeletionContext, events: {} as RoomDeletionEvent, input: {} as { roomId: string } },
  guards: {
    valid, prepared, blocked,
    forceRequest: args => args.event.type === 'REQUEST' && args.event.force === true && !args.context.force && valid(args),
    forceErasure: args => args.context.force === true && valid(args),
    ready: args => prepared(args) && valid(args) && !blocked(args),
    due: ({ context, event }) => valid({ context, event }) && context.nextWake !== null && event.at >= context.nextWake,
    claimed: ({ context, event }) => valid({ context, event }) && !!currentIntent(context, event),
    currentAsset: ({ context, event }) => event.type === 'ASSET_REMOVED' && !!currentIntent(context, event, 'removeAsset'),
    currentVerification: ({ context, event }) => event.type === 'VERIFIED' && !!currentIntent(context, event, 'verify'),
  },
  actions: {
    apply: assign(({ context, event }) => reduceDeletion(context, event)),
    retry: assign(({ context, event }) => reduceDeletion(context, { ...event, type: 'RETRY', deletionId: context.deletionId! })),
    reject: assign(({ context, event }) => ({ ...context, reply: { ok: false,
      code: deletionEventProblem(context, event) ?? 'INVALID_DELETION_STATE', detail: deletionEventProblem(context, event) ?? 'INVALID_DELETION_STATE' } })),
    invalidResult: assign(({ context, event }) => {
      const c = structuredClone(context), intent = currentIntent(c, event);
      if (intent) intent.status = 'failed';
      c.reason = deletionEventProblem(c, event) ?? 'INVALID_DELETION_RESULT'; c.nextWake = event.at + 5000; c.revision++;
      c.reply = { ok: false, code: c.reason, detail: c.reason }; return c;
    }),
    existing: assign(({ context }) => ({ ...context, reply: { ok: true, code: context.completedAt === null ? 'DELETION_ALREADY_REQUESTED' : 'ROOM_DELETED', detail: context.deletionId! } })),
  },
}).createMachine({
  id: 'room-deletion', initial: 'idle', context: ({ input }) => initialContext(input.roomId),
  on: {
    REQUEST: [{ guard: 'forceRequest', target: '.deleting', actions: 'apply' }, { guard: 'valid', actions: 'existing' }, { actions: 'reject' }],
    CLAIM: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    FAILED: [{ guard: 'claimed', target: '.paused', actions: 'apply' }, { actions: 'reject' }],
    '*': { actions: 'reject' },
  },
  states: {
    idle: { on: { REQUEST: [{ guard: 'forceRequest', target: 'deleting', actions: 'apply' }, { guard: 'valid', target: 'preparing', actions: 'apply' }, { actions: 'reject' }] } },
    preparing: { on: {
      RETRY: [{ guard: 'valid', actions: 'existing' }, { actions: 'reject' }],
      PREPARED: [{ guard: 'blocked', target: 'waiting', actions: 'apply' }, { guard: 'ready', target: 'deleting', actions: 'apply' },
        { guard: 'prepared', target: 'paused', actions: 'invalidResult' }, { actions: 'reject' }],
      RECOVER: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    } },
    waiting: { on: {
      RETRY: [{ guard: 'valid', target: 'preparing', actions: 'apply' }, { actions: 'reject' }],
      TICK: [{ guard: 'due', target: 'preparing', actions: 'apply' }, { actions: 'reject' }],
      RECOVER: [{ guard: 'due', target: 'preparing', actions: 'retry' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    } },
    deleting: { on: {
      RETRY: [{ guard: 'valid', actions: 'existing' }, { actions: 'reject' }],
      ASSET_REMOVED: [{ guard: 'valid', actions: 'apply' }, { guard: 'currentAsset', target: 'paused', actions: 'invalidResult' }, { actions: 'reject' }],
      DATA_ERASED: [{ guard: 'forceErasure', target: 'preparing', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
      VERIFIED: [{ guard: 'valid', target: 'deleted', actions: 'apply' }, { guard: 'currentVerification', target: 'paused', actions: 'invalidResult' }, { actions: 'reject' }],
      RECOVER: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    } },
    paused: { on: {
      RETRY: [{ guard: 'valid', target: 'preparing', actions: 'apply' }, { actions: 'reject' }],
      RECOVER: [{ guard: 'due', target: 'preparing', actions: 'retry' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
      TICK: [{ guard: 'due', target: 'preparing', actions: 'apply' }, { actions: 'reject' }],
    } },
    deleted: { on: { REQUEST: [{ guard: 'valid', actions: 'existing' }, { actions: 'reject' }], '*': { actions: 'reject' } } },
  },
});
export type RoomDeletionSnapshot = SnapshotFrom<typeof roomDeletionMachine>;
export function initialRoomDeletion(input: { roomId: string }): RoomDeletionSnapshot { return initialTransition(roomDeletionMachine, input)[0]; }
export function persistRoomDeletion(snapshot: RoomDeletionSnapshot): SavedRoomDeletion {
  return { version: 1, value: snapshot.value as DeletionPhase, context: structuredClone(snapshot.context) };
}
export function restoreRoomDeletion(saved: SavedRoomDeletion): RoomDeletionSnapshot {
  if (saved.version !== 1 || !['idle', 'preparing', 'waiting', 'deleting', 'paused', 'deleted'].includes(saved.value)
    || !text(saved.context?.roomId) || !time(saved.context.revision)) throw new Error('Incompatible room deletion snapshot');
  return roomDeletionMachine.resolveState({ value: saved.value, context: structuredClone(saved.context) });
}
export function stepRoomDeletion(snapshot: RoomDeletionSnapshot, event: RoomDeletionEvent): RoomDeletionSnapshot {
  return transition(roomDeletionMachine, snapshot, event)[0];
}
export function deletionStatus(snapshot: RoomDeletionSnapshot): RoomDeletionStatus {
  const c = snapshot.context;
  return { roomId: c.roomId, deletionId: c.deletionId, revision: c.revision, phase: snapshot.value as DeletionPhase,
    remaining: snapshot.value === 'deleted' ? 0 : Math.max(snapshot.value === 'idle' ? 0 : 1,
      c.assets.filter(asset => asset.status !== 'removed').length + c.blockers.length
      + c.intents.filter(intent => intent.kind !== 'removeAsset' && ['pending', 'claimed'].includes(intent.status)).length),
    reason: c.reason, nextWake: c.nextWake, blockers: structuredClone(c.blockers) };
}
