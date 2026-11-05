import type { Artifact, Candidate, TaskContext, TaskEvent } from '../types.js';

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
type CheckResult = Extract<TaskEvent, { type: 'CHECK_RESULT' }>;

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
  if (work && (work.kind !== 'check' || (work.payload.candidate as Candidate | undefined)?.revision !== candidate?.revision)) return 'STALE_CANDIDATE_CHECK';
  if (e.candidateRevision !== undefined && (!work || e.candidateRevision !== candidate?.revision)) return 'STALE_CANDIDATE_CHECK';
  if (candidate?.requiresBoundCheck && !work) return 'CHECK_WORK_REQUIRED';
  return null;
}
