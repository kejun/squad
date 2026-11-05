import type { Artifact, Candidate, Intent, TaskContext, TaskEvent } from '../types.js';
import { deliveryPreflight, judgmentsProblem } from '../delivery-acceptance.js';
import { hostRetryReservation, pendingHostRetry } from '../host-retry.js';
import { localPhysicalPending } from '../local-operation.js';
import { canRetryDeliveryCheck } from './budget.js';
import { deliveryEvidence } from './evidence.js';
import { completeProblem, deliveryHandoffPending, discussionIncomplete } from './facts.js';
import { deliveryVerificationEvidence, deliveryVerificationPlan, deliveryVerificationProblem } from './verification.js';

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
type CheckResult = Extract<TaskEvent, { type: 'CHECK_RESULT' }>;

export const newDeliveryCycle = (): NonNullable<TaskContext['deliveryCycle']> => ({ requests: 0, retryUsed: false, revisionUsed: false });

type BoundedCheck = Intent & { kind: 'check' };
export const isBoundedCheck = (work: Intent | undefined): work is BoundedCheck => work?.kind === 'check' && work.payload.deliveryProtocol === 'bounded';

export function deliveryCheckBudgetProblem(c: TaskContext): string | null {
  if (!c.deliveryCycle) return 'CHECK_PROTOCOL_CHANGED';
  if (c.deliveryCycle.requests >= 3 || c.usage.checks >= c.config.limits.checks) return 'CHECK_BUDGET_EXHAUSTED';
  return null;
}

export function deliveryOrdinaryAvailable(c: TaskContext, count: number): boolean {
  return c.usage.ordinary + hostRetryReservation(c) + count <= c.config.limits.ordinary;
}

export function deliverySubmissionProblem(c: TaskContext, e: Delivery): { code: string; mechanical: boolean } | null {
  const problem = deliveryVersionProblem(c, e) ?? deliveryPreflight(c, e).gaps[0]?.reason;
  if (problem) return { code: problem, mechanical: true };
  const budget = deliveryCheckBudgetProblem(c);
  if (budget) return { code: budget, mechanical: false };
  const verification = deliveryVerificationPlan(c);
  if (verification?.status === 'unavailable') return { code: 'WORKSPACE_VALIDATION_UNAVAILABLE', mechanical: false };
  if (verification?.status === 'required' && !deliveryOrdinaryAvailable(c, 2)) return { code: 'WORKSPACE_VALIDATION_BUDGET_EXHAUSTED', mechanical: false };
  return null;
}

export function canReviseDelivery(c: TaskContext): boolean {
  if (!c.deliveryCycle || c.deliveryCycle.revisionUsed || deliveryCheckBudgetProblem(c)) return false;
  const verification = deliveryVerificationPlan(c);
  return verification?.status !== 'unavailable' && deliveryOrdinaryAvailable(c, verification?.status === 'required' ? 3 : 1);
}

type CheckDisposition = { kind: 'handoff' | 'complete' | 'revise' | 'finish' | 'retry'; code?: string; detail?: string };

export function checkDisposition(c: TaskContext, e: CheckResult, work: Intent): CheckDisposition {
  if (deliveryHandoffPending(c) || pendingHostRetry(c) || c.intents.some(localPhysicalPending)) return { kind: 'handoff' };
  const incomplete = discussionIncomplete(c) ?? c.review?.incomplete;
  if (incomplete) return { kind: 'finish', code: 'INCOMPLETE_REVIEW', detail: incomplete };
  if (work.deadline !== null && e.at >= work.deadline) return { kind: 'finish', code: 'WORK_EXPIRED' };
  const evidence = c.deliveryCycle?.evidence && deliveryEvidence(c, work, c.deliveryCycle.evidence);
  if (!evidence) return { kind: 'finish', code: 'CHECK_EVIDENCE_CHANGED' };
  const test = deliveryVerificationEvidence(work);
  const sources = test ? [...evidence.sources, test] : evidence.sources;
  const protocol = e.passed !== undefined || e.gaps !== undefined ? 'CHECK_INVALID_CRITERIA_RESULTS'
    : judgmentsProblem(c.candidate!.acceptance!.criteria, e.criteriaResults, sources);
  if (protocol) return { kind: canRetryDeliveryCheck(c, work, e.at) ? 'retry' : 'finish', code: protocol };
  const mechanical = completeProblem(c);
  if (mechanical) return { kind: 'finish', code: mechanical };
  const findings = e.criteriaResults!.filter(item => item.status !== 'passed');
  if (!findings.length) {
    const verification = deliveryVerificationProblem(work, true);
    return verification ? { kind: 'finish', code: verification } : { kind: 'complete' };
  }
  const detail = findings.map(item => item.reason).join('；');
  return { kind: findings.every(item => item.status === 'failed') && canReviseDelivery(c) ? 'revise' : 'finish', detail };
}

