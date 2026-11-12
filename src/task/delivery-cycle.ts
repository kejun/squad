import { maximumCount } from '../budget-defaults.js';
import type { DeliveryCycle, DeliveryStage, Intent, TaskContext, TeamConfig } from '../types.js';
import { deliveryJudgments } from '../delivery-acceptance.js';

export const newDeliveryCycle = (config?: Pick<TeamConfig, 'limits'>): DeliveryCycle => ({ stage: { kind: 'drafting' }, requests: 0, revisionUsed: false,
  ...(config?.limits.replans === maximumCount ? { revisions: { used: 0, limit: maximumCount } } : {}) });

export function deliveryRevisionBudget(cycle: DeliveryCycle): { used: number; limit: number } {
  return cycle.revisions ?? { used: Number(cycle.revisionUsed), limit: cycle.revisionUsed ? 1 : 2 };
}

export function deliveryCandidate(c: TaskContext): void {
  if (c.deliveryCycle) c.deliveryCycle.stage = c.candidate?.revision
    ? { kind: 'candidate', candidateRevision: c.candidate.revision } : { kind: 'drafting' };
}

export function bindDeliveryCheck(c: TaskContext, work: Intent): void {
  if (!c.candidate?.revision || !c.deliveryCycle) throw new Error('Missing delivery candidate');
  c.deliveryCycle.stage = { kind: 'checking', candidateRevision: c.candidate.revision, checkWorkId: work.id };
}

export function beginDeliveryRevision(c: TaskContext, work: Intent): void {
  const cycle = c.deliveryCycle!;
  const budget = deliveryRevisionBudget(cycle);
  const gaps = deliveryJudgments(c, c.candidate?.revision).filter(item => item.status === 'failed').length;
  cycle.revisions = { used: budget.used + 1,
    limit: cycle.revisions?.limit ?? (cycle.revisionUsed ? 1 : Math.min(3, Math.max(2, gaps))) };
  cycle.revisionUsed = true;
  cycle.stage = { kind: 'revising', baseRevision: c.candidate?.revision ?? null, ownerWorkId: work.id };
}

export function resetDeliveryMaterials(c: TaskContext): void {
  if (!c.deliveryCycle) return;
  delete c.deliveryCycle.evidence;
  c.deliveryCycle.stage = { kind: 'drafting' };
}

export function settleDeliveryCycle(c: TaskContext, outcome: TaskContext['outcome'], reason: string): void {
  if (!c.deliveryCycle) return;
  c.deliveryCycle.stage = outcome === 'complete' && c.candidate?.revision
    ? { kind: 'published', candidateRevision: c.candidate.revision }
    : { kind: 'incomplete', candidateRevision: c.candidate?.revision ?? null, reason };
}

/** Read migration only: retain the original work, budgets and frozen materials. */
export function restoreDeliveryStage(c: TaskContext): void {
  if (!c.deliveryCycle || c.deliveryCycle.stage) return;
  let stage: DeliveryStage = { kind: 'drafting' };
  const revision = c.candidate?.revision;
  const current = c.intents.filter(work => work.epoch === c.epoch && work.goalVersion === c.goalVersion
    && ['pending', 'inflight', 'uncertain'].includes(work.status));
  const check = current.find(work => work.kind === 'check' && work.payload.deliveryProtocol === 'bounded');
  const owner = current.find(work => work.payload.deliveryRevision === true);
  if (c.outcome === 'complete' && revision) stage = { kind: 'published', candidateRevision: revision };
  else if (c.stopped || c.outcome !== null) stage = { kind: 'incomplete', candidateRevision: revision ?? null, reason: c.reason };
  else if (check && revision) stage = { kind: 'checking', candidateRevision: revision, checkWorkId: check.id };
  else if (owner) stage = { kind: 'revising', baseRevision: revision ?? null, ownerWorkId: owner.id };
  else if (revision) stage = { kind: 'candidate', candidateRevision: revision };
  c.deliveryCycle.stage = stage;
}
