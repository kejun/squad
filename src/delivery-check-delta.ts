import { type CheckMaterials, type CriterionJudgment } from './delivery-acceptance.js';
import { deliveryEvidence } from './task/evidence.js';
import { deliveryVerificationEvidence } from './task/verification.js';
import type { Artifact, Candidate, Intent, TaskContext } from './types.js';

function completeMaterials(c: TaskContext, work: Intent): CheckMaterials | undefined {
  const candidate = work.payload.candidate as Candidate | undefined;
  if (!candidate?.revision || !candidate.acceptance) return undefined;
  const evidence = c.deliveryCycle?.evidence && deliveryEvidence(c, work, c.deliveryCycle.evidence);
  if (!evidence) return undefined;
  const ownSources = deliveryEvidence(c, work)?.sources.filter(source => source.metadata.sourceWorkId === work.id) ?? [];
  const sources = [...evidence.sources, ...ownSources.filter(source => !evidence.sources.some(fixed => fixed.id === source.id))];
  const artifacts = (work.payload.artifacts as Artifact[]).map(({ id, name, content, sourceItems }) => ({ id, name, content,
    ...(sourceItems?.length ? { sourceItems } : {}),
    ...(!candidate.artifactIds.includes(id) ? { background: true } : {}) }));
  const previousResults = work.payload.priorFindings as CriterionJudgment[];
  const references = work.payload.references as CheckMaterials['references'];
  const reviewRecords = work.payload.reviewRecords as CheckMaterials['reviewRecords'];
  const verification = deliveryVerificationEvidence(work);
  const validation = work.localOperations?.filter(op => op.action.type === 'runCli').at(-1);
  const executionNotes = [...((work.payload.executionNotes as string[] | undefined) ?? []),
    ...(validation?.result?.ok === false ? [`实际命令未成功：${validation.result.code}`] : [])];
  const retryDiagnostic = work.checkDiagnostics?.filter(record => record.candidateRevision === candidate.revision && record.attempt < work.attempt).at(-1)?.diagnostic;
  return { requirements: candidate.acceptance.criteria, candidate: { revision: candidate.revision, text: candidate.text }, artifacts,
    ...(executionNotes.length ? { executionNotes } : {}),
    ...(work.payload.sourceArtifact ? { sourceArtifact: work.payload.sourceArtifact as NonNullable<CheckMaterials['sourceArtifact']> } : {}),
    evidence: sources, rawInputs: work.payload.rawInputs as CheckMaterials['rawInputs'], previousResults,
    ...(references?.length ? { references } : {}), ...(reviewRecords?.length ? { reviewRecords } : {}),
    ...(previousResults.length && candidate.summary ? { revisionNotes: candidate.summary } : {}), ...(verification ? { verification } : {}),
    ...(retryDiagnostic ? { retryDiagnostic } : {}) };
}

/** One downstream handoff always carries the complete current report and frozen sources. */
export function deliveryCheckMaterials(c: TaskContext, work: Intent): CheckMaterials | undefined {
  return completeMaterials(c, work);
}
