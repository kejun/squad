import { deliveryEvidence } from './task/evidence.js';
import type { ArtifactDraft, TaskContext, TaskEvent } from './types.js';
import { savedResourceAcquisitions } from './resource-acquisition.js';
import { documentBodies } from './acquisition-readers.js';

/** Mechanical provenance gate; semantic correctness still requires independent assessment. */
export function sourceItemsProblem(c: TaskContext, e: Extract<TaskEvent, { type: 'DELIVER' }>): string | null {
  for (const draft of e.artifacts ?? []) {
    if (!draft.sourceItems && c.artifacts.some(artifact => artifact.id === draft.replacesArtifactId && artifact.sourceItems?.length))
      return 'SOURCE_ITEMS_REQUIRED';
  }
  const reports: Pick<ArtifactDraft, 'sourceItems'>[] = [...(e.artifacts ?? []),
    ...c.artifacts.filter(artifact => e.artifactIds.includes(artifact.id) && artifact.goalVersion === c.goalVersion)];
  const items = reports.flatMap(report => report.sourceItems ?? []);
  if (!items.length) return null;
  const work = c.intents.find(work => work.id === e.workId && work.kind === 'owner');
  const evidence = work && deliveryEvidence(c, work, c.deliveryCycle?.evidence);
  for (const item of items) {
    const source = evidence?.sources.find(source => source.id === item.sourceEvidenceId);
    if (!source || source.metadata.epoch !== c.epoch || source.metadata.status !== 'succeeded'
      || source.metadata.command.type === 'runCli' && source.metadata.exitCode !== 0
      || source.metadata.completeness !== 'complete' || source.stdout === undefined)
      return 'SOURCE_EVIDENCE_UNAVAILABLE';
    const receipts = savedResourceAcquisitions(c).filter(receipt => receipt.operationId === source.id || receipt.id === source.id);
    const document = receipts.find(receipt => receipt.resource.kind === 'document' && receipt.resource.id === item.sourceDocId
      || receipt.resource.kind === 'url' && receipt.documentId === item.sourceDocId);
    if (document) {
      if (!document.content.includes(item.status)) return 'SOURCE_STATUS_MISMATCH';
      continue;
    }
    const bodies = documentBodies(source.stdout, item.sourceDocId);
    if (!bodies.length) return 'SOURCE_DOCUMENT_NOT_FOUND';
    if (bodies.length !== 1) return 'SOURCE_DOCUMENT_AMBIGUOUS';
    if (!bodies[0]!.some(body => body.includes(item.status))) return 'SOURCE_STATUS_MISMATCH';
    const acquired = receipts.some(receipt => receipt.resource.kind === 'url' && receipt.documentId === undefined);
    if (!acquired) return 'SOURCE_ACQUISITION_UNVERIFIED';
  }
  return null;
}
