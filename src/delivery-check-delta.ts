import { checkCitationSources, judgmentsDiagnostic, type CheckMaterials, type CriterionJudgment } from './delivery-acceptance.js';
import { deliveryEvidence } from './task/evidence.js';
import { deliveryVerificationEvidence } from './task/verification.js';
import type { Artifact, Candidate, Intent, TaskContext } from './types.js';

interface TextChange { offset: number; removed: string; added: string; before: string; after: string; oldLength: number; newLength: number }
interface SourceExcerpt { id: string; field: 'stdout' | 'stderr' | 'content'; offset: number; length: number; totalLength: number }
export interface DeliveryCheckDelta {
  baseWorkId: string;
  baseRevision: string;
  previousResults: CriterionJudgment[];
  candidate: TextChange;
  artifacts: { id: string; baseId: string; name: string; change: TextChange }[];
  sources: SourceExcerpt[];
  sourceIndex: { id: string; fields: { field: string; length: number }[] }[];
}

function completeMaterials(c: TaskContext, work: Intent): CheckMaterials | undefined {
  const candidate = work.payload.candidate as Candidate | undefined;
  if (!candidate?.revision || !candidate.acceptance) return undefined;
  const evidence = c.deliveryCycle?.evidence && deliveryEvidence(c, work, c.deliveryCycle.evidence);
  if (!evidence) return undefined;
  const artifacts = (work.payload.artifacts as Artifact[]).map(({ id, name, content }) => ({ id, name, content,
    ...(!candidate.artifactIds.includes(id) ? { background: true } : {}) }));
  const previousResults = work.payload.priorFindings as CriterionJudgment[];
  const references = work.payload.references as CheckMaterials['references'];
  const reviewRecords = work.payload.reviewRecords as CheckMaterials['reviewRecords'];
  const verification = deliveryVerificationEvidence(work);
  const retryDiagnostic = work.checkDiagnostics?.filter(record => record.candidateRevision === candidate.revision && record.attempt < work.attempt).at(-1)?.diagnostic;
  return { requirements: candidate.acceptance.criteria, candidate: { revision: candidate.revision, text: candidate.text }, artifacts,
    ...(work.payload.sourceArtifact ? { sourceArtifact: work.payload.sourceArtifact as NonNullable<CheckMaterials['sourceArtifact']> } : {}),
    evidence: evidence.sources, rawInputs: work.payload.rawInputs as CheckMaterials['rawInputs'], previousResults,
    ...(references?.length ? { references } : {}), ...(reviewRecords?.length ? { reviewRecords } : {}),
    ...(previousResults.length && candidate.summary ? { revisionNotes: candidate.summary } : {}), ...(verification ? { verification } : {}),
    ...(retryDiagnostic ? { retryDiagnostic } : {}) };
}

