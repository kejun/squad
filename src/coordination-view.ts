/** Read-only execution metadata. No document body, credential or mutation capability belongs here. */
import { heldLocalResourceLeases, localWorkspaceWaiting } from './local-operation.js';
import type { LocalOperation } from './local-operation.js';
import { operationLeaseOwner } from './store.js';
import type { ResourceLease, ResourceLeaseRow } from './local-resource-policy.js';
import type { TaskContext, Phase } from './types.js';
import { effectiveWork, processingWindow, supervisionDecision } from './task/resilience.js';

export interface CoordinationHolder {
  roomId: string; taskId: string; workId: string; operationId?: string;
}
export interface CoordinationLease extends ResourceLeaseRow {
  kind: 'typed' | 'workspace' | 'legacyWork';
  holder: CoordinationHolder | null;
}
export interface ExecutionLease extends ResourceLeaseRow { kind: CoordinationLease['kind'] }
export interface CoordinationRoomInput {
  id: string; title: string; archived: boolean; activeTaskId: string | null;
  deletion?: { status: string; reason: string };
  tasks: { phase: Phase; context: TaskContext }[];
}
export interface CoordinationOperation {
  id: string; type: LocalOperation['action']['type']; execution?: 'host' | 'sandbox';
  status: LocalOperation['status']; attempt: number; actuallyStarted: boolean;
  startedAt?: number; finishedAt?: number; waitingSince?: number;
  command?: { executable: string; args: string[]; cwd?: string; reason?: string };
  workspaceId?: string; resourceKeys: string[]; blockingOwners: string[];
  approval?: { id: string; status: string; expiresAt: number };
  result?: { ok: boolean; code: string };
}
export interface CoordinationTask {
  id: string; phase: Phase; epoch: number; goalVersion: number; owner: string;
  outcome: TaskContext['outcome']; stopped: boolean; reason: string;
  window: ReturnType<typeof processingWindow>;
  supervision: { decision: ReturnType<typeof supervisionDecision>; effectiveWorkIds: string[] };
  members: { id: string; name: string; workIds: string[] }[];
  gates: { id: string; kind: string; scope: string; status: string; required: boolean; question: string;
    workId?: string; operationId?: string; approvalId?: string }[];
  cleanup: { workId: string; operationId: string; state: string; nextCheckAt: number }[];
  discussion?: { id: string; status: string; targets: string[]; concurrency?: number;
    partitions: { partitionId: string; status: string; attempt: number; deadline: number;
      workId?: string; agentId?: string; resourceWaiting: boolean }[] };
  hostRetries: { id: string; status: string; sourceWorkId: string; sourceOperationId: string;
    workId?: string; operationId?: string; deadline: number }[];
  works: { id: string; agentId: string; kind: string; status: string; attempt: number;
    epoch: number; goalVersion: number; deadline: number | null; requestCount: number;
    resourceWaiting: boolean; operations: CoordinationOperation[] }[];
}
export interface CoordinationView {
  observedAt: number; complete: true;
  rooms: { id: string; title: string; archived: boolean; activeTaskId: string | null;
    deletion?: { status: string; reason: string }; tasks: CoordinationTask[] }[];
  leases: CoordinationLease[];
  waits: (CoordinationHolder & { operationId: string; since: number; blockingOwners: string[];
    blocking: { owner: string; holder: CoordinationHolder | null }[] })[];
}

type ObserveBlockers = (workspaceId: string, owner: string, requests?: ResourceLease[]) => string[];

