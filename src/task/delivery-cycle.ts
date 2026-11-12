import type { DeliveryCycle, DeliveryStage, Intent, TaskContext } from '../types.js';

export const newDeliveryCycle = (): DeliveryCycle => ({ stage: { kind: 'drafting' }, requests: 0 });

export function deliveryCandidate(c: TaskContext): void {
  if (c.deliveryCycle) c.deliveryCycle.stage = c.candidate?.revision
    ? { kind: 'candidate', candidateRevision: c.candidate.revision } : { kind: 'drafting' };
}

export function bindDeliveryCheck(c: TaskContext, work: Intent): void {
  if (!c.candidate?.revision || !c.deliveryCycle) throw new Error('Missing delivery candidate');
  c.deliveryCycle.stage = { kind: 'checking', candidateRevision: c.candidate.revision, checkWorkId: work.id };
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
  const savedStage = c.deliveryCycle?.stage as { kind: string } | undefined;
  if (!c.deliveryCycle || savedStage && savedStage.kind !== 'revising') return;
  let stage: DeliveryStage = { kind: 'drafting' };
  const revision = c.candidate?.revision;
  const current = c.intents.filter(work => work.epoch === c.epoch && work.goalVersion === c.goalVersion
    && ['pending', 'inflight', 'uncertain'].includes(work.status));
  const check = current.find(work => work.kind === 'check' && work.payload.deliveryProtocol === 'bounded');
  if (c.outcome === 'complete' && revision) stage = { kind: 'published', candidateRevision: revision };
  else if (c.stopped || c.outcome !== null) stage = { kind: 'incomplete', candidateRevision: revision ?? null, reason: c.reason };
  else if (check && revision) stage = { kind: 'checking', candidateRevision: revision, checkWorkId: check.id };
  else if (revision) stage = { kind: 'candidate', candidateRevision: revision };
  c.deliveryCycle.stage = stage;
}