function textChange(oldText: string, newText: string): TextChange {
  let offset = 0;
  while (offset < oldText.length && offset < newText.length && oldText[offset] === newText[offset]) offset++;
  let suffix = 0;
  while (suffix < oldText.length - offset && suffix < newText.length - offset
    && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++;
  return { offset, removed: oldText.slice(offset, oldText.length - suffix), added: newText.slice(offset, newText.length - suffix),
    before: oldText.slice(Math.max(0, offset - 160), offset), after: oldText.slice(oldText.length - suffix, oldText.length - suffix + 160),
    oldLength: oldText.length, newLength: newText.length };
}

function sourceExcerpts(material: CheckMaterials, results: CriterionJudgment[]) {
  const all: { id: string; stdout?: string; stderr?: string; content?: string }[] = checkCitationSources(material);
  const excerpts: SourceExcerpt[] = [];
  const fields = new Map<string, Partial<Record<'stdout' | 'stderr' | 'content', string>>>();
  for (const result of results) {
    if (!result.source) continue;
    const source = all.find(item => item.id === result.source!.id)!;
    for (const field of ['stdout', 'stderr', 'content'] as const) {
      const text = source[field];
      if (text === undefined) continue;
      const at = text.indexOf(result.source.quote);
      if (at < 0) continue;
      // One contiguous window per source field retains verbatim quotation semantics.
      const prior = excerpts.find(item => item.id === source.id && item.field === field);
      const start = Math.min(prior?.offset ?? text.length, Math.max(0, at - 160));
      const end = Math.max(prior ? prior.offset + prior.length : 0, Math.min(text.length, at + result.source.quote.length + 160));
      if (prior) { prior.offset = start; prior.length = end - start; }
      else excerpts.push({ id: source.id, field, offset: start, length: end - start, totalLength: text.length });
      fields.set(source.id, { ...fields.get(source.id), [field]: text.slice(start, end) });
      break;
    }
  }
  return { fields, excerpts, all };
}

function insertedLinesAreKnown(oldText: string, newText: string, quotedText: readonly string[]): boolean {
  const diff = textChange(oldText, newText);
  if (!diff.added) return true;
  const start = newText.lastIndexOf('\n', Math.max(0, diff.offset - 1)) + 1;
  const nextNewline = newText.indexOf('\n', diff.offset + diff.added.length);
  const end = nextNewline < 0 ? newText.length : nextNewline;
  return newText.slice(start, end).split('\n').filter(line => line.trim()).every(line => oldText.includes(line)
    || quotedText.some(text => text.includes(line)));
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A pure projection of a persisted check intent; it never fetches or refreshes evidence. */
export function deliveryCheckMaterials(c: TaskContext, work: Intent): CheckMaterials | undefined {
  const full = completeMaterials(c, work);
  if (!full) return undefined;
  if ((work.payload.candidate as Candidate).partitionRecoveries?.length) return full;
  const base = c.intents.find(item => item.id === work.payload.baselineCheckId && item.kind === 'check'
    && item.epoch === work.epoch && item.goalVersion === work.goalVersion && item.status === 'done');
  const results = base?.criteriaResults;
  if (!base || !results?.length || !results.some(item => item.status === 'failed')
    || results.some(item => item.status === 'unverified' || item.status === 'failed' && !item.source)) return full;
  const previous = completeMaterials(c, base);
  if (!previous || full.sourceArtifact || full.verification || previous.verification
    || !same(previous.requirements, full.requirements) || !same(previous.rawInputs, full.rawInputs)
    || !same(previous.references, full.references) || !same(previous.reviewRecords, full.reviewRecords)
    || judgmentsDiagnostic(previous.requirements, results, checkCitationSources(previous))) return full;
  const candidate = work.payload.candidate as Candidate, oldCandidate = base.payload.candidate as Candidate;
  if (!same(candidate.backgroundArtifactIds, oldCandidate.backgroundArtifactIds)) return full;
  const oldArtifacts = base.payload.artifacts as Artifact[], artifacts = work.payload.artifacts as Artifact[];
  const selected = artifacts.filter(item => candidate.artifactIds.includes(item.id));
  const oldSelected = oldArtifacts.filter(item => oldCandidate.artifactIds.includes(item.id));
  if (selected.length !== oldSelected.length) return full;
  const sources = sourceExcerpts(previous, results);
  const relevant = [...sources.fields.values()].flatMap(item => Object.values(item));
  if (!insertedLinesAreKnown(previous.candidate.text, full.candidate.text, relevant)) return full;
  const changes: DeliveryCheckDelta['artifacts'] = [];
  for (const artifact of selected) {
    const old = oldSelected.find(item => (item.documentId ?? item.id) === (artifact.documentId ?? artifact.id));
    if (!old || old.name !== artifact.name || !insertedLinesAreKnown(old.content, artifact.content, relevant)) return full;
    changes.push({ id: artifact.id, baseId: old.id, name: artifact.name, change: textChange(old.content, artifact.content) });
  }
  const delta: DeliveryCheckDelta = { baseWorkId: base.id, baseRevision: previous.candidate.revision,
    previousResults: results, candidate: textChange(previous.candidate.text, full.candidate.text), artifacts: changes,
    sources: sources.excerpts, sourceIndex: sources.all.map(source => ({ id: source.id,
      fields: (['stdout', 'stderr', 'content'] as const).flatMap(field => source[field] === undefined ? [] : [{ field, length: source[field]!.length }]) })) };
  const projected: CheckMaterials = { ...full, candidate: { revision: full.candidate.revision, text: '' }, artifacts: [], delta,
    evidence: full.evidence.map(({ stdout: _stdout, stderr: _stderr, ...source }) => ({ ...source, ...sources.fields.get(source.id) })),
    ...(full.references ? { references: full.references.filter(source => sources.fields.has(source.id)).map(source => ({ ...source, content: sources.fields.get(source.id)?.content ?? '' })) } : {}),
    ...(full.reviewRecords ? { reviewRecords: full.reviewRecords.filter(source => sources.fields.has(source.id)).map(source => ({ id: source.id, content: sources.fields.get(source.id)?.content ?? '',
      ...(sources.fields.get(source.id)?.stdout === undefined ? {} : { stdout: sources.fields.get(source.id)!.stdout! }) })) } : {}) };
  // Small reports gain no compression and retain the simple complete-check protocol.
  return JSON.stringify(projected).length < JSON.stringify(full).length * 0.8 ? projected : full;
}