export function recoveryCheckExhausted(c: TaskContext, at: number): Intent | undefined {
  if (c.outcome !== null || c.stopped) return undefined;
  const work = c.intents.find(work => isBoundedCheck(work) && ['pending', 'inflight'].includes(work.status));
  if (!work || c.intents.some(localPhysicalPending)) return undefined;
  if (work.deadline !== null && at >= work.deadline) return work;
  if (work.status === 'inflight' && work.requestCount > 0 && !work.checkRetryPending && !canRetryDeliveryCheck(c, work, at)) return work;
  return undefined;
}

export const documentIdentity = (artifact: Artifact) => artifact.documentId ?? artifact.id;

const lastFinal = (c: TaskContext) => c.messages.filter(message => message.kind === 'final').at(-1);

export function publicationIds(c: TaskContext): string[] | undefined {
  if (c.publishedDelivery) return c.publishedDelivery.artifactIds;
  if (c.outcome === 'complete') return lastFinal(c)?.artifactIds ?? c.candidate?.artifactIds;
  return undefined;
}

export function retainLegacyPublication(c: TaskContext, at: number) {
  const artifactIds = publicationIds(c);
  if (!c.publishedDelivery && artifactIds) c.publishedDelivery = {
    goalVersion: c.candidate?.goalVersion ?? c.goalVersion,
    artifactIds: [...artifactIds], at: lastFinal(c)?.at ?? at,
  };
}

export function deliveryVersionProblem(c: TaskContext, e: Delivery): string | null {
  const artifacts = new Map(c.artifacts.map(artifact => [artifact.id, artifact]));
  const latest = new Map(c.artifacts.filter(artifact => artifact.goalVersion === c.goalVersion).map(artifact => [documentIdentity(artifact), artifact.id]));
  const base = new Set(c.candidate?.goalVersion === c.goalVersion ? c.candidate.artifactIds
    : c.publishedDelivery?.goalVersion === c.goalVersion ? c.publishedDelivery.artifactIds : []);
  for (const id of e.backgroundArtifactIds ?? []) {
    if (e.artifactIds.includes(id) || artifacts.get(id)?.goalVersion !== c.goalVersion) return 'INVALID_BACKGROUND_ARTIFACT:' + id;
  }
  const selected = new Set<string>();
  for (const id of new Set(e.artifactIds)) {
    const artifact = artifacts.get(id);
    if (!artifact || artifact.goalVersion !== c.goalVersion) continue;
    const document = documentIdentity(artifact);
    if (latest.get(document) !== id || selected.has(document)) return 'ARTIFACT_REVISION_CONFLICT:' + id;
    selected.add(document);
  }
  for (const draft of e.artifacts ?? []) {
    const id = draft.replacesArtifactId;
    if (!id) continue;
    const artifact = artifacts.get(id);
    if (!artifact || artifact.goalVersion !== c.goalVersion || !base.has(id)
      || !e.workId || !c.intents.some(work => work.id === e.workId && work.kind === 'owner' && work.target === c.owner)) return 'INVALID_ARTIFACT_REVISION_BASE:' + id;
    const document = documentIdentity(artifact);
    if (latest.get(document) !== id || selected.has(document)) return 'ARTIFACT_REVISION_CONFLICT:' + id;
    selected.add(document);
  }
  return null;
}

export function boundCheckProblem(c: TaskContext, e: CheckResult): string | null {
  const candidate = c.candidate;
  const work = e.workId ? c.intents.find(intent => intent.id === e.workId) : undefined;
  if (!isBoundedCheck(work)) return 'CHECK_WORK_REQUIRED';
  if (!candidate?.revision || e.candidateRevision !== candidate.revision || (work.payload.candidate as Candidate | undefined)?.revision !== candidate.revision) return 'STALE_CANDIDATE_CHECK';
  if (work.requestCount === 0 || work.checkRetryPending) return 'CHECK_REQUEST_REQUIRED';
  return null;
}

export function artifactForWork(c: TaskContext, work: Intent, id: string): Artifact | undefined {
  if (work.goalVersion !== c.goalVersion || work.epoch !== c.epoch) return undefined;
  if (work.kind === 'assistance' && !(work.payload.artifacts as Artifact[] | undefined)?.some(item => item.id === id)) return undefined;
  if (!['owner', 'facilitator', 'check', 'assistance'].includes(work.kind)) return undefined;
  return c.artifacts.find(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion);
}
