import type { Artifact, Candidate, InputReference, Intent, TaskContext, TaskEvent } from '../types.js';
import { checkCitationSources, judgmentsDiagnostic, type CheckDiagnostic, type CheckMaterials, type CheckReferenceSource, type CheckReviewSource } from '../delivery-acceptance.js';
import { pendingHostRetry } from '../host-retry.js';
import { cliArtifactIds, localPhysicalPending } from '../local-operation.js';
import { canRetryDeliveryCheck } from './budget.js';
import { deliveryCheckEvidence } from './evidence.js';
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
  const problem = deliveryVersionProblem(c, normalizeDeliveryArtifacts(c, e));
  if (problem) return { code: problem, mechanical: true };
  const budget = deliveryCheckBudgetProblem(c);
  if (budget) return { code: budget, mechanical: false };
  return null;
}

function includeCliArtifacts(c: TaskContext, e: Delivery): Delivery {
  const work = c.intents.find(intent => intent.id === e.workId);
  if (!work || work.kind !== 'owner' || work.target !== c.owner || work.goalVersion !== c.goalVersion || work.epoch !== c.epoch) return e;
  const savedIds = new Set(cliArtifactIds(...c.intents.filter(intent => intent.kind === 'owner'
    && intent.goalVersion === c.goalVersion && intent.epoch <= c.epoch)));
  if (!savedIds.size) return e;
  const current = c.artifacts.filter(artifact => artifact.goalVersion === c.goalVersion && artifact.id !== c.sourceArtifact?.artifactId);
  const replaced = new Set([...current.map(artifact => artifact.replacesArtifactId), ...(e.artifacts ?? []).map(draft => draft.replacesArtifactId)]);
  const background = new Set(e.backgroundArtifactIds);
  if (c.candidate?.goalVersion === c.goalVersion) {
    for (const id of c.candidate.backgroundArtifactIds ?? []) {
      if (savedIds.has(id) && !e.artifactIds.includes(id) && !replaced.has(id)) background.add(id);
    }
  }
  const added = current.filter(artifact => savedIds.has(artifact.id) && !background.has(artifact.id) && !replaced.has(artifact.id))
    .map(artifact => artifact.id);
  return { ...e, artifactIds: [...new Set([...e.artifactIds, ...added])], backgroundArtifactIds: [...background] };
}

export function normalizeDeliveryArtifacts(c: TaskContext, e: Delivery): Delivery {
  if (c.config.deliveryReport !== 'summary') return includeCliArtifacts(c, e);
  const { artifacts, latest, base } = deliveryArtifactVersions(c);
  const canRevise = canReviseDeliveryArtifact(c, e);
  const revised = new Set<string>();
  const drafts = e.artifacts?.map(draft => {
    const { replacesArtifactId: id, ...independent } = draft;
    if (!id) return draft;
    if (!canRevise || !base.has(id) || !isLatestArtifact(id, artifacts, latest) || revised.has(id)) return independent;
    revised.add(id);
    return draft;
  });
  const delivery = includeCliArtifacts(c, { ...e, ...(drafts ? { artifacts: drafts } : {}) });
  const artifactIds = [...new Set(delivery.artifactIds)].filter(id => !revised.has(id) && isLatestArtifact(id, artifacts, latest));
  const selected = new Set(artifactIds);
  const backgroundArtifactIds = [...new Set(delivery.backgroundArtifactIds)].filter(id => !selected.has(id) && artifacts.has(id));
  return { ...delivery, artifactIds, backgroundArtifactIds };
}

export function deliveryInterruptionPending(c: TaskContext, settlingWorkId?: string): boolean {
  return deliveryHandoffPending(c) || pendingHostRetry(c) || c.intents.some(work => work.id !== settlingWorkId && localPhysicalPending(work));
}

