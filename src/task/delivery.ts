import type { Artifact, Candidate, InputReference, Intent, TaskContext, TaskEvent } from '../types.js';
import { checkCitationSources, judgmentsDiagnostic, type CheckDiagnostic, type CheckMaterials, type CheckReferenceSource, type CheckReviewSource } from '../delivery-acceptance.js';
import { pendingHostRetry } from '../host-retry.js';
import { localPhysicalPending } from '../local-operation.js';
import { canRetryDeliveryCheck } from './budget.js';
import { deliveryEvidence } from './evidence.js';
import { completeProblem, deliveryHandoffPending } from './facts.js';
import { deliveryVerificationEvidence, deliveryVerificationPlan, deliveryVerificationProblem } from './verification.js';
import { resourceAcquisitionProblem } from '../resource-acquisition.js';

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
type CheckResult = Extract<TaskEvent, { type: 'CHECK_RESULT' }>;

export { newDeliveryCycle } from './delivery-cycle.js';

type BoundedCheck = Intent & { kind: 'check' };
export const isBoundedCheck = (work: Intent | undefined): work is BoundedCheck => work?.kind === 'check' && work.payload.deliveryProtocol === 'bounded';

export function settlingDeliveryCheck(c: TaskContext, work: Intent | undefined): boolean {
  return isBoundedCheck(work) && work.status === 'inflight' && work.epoch === c.epoch && work.goalVersion === c.goalVersion
    && c.outcome === null && !c.stopped;
}

export function hasDeliveryRetryPermit(c: TaskContext, work: Intent): boolean {
  return c.deliveryCycle?.retry?.workId === work.id && c.deliveryCycle.retry.status === 'reserved';
}

export function deliveryCheckBudgetProblem(c: TaskContext, _technical = false): string | null {
  if (!c.deliveryCycle) return 'CHECK_PROTOCOL_CHANGED';
  return c.usage.checks >= c.config.limits.checks ? 'CHECK_BUDGET_EXHAUSTED' : null;
}

function historicalContent(c: TaskContext, ref: InputReference): string | undefined {
  if (ref.kind === 'artifact' && c.sourceArtifact?.sourceTaskId === ref.taskId && c.sourceArtifact.artifactId === ref.id) return c.sourceArtifact.content;
  const sameRecord = (item: { taskId: string; id: string }) => item.taskId === ref.taskId && item.id === ref.id;
  switch (ref.kind) {
    case 'message': {
      const message = c.history?.messages.find(sameRecord);
      return message?.detailText ?? message?.text;
    }
    case 'artifact': return c.history?.artifacts.find(sameRecord)?.content;
    case 'board': return c.history?.board.find(sameRecord)?.text;
    case 'task': return ref.taskId === ref.id ? c.history?.tasks?.find(task => task.taskId === ref.taskId)?.goal.text : undefined;
  }
}

export function checkReferenceSources(c: TaskContext): CheckReferenceSource[] {
  const previous = c.deliveryCycle?.evidence && c.candidate?.revision
    ? c.intents.find(work => isBoundedCheck(work) && work.criteriaResults
      && (work.payload.candidate as Candidate | undefined)?.revision === c.candidate?.revision) : undefined;
  if (previous) return (previous.payload.references as CheckReferenceSource[] | undefined) ?? [];
  const sources = new Map<string, CheckReferenceSource>();
  if (c.sourceArtifact) {
    const source = c.sourceArtifact;
    const id = `history:${JSON.stringify(['artifact', source.sourceTaskId, source.artifactId])}`;
    sources.set(id, { id, taskId: source.sourceTaskId, kind: 'artifact', content: source.content });
  }
  for (const input of c.inputAnalyses ?? []) {
    if (input.goalVersion !== c.goalVersion || input.status !== 'resolved' || input.action === 'review') continue;
    for (const ref of input.spec?.references ?? []) {
      if (ref.taskId === c.taskId) continue;
      const id = `history:${JSON.stringify([ref.kind, ref.taskId, ref.id])}`;
      if (sources.has(id)) continue;
      const content = historicalContent(c, ref);
      sources.set(id, { id, taskId: ref.taskId, kind: ref.kind, content: content ?? '', ...(content === undefined ? { unavailable: true } : {}) });
    }
  }
  return [...sources.values()];
}

export function deliverySubmissionProblem(c: TaskContext, e: Delivery): { code: string; mechanical: boolean } | null {
  const problem = deliveryVersionProblem(c, e);
  if (problem) return { code: problem, mechanical: true };
  const acquisition = resourceAcquisitionProblem(c);
  if (acquisition) return { code: acquisition, mechanical: false };
  const budget = deliveryCheckBudgetProblem(c);
  if (budget) return { code: budget, mechanical: false };
  return null;
}

export function deliveryInterruptionPending(c: TaskContext, settlingWorkId?: string): boolean {
  return deliveryHandoffPending(c) || pendingHostRetry(c) || c.intents.some(work => work.id !== settlingWorkId && localPhysicalPending(work));
}

type CheckDisposition = { kind: 'handoff' | 'complete' | 'finish' | 'retry'; code?: string; detail?: string; checked?: true; diagnostic?: CheckDiagnostic };

export function saveCheckDiagnostic(c: TaskContext, work: Intent, diagnostic: CheckDiagnostic | undefined): void {
  if (!diagnostic
    || !isBoundedCheck(work) || c.stopped || c.outcome !== null || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion) return;
  const revision = (work.payload.candidate as Candidate | undefined)?.revision;
  if (!revision || revision !== c.candidate?.revision) return;
  const records = work.checkDiagnostics ??= [];
  if (!records.some(record => record.attempt === work.attempt)) records.push({ attempt: work.attempt, candidateRevision: revision, diagnostic });
}