/** All inputs come from the same synchronous host observation; no state is updated. */
export function coordinationView(rooms: CoordinationRoomInput[], leases: ExecutionLease[], observedAt: number,
  blockers: ObserveBlockers): CoordinationView {
  const holders = new Map<string, CoordinationHolder>();
  for (const room of rooms) for (const { context: c } of room.tasks) for (const work of c.intents) {
    holders.set(operationLeaseOwner(room.id, c.taskId, work.id), { roomId: room.id, taskId: c.taskId, workId: work.id });
    for (const op of work.localOperations ?? []) holders.set(operationLeaseOwner(room.id, c.taskId, op.id),
      { roomId: room.id, taskId: c.taskId, workId: work.id, operationId: op.id });
  }
  const waits: CoordinationView['waits'] = [];
  const observeOperation = (roomId: string, c: TaskContext, workId: string, op: LocalOperation): CoordinationOperation => {
    const owner = operationLeaseOwner(roomId, c.taskId, op.id);
    const blockingOwners = op.status === 'queued' && op.workspaceId
      ? blockers(op.workspaceId, owner, op.resourceLeases?.length ? heldLocalResourceLeases(op) : undefined) : [];
    if (op.status === 'queued' && (op.workspaceWait || blockingOwners.length)) waits.push({ roomId, taskId: c.taskId,
      workId, operationId: op.id, since: op.workspaceWait?.since ?? op.createdAt, blockingOwners,
      blocking: blockingOwners.map(owner => ({ owner, holder: holders.get(owner) ?? null })) });
    return { id: op.id, type: op.action.type, status: op.status, attempt: op.attempt,
      actuallyStarted: op.startedAt !== undefined,
      ...(op.action.type === 'runCli' ? { execution: op.action.execution ?? 'sandbox' } : {}),
      ...(op.action.type === 'runCli' ? { command: { executable: op.approval?.plan.executable ?? op.action.executable,
        args: [...(op.approval?.plan.args ?? op.action.args)],
        ...(op.approval?.plan.cwd ?? op.action.cwd ? { cwd: op.approval?.plan.cwd ?? op.action.cwd! } : {}),
        ...(op.action.reason ? { reason: op.action.reason } : {}) } } : {}),
      ...(op.startedAt === undefined ? {} : { startedAt: op.startedAt }),
      ...(op.finishedAt === undefined ? {} : { finishedAt: op.finishedAt }),
      ...(op.workspaceWait ? { waitingSince: op.workspaceWait.since } : {}),
      ...(op.workspaceId ? { workspaceId: op.workspaceId } : {}),
      resourceKeys: op.resourceLeases?.map(lease => lease.key) ?? (op.workspaceId ? [op.workspaceId] : []), blockingOwners,
      ...(op.approval ? { approval: { id: op.approval.id, status: op.approval.status, expiresAt: op.approval.expiresAt } } : {}),
      ...(op.result ? { result: { ok: op.result.ok, code: op.result.code } } : {}) };
  };
  return { observedAt, complete: true, rooms: rooms.map(room => ({ id: room.id, title: room.title, archived: room.archived,
    activeTaskId: room.activeTaskId, ...(room.deletion ? { deletion: room.deletion } : {}),
    tasks: room.tasks.map(({ phase, context: c }) => ({ id: c.taskId, phase, epoch: c.epoch, goalVersion: c.goalVersion,
      owner: c.owner, outcome: c.outcome, stopped: c.stopped, reason: c.reason, window: structuredClone(processingWindow(c)),
      supervision: { decision: supervisionDecision(c, phase, observedAt), effectiveWorkIds: effectiveWork(c, phase, observedAt).map(w => w.id) },
      members: [...new Map([...c.config.bots.map(bot => [bot.id, bot.name] as const),
        ...c.intents.filter(work => !c.config.bots.some(bot => bot.id === work.target)).map(work => [work.target, work.target] as const)])]
        .map(([id, name]) => ({ id, name, workIds: c.intents.filter(work => work.target === id).map(work => work.id) })),
      gates: (c.resilience?.gates ?? []).map(g => ({ id: g.id, kind: g.kind, scope: g.scope, status: g.status, required: g.required, question: g.question,
        ...(g.workId ? { workId: g.workId } : {}), ...(g.operationId ? { operationId: g.operationId } : {}), ...(g.approvalId ? { approvalId: g.approvalId } : {}) })),
      cleanup: (c.resilience?.cleanup ?? []).map(item => ({ workId: item.workId, operationId: item.operationId, state: item.state, nextCheckAt: item.nextCheckAt })),
      ...(c.discussion ? { discussion: { id: c.discussion.id, status: c.discussion.status, targets: [...c.discussion.targets],
        ...(c.discussion.mapReduce?.concurrency === undefined ? {} : { concurrency: c.discussion.mapReduce.concurrency }),
        partitions: (c.discussion.mapReduce?.queue ?? []).map(part => ({ partitionId: part.partitionId, status: part.status,
          attempt: part.attempt, deadline: part.deadline, ...(part.workId ? { workId: part.workId } : {}),
          ...(part.target ? { agentId: part.target } : {}),
          resourceWaiting: !!part.workId && c.intents.some(w => w.id === part.workId && localWorkspaceWaiting(w)) })) } } : {}),
      hostRetries: (c.hostRetryRequests ?? []).map(request => ({ id: request.id, status: request.status,
        sourceWorkId: request.sourceWorkId, sourceOperationId: request.sourceOperationId, deadline: request.deadline,
        ...(request.workId ? { workId: request.workId } : {}), ...(request.operationId ? { operationId: request.operationId } : {}) })),
      works: c.intents.map(work => ({ id: work.id, agentId: work.target, kind: work.kind, status: work.status, attempt: work.attempt,
        epoch: work.epoch, goalVersion: work.goalVersion, deadline: work.deadline, requestCount: work.requestCount,
        resourceWaiting: localWorkspaceWaiting(work), operations: (work.localOperations ?? []).map(op => observeOperation(room.id, c, work.id, op)) })) })) })),
    leases: leases.map(lease => ({ ...lease, holder: holders.get(lease.owner) ?? null })), waits };
}
