import { deliveryEvidence } from './task/evidence.js';
import type { ArtifactDraft, TaskContext, TaskEvent } from './types.js';

const bodyFields = ['body', 'body_markdown', 'body_html', 'content', 'description'] as const;
function documentBodies(stdout: string, id: string): string[][] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const queue: unknown[] = [parsed];
  const bodies: string[][] = [];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { for (const child of value) queue.push(child); continue; }
    const record = value as Record<string, unknown>;
    const matches = [record.id, record.slug].some(value => (typeof value === 'string' || typeof value === 'number') && String(value) === id);
    const fields = bodyFields.flatMap(key => typeof record[key] === 'string' ? [record[key]] : []);
    if (matches && fields.length) bodies.push(fields);
    for (const child of Object.values(record)) if (child !== null && typeof child === 'object') queue.push(child);
  }
  return bodies;
}

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
      || source.metadata.exitCode !== 0 || source.metadata.completeness !== 'complete' || source.stdout === undefined)
      return 'SOURCE_EVIDENCE_UNAVAILABLE';
    const bodies = documentBodies(source.stdout, item.sourceDocId);
    if (!bodies.length) return 'SOURCE_DOCUMENT_NOT_FOUND';
    if (bodies.length !== 1) return 'SOURCE_DOCUMENT_AMBIGUOUS';
    if (!bodies[0]!.some(body => body.includes(item.status))) return 'SOURCE_STATUS_MISMATCH';
  }
  return null;
}