function beforeCheckResult(c: TaskContext, e: CheckResult, work: Intent): CheckDisposition | null {
  if (deliveryInterruptionPending(c)) return { kind: 'handoff' };
  if (work.deadline !== null && e.at >= work.deadline) return { kind: 'finish', code: 'WORK_EXPIRED' };
  return null;
}

function checkedDelivery(c: TaskContext, e: CheckResult, work: Intent): CheckDisposition {
  const resourceProblem = resourceAcquisitionProblem(c);
  if (resourceProblem) return { kind: 'finish', code: resourceProblem, checked: true };
  const mechanical = completeProblem(c);
  if (mechanical) return { kind: 'finish', code: mechanical, checked: true };
  const findings = e.criteriaResults!.filter(item => item.status !== 'passed');
  if (!findings.length) {
    const verification = deliveryVerificationProblem(work, true);
    return { kind: 'complete', checked: true, ...(verification ? { detail: `实际验证未完成：${verification}` } : {}) };
  }
  return { kind: 'complete', checked: true, detail: findings.map(item => item.reason).join('；') };
}

export function checkDisposition(c: TaskContext, e: CheckResult, work: Intent): CheckDisposition {
  const interruption = beforeCheckResult(c, e, work);
  if (interruption) return interruption;
  const evidence = c.deliveryCycle?.evidence && deliveryEvidence(c, work, c.deliveryCycle.evidence);
  if (!evidence) return { kind: 'finish', code: 'CHECK_EVIDENCE_CHANGED' };
  const test = deliveryVerificationEvidence(work);
  const references = (work.payload.references as CheckReferenceSource[] | undefined) ?? [];
  const reviewRecords = (work.payload.reviewRecords as CheckReviewSource[] | undefined) ?? [];
  const rawInputs = (work.payload.rawInputs as CheckMaterials['rawInputs'] | undefined) ?? [];
  const sources = checkCitationSources({ evidence: evidence.sources, references, reviewRecords, rawInputs, ...(test ? { verification: test } : {}) });
  const diagnostic = e.passed !== undefined || e.gaps !== undefined ? { code: 'CHECK_INVALID_CRITERIA_RESULTS' }
    : judgmentsDiagnostic(c.candidate!.acceptance!.criteria, e.criteriaResults, sources);
  if (diagnostic) return { kind: canRetryDeliveryCheck(c, work, e.at, true) ? 'retry' : 'finish', code: diagnostic.code, diagnostic };
  return checkedDelivery(c, e, work);
}

export function recoveryCheckExhausted(c: TaskContext, at: number): Intent | undefined {
  if (c.outcome !== null || c.stopped || deliveryInterruptionPending(c)) return undefined;
  const work = c.intents.find(work => isBoundedCheck(work) && ['pending', 'inflight'].includes(work.status));
  if (!work) return undefined;
  if (work.deadline !== null && at >= work.deadline) return work;
  if (work.status === 'inflight' && work.requestCount > 0 && !hasDeliveryRetryPermit(c, work) && !canRetryDeliveryCheck(c, work, at)) return work;
  return undefined;
}

export const documentIdentity = (artifact: Artifact) => artifact.documentId ?? artifact.id;

const lastFinal = (c: TaskContext) => c.messages.filter(message => message.kind === 'final').at(-1);

export function publicationIds(c: TaskContext): string[] | undefined {
  if (c.resilience?.frozen?.goalVersion === c.goalVersion) return c.resilience.frozen.artifactIds;
  if (c.publishedDelivery) return c.publishedDelivery.goalVersion === c.goalVersion ? c.publishedDelivery.artifactIds : [];
  const selected = lastFinal(c)?.artifactIds ?? c.candidate?.artifactIds;
  if (c.outcome !== null && selected) return selected
    .filter(id => c.artifacts.some(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion));
  return undefined;
}

export function retainLegacyPublication(c: TaskContext, at: number) {
  if (c.outcome !== 'complete') return;
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
      || !e.workId || !c.intents.some(work => work.id === e.workId && (work.kind === 'owner' && work.target === c.owner || isBoundedCheck(work)))) return 'INVALID_ARTIFACT_REVISION_BASE:' + id;
    const document = documentIdentity(artifact);
    if (latest.get(document) !== id || selected.has(document)) return 'ARTIFACT_REVISION_CONFLICT:' + id;
    selected.add(document);
  }
  return null;
}

export function boundCheckProblem(c: TaskContext, e: CheckResult): string | null {
  const candidate = c.candidate;
  const work = e.workId ? c.intents.find(intent => intent.id === e.workId) : undefined;
  if (!isBoundedCheck(work) || !e.fence || e.attempt !== work.attempt) return 'CHECK_WORK_REQUIRED';
  if (!candidate?.revision || e.candidateRevision !== candidate.revision || (work.payload.candidate as Candidate | undefined)?.revision !== candidate.revision) return 'STALE_CANDIDATE_CHECK';
  const stage = c.deliveryCycle?.stage;
  if (stage?.kind !== 'checking' || stage.checkWorkId !== work.id || stage.candidateRevision !== candidate.revision) return 'STALE_CANDIDATE_CHECK';
  if (work.requestCount === 0 || hasDeliveryRetryPermit(c, work)) return 'CHECK_REQUEST_REQUIRED';
  return null;
}

export function artifactForWork(c: TaskContext, work: Intent, id: string): Artifact | undefined {
  if (work.goalVersion !== c.goalVersion || work.epoch !== c.epoch) return undefined;
  if (work.kind === 'assistance' && !(work.payload.artifacts as Artifact[] | undefined)?.some(item => item.id === id)) return undefined;
  if (!['owner', 'facilitator', 'check', 'assistance'].includes(work.kind)) return undefined;
  return c.artifacts.find(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion);
}
