/** Task-owned approval scope; pure state only, never executes commands. */
import type { HostApproval, LocalOperation } from './local-operation.js';
import { localEnabled, localRecoveryBlocked } from './local-operation.js';
import type { Intent, TaskContext } from './types.js';
export interface HostSessionGrant {
  id: string; epoch: number; goalVersion: number; namespace: string; workspaceId: string;
  host: string; account: string; environmentHash: string;
}
export function hostSessionActive(c: TaskContext): boolean {
  const g = c.hostSession;
  return !!g && !c.stopped && c.outcome === null && !localRecoveryBlocked(c) && g.epoch === c.epoch && g.goalVersion === c.goalVersion;
}
export function hostSessionMatches(c: TaskContext, work: Intent, op: LocalOperation, approval: HostApproval): boolean {
  const g = c.hostSession, p = approval.plan;
  return hostSessionActive(c) && !!g && localEnabled(c.config, work.target) && work.epoch === c.epoch && work.goalVersion === c.goalVersion
    && g.namespace === op.namespace && g.workspaceId === op.workspaceId && g.host === p.host && g.account === p.account && g.environmentHash === p.environmentHash;
}
export function revokeHostSession(c: TaskContext, id: string) {
  c.hostSession = undefined;
  for (const work of c.intents) for (const op of work.localOperations ?? []) {
    if (op.approval?.sessionGrantId && op.status === 'queued') {
      op.status = 'awaitingApproval'; op.approval.status = 'pending'; op.approval.id = `${id}:${op.id}`;
      delete op.approval.sessionGrantId;
    }
  }
}