export function currentDeliveryCheck(c: TaskContext): BoundedCheck | undefined {
  const revision = c.candidate?.revision;
  if (!revision) return undefined;
  return [...c.intents].reverse().find((work): work is BoundedCheck => isBoundedCheck(work) && work.goalVersion === c.goalVersion
    && (work.payload.candidate as Candidate | undefined)?.revision === revision);
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
  if (resourceProblem) return { kind: 'finish', code: resourceProblem, detail: '必需资源仍缺少可核实的获取凭证', checked: true };
  const mechanical = completeProblem(c);
  if (mechanical) return { kind: 'finish', code: mechanical, checked: true };
  const findings = e.criteriaResults!.filter(item => item.status !== 'passed');
  if (!findings.length) {
    const verification = deliveryVerificationProblem(work, true);
    return { kind: 'complete', checked: true, ...(verification ? { code: 'CHECK_VERIFICATION_UNCONFIRMED', detail: `实际验证未完成：${verification}` } : {}) };
  }
  return { kind: 'complete', checked: true, detail: findings.map(item => item.reason).join('；') };
}

export function checkDisposition(c: TaskContext, e: CheckResult, work: Intent): CheckDisposition {
  const interruption = beforeCheckResult(c, e, work);
  if (interruption) return interruption;
  const evidence = deliveryCheckEvidence(c, work);
  if (!evidence) return { kind: 'finish', code: 'CHECK_EVIDENCE_CHANGED' };
  const test = deliveryVerificationEvidence(work);
  const references = (work.payload.references as CheckReferenceSource[] | undefined) ?? [];
  const reviewRecords = (work.payload.reviewRecords as CheckReviewSource[] | undefined) ?? [];
  const rawInputs = (work.payload.rawInputs as CheckMaterials['rawInputs'] | undefined) ?? [];
  const sources = checkCitationSources({ evidence, references, reviewRecords, rawInputs, ...(test ? { verification: test } : {}) });
  const diagnostic = e.passed !== undefined || e.gaps !== undefined ? { code: 'CHECK_INVALID_CRITERIA_RESULTS' }
    : e.repair && work.payload.manualCheck === true ? { code: 'CHECK_RETRY_CANNOT_REPLACE_DELIVERY' }
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

function deliveryArtifactVersions(c: TaskContext) {
  const current = c.artifacts.filter(artifact => artifact.goalVersion === c.goalVersion && artifact.id !== c.sourceArtifact?.artifactId);
  const artifacts = new Map(current.map(artifact => [artifact.id, artifact]));
  const latest = new Map(current.map(artifact => [documentIdentity(artifact), artifact.id]));
  const base = new Set(c.candidate?.goalVersion === c.goalVersion ? c.candidate.artifactIds
    : c.publishedDelivery?.goalVersion === c.goalVersion ? c.publishedDelivery.artifactIds : []);
  return { artifacts, latest, base };
}

function isLatestArtifact(id: string, artifacts: Map<string, Artifact>, latest: Map<string, string>): boolean {
  const artifact = artifacts.get(id);
  return !!artifact && latest.get(documentIdentity(artifact)) === id;
}

function canReviseDeliveryArtifact(c: TaskContext, e: Delivery): boolean {
  return !!e.workId && c.intents.some(work => work.id === e.workId && (work.kind === 'owner' && work.target === c.owner || isBoundedCheck(work)));
}

export function deliveryVersionProblem(c: TaskContext, e: Delivery): string | null {
  const { artifacts, latest, base } = deliveryArtifactVersions(c);
  for (const id of e.backgroundArtifactIds ?? []) {
    if (e.artifactIds.includes(id) || !artifacts.has(id)) return 'INVALID_BACKGROUND_ARTIFACT:' + id;
  }
  const selected = new Set<string>();
  for (const id of new Set(e.artifactIds)) {
    const artifact = artifacts.get(id);
    if (!artifact) continue;
    const document = documentIdentity(artifact);
    if (latest.get(document) !== id || selected.has(document)) return 'ARTIFACT_REVISION_CONFLICT:' + id;
    selected.add(document);
  }
  for (const draft of e.artifacts ?? []) {
    const id = draft.replacesArtifactId;
    if (!id) continue;
    const artifact = artifacts.get(id);
    if (!artifact || !base.has(id) || !canReviseDeliveryArtifact(c, e)) return 'INVALID_ARTIFACT_REVISION_BASE:' + id;
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
