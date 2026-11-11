import { z } from 'zod';
import { isLongResult } from './presentation.js';
import { mapRecoveryCriteria } from './task/map-recovery.js';
import type { DeliveryEvidenceSource } from './task/evidence.js';
import type { ArtifactSourceMetadata, Candidate, InputAnalysis, InputReference, TaskContext, TaskEvent } from './types.js';
import { missingResourceAcquisitions } from './resource-acquisition.js';

export type CriterionSource = { kind: 'goal' | 'input'; id: string };
export type AcceptanceCriterion = { id: string; text: string; goalVersion: number; sources: CriterionSource[]; requiredSourceIds?: string[] };
export type CriterionJudgment = { criterionId: string; source?: { id: string; quote: string } } & (
  | { status: 'passed'; reason?: string }
  | { status: 'failed' | 'unverified'; reason: string }
);
export type DeliveryAcceptance = { revision: string; criteria: AcceptanceCriterion[] };
export type CheckReferenceSource = { id: string; taskId: string; kind: InputReference['kind']; content: string };
export interface CheckReviewSource { id: string; content: string; stdout?: string }

/** Host-generated location only: never retain rejected model text or unknown IDs. */
export interface CheckDiagnostic {
  code: string;
  criterionId?: string;
  sourceId?: string;
  quoteLength?: number;
  location?: { field: 'stdout' | 'stderr' | 'content'; offset: number; matchedPrefixLength: number };
}
export interface CheckDiagnosticRecord { attempt: number; candidateRevision: string; diagnostic: CheckDiagnostic }

function mapReviewSources(c: TaskContext): CheckReviewSource[] {
  const round = c.discussion;
  if (!round?.mapReduce || round.goalVersion !== c.goalVersion || round.status !== 'delivered') return [];
  const plan = round.mapReduce;
  return round.results.flatMap(result => {
    const assignment = plan.assignments.find(item => item.target === result.target);
    const partition = plan.partitions.find(item => item.id === (result.partitionId ?? assignment?.partitionId));
    if (!partition) return [];
    const artifacts = c.artifacts.filter(item => result.artifactIds.includes(item.id) && item.goalVersion === round.goalVersion)
      .map(({ id, name, content }) => ({ id, name, content }));
    return [{ id: result.id ?? `${round.id}:member:${result.target}`,
      stdout: ['Question:', partition.objective, 'Expected:', partition.expectedOutput, 'Answer:', result.answer,
        ...artifacts.flatMap(item => ['Artifact:', item.name, item.content])].join('\n'),
      content: JSON.stringify({ discussionId: round.id, member: result.target, status: result.status,
        goalVersion: round.goalVersion, epoch: round.epoch, partition, question: partition.objective,
        expected: partition.expectedOutput, answer: result.answer, artifacts }),
    }];
  });
}

/** Freeze accepted current-goal collaboration records; these prove process, not correctness. */
export function checkReviewSources(c: TaskContext): CheckReviewSource[] {
  const reviews = c.assists.filter(review => review.goalVersion === c.goalVersion && review.consumed
    && review.resultId && review.answer !== undefined && ['success', 'partial', 'failed'].includes(review.status))
    .map(review => ({ id: review.resultId!, stdout: ['Question:', review.question, 'Expected:', review.expected, 'Answer:', review.answer!,
      ...c.artifacts.filter(artifact => review.artifactIds?.includes(artifact.id) && artifact.goalVersion === c.goalVersion)
        .flatMap(artifact => ['Artifact:', artifact.name, artifact.content])].join('\n'), content: JSON.stringify({ requestId: review.id, member: review.target,
      status: review.status, goalVersion: review.goalVersion, epoch: review.epoch, question: review.question,
      expected: review.expected, answer: review.answer,
      artifacts: c.artifacts.filter(artifact => review.artifactIds?.includes(artifact.id) && artifact.goalVersion === c.goalVersion)
        .map(({ id, name, content }) => ({ id, name, content })),
    }) }));
  return [...reviews, ...mapReviewSources(c)];
}

export interface CheckMaterials {
  delta?: import('./delivery-check-delta.js').DeliveryCheckDelta;
  sourceArtifact?: ArtifactSourceMetadata;
  requirements: AcceptanceCriterion[];
  candidate: { revision: string; text: string };
  artifacts: { id: string; name: string; content: string; background?: boolean }[];
  evidence: DeliveryEvidenceSource[];
  references?: CheckReferenceSource[];
  reviewRecords?: CheckReviewSource[];
  rawInputs: { id: string; text: string }[];
  previousResults: CriterionJudgment[];
  revisionNotes?: string;
  verification?: { id: string; stdout?: string; stderr?: string; workspaceRevision: string };
  retryDiagnostic?: CheckDiagnostic;
}

export function checkCitationSources({ evidence, references, reviewRecords, verification, rawInputs }: Pick<CheckMaterials, 'evidence' | 'references' | 'reviewRecords' | 'verification'> & Partial<Pick<CheckMaterials, 'rawInputs'>>) {
  return [...evidence, ...(references ?? []), ...(reviewRecords ?? []), ...(verification ? [verification] : []),
    ...(rawInputs ?? []).map(({ id, text }) => ({ id, content: text }))];
}

// Historical snapshot and presentation contracts. New check work never reads coverage or assessments.
export type DeliveryReference = { kind: 'candidateText' } | { kind: 'draft'; index: number } | { kind: 'artifact' | 'evidence'; id: string };
export type DeliveryGapKind = 'missing_evidence' | 'missing_source' | 'refresh_required' | 'version_conflict' | 'content_error' | 'missing_requirement';
export type DeliveryGap = { criterionId: string | null; candidateRevision: string; kind: DeliveryGapKind; reason: string; refs: DeliveryReference[] };
export type DeliveryAssessment = { candidateRevision: string; judgments: { criterionId: string; status: 'passed' | 'gap' | 'unknown' }[]; gaps: DeliveryGap[] };

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
export const deliveryRevision = (c: TaskContext, e: Delivery) => `${c.taskId}:candidate:${e.id}`;

type AddCriterion = (text: string, source: CriterionSource, key: string) => void;
export const sourceRevisionRequirement = '根据固定来源原文完成本轮修改，保留未被用户要求更改的内容，并交付本任务新生成的非空 Markdown 文档。';

function addInputCriteria(add: AddCriterion, input: InputAnalysis, initial: InputAnalysis | undefined) {
  const source: CriterionSource = { kind: 'input', id: input.id };
  const key = `input:${input.id}`;
  if (input !== initial) add(input.spec?.objective ?? input.rawText, source, `${key}:objective`);
  if (!input.spec) return;
  input.spec.constraints.forEach((text, i) => add(text, source, `${key}:constraint:${i}`));
  input.spec.expectedOutputs.forEach((text, i) => add(text, source, `${key}:output:${i}`));
  input.spec.acceptanceCriteria.forEach((text, i) => add(text, source, `${key}:criterion:${i}`));
}

export function acceptanceCriteria(c: TaskContext): AcceptanceCriterion[] {
  const criteria = new Map<string, AcceptanceCriterion>();
  const inputs = (c.inputAnalyses ?? []).filter(input => input.goalVersion === c.goalVersion && input.status === 'resolved' && input.action !== 'review');
  const initial = inputs.find(input => input.action === 'request');
  const goalSource: CriterionSource = { kind: 'goal', id: initial?.id ?? c.messages[0]?.id ?? c.taskId };
  const add: AddCriterion = (text, source, key) => {
    const normalized = text.trim();
    if (!normalized) return;
    const current = criteria.get(normalized);
    if (current) {
      if (!current.sources.some(item => item.kind === source.kind && item.id === source.id)) current.sources.push(source);
    } else {
      const id = `G${c.goalVersion}:${key}`;
      criteria.set(normalized, { id, text: normalized, goalVersion: c.goalVersion, sources: [source] });
    }
  };
  const objective = initial?.spec?.objective;
  add(initial && c.goal.text.trim() === initial.rawText.trim() && objective ? objective : c.goal.text, goalSource, 'goal:text');
  c.goal.constraints.forEach((text, i) => add(text, goalSource, `goal:constraint:${i}`));
  c.goal.criteria.forEach((text, i) => add(text, goalSource, `goal:criterion:${i}`));
  if (c.sourceArtifact) add(sourceRevisionRequirement, goalSource, 'goal:source-revision');
  for (const input of inputs) addInputCriteria(add, input, initial);
  return [...criteria.values()];
}

const nonempty = z.string().refine(value => !!value.trim());
const judgmentFields = {
  criterionId: nonempty,
  source: z.strictObject({ id: nonempty, quote: nonempty.max(400) }).optional(),
};
const judgmentsSchema = z.array(z.discriminatedUnion('status', [
  z.strictObject({ ...judgmentFields, status: z.literal('passed'), reason: nonempty.optional() }),
  z.strictObject({ ...judgmentFields, status: z.enum(['failed', 'unverified']), reason: nonempty }),
]));

export function validCriterionJudgments(value: unknown): value is CriterionJudgment[] {
  return judgmentsSchema.safeParse(value).success;
}

export function judgmentsProblem(criteria: readonly AcceptanceCriterion[], results: unknown,
  sources: readonly { id: string; stdout?: string; stderr?: string; content?: string }[]): string | null {
  return judgmentsDiagnostic(criteria, results, sources)?.code ?? null;
}

type CitationSource = { id: string; stdout?: string; stderr?: string; content?: string };

function quoteLocation(source: CitationSource, quote: string): CheckDiagnostic['location'] {
  let best: CheckDiagnostic['location'];
  for (const field of ['stdout', 'stderr', 'content'] as const) {
    const text = source[field];
    if (text === undefined) continue;
    let low = 0, high = quote.length;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      if (text.includes(quote.slice(0, length))) low = length;
      else high = length - 1;
    }
    if (!best || low > best.matchedPrefixLength)
      best = { field, offset: low ? text.indexOf(quote.slice(0, low)) : 0, matchedPrefixLength: low };
  }
  return best;
}

export function judgmentsDiagnostic(criteria: readonly AcceptanceCriterion[], results: unknown,
  sources: readonly CitationSource[]): CheckDiagnostic | null {
  if (!validCriterionJudgments(results)) return { code: 'CHECK_INVALID_CRITERIA_RESULTS' };
  const remaining = new Set(criteria.map(item => item.id));
  for (const item of results) {
    if (!remaining.delete(item.criterionId)) return { code: 'CHECK_UNKNOWN_OR_DUPLICATE_CRITERION' };
    const criterion = criteria.find(criterion => criterion.id === item.criterionId)!;
    if (item.status === 'passed' && criterion.requiredSourceIds?.length
      && (!item.source || !criterion.requiredSourceIds.includes(item.source.id)))
      return { code: 'CHECK_RECOVERY_SOURCE_REQUIRED', criterionId: item.criterionId };
    if (item.source) {
      const { id, quote } = item.source;
      const source = sources.find(entry => entry.id === id);
      if (!source) return { code: 'CHECK_SOURCE_NOT_FOUND', criterionId: item.criterionId };
      if (!source.stdout?.includes(quote) && !source.stderr?.includes(quote) && !source.content?.includes(quote)) {
        const location = quoteLocation(source, quote);
        return { code: 'CHECK_SOURCE_QUOTE_MISMATCH', criterionId: item.criterionId, sourceId: source.id,
          quoteLength: quote.length, ...(location ? { location } : {}) };
      }
    }
  }
  return remaining.size ? { code: 'CHECK_MISSING_CRITERION' } : null;
}

const gap = (candidateRevision: string, kind: DeliveryGapKind, reason: string, criterionId: string | null = null, refs: DeliveryReference[] = []): DeliveryGap =>
  ({ candidateRevision, criterionId, kind, reason, refs });

export function deliveryPreflight(c: TaskContext, e: Delivery) {
  const revision = deliveryRevision(c, e);
  const drafts = e.artifacts?.length ? e.artifacts : !c.sourceArtifact && isLongResult(e.text) ? [{ name: 'result.md', content: e.text }] : [];
  const listed = [...new Set(e.artifactIds)];
  const gaps: DeliveryGap[] = [];
  for (const requirement of missingResourceAcquisitions(c)) gaps.push(gap(revision, 'missing_evidence',
    `RESOURCE_ACQUISITION_UNVERIFIED:${JSON.stringify(requirement.resource)}`));
  const available = listed.filter(id => c.artifacts.some(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion && !!artifact.content.trim()));
  if (available.length + drafts.filter(draft => !!draft.content.trim()).length < c.goal.requiredArtifacts)
    gaps.push(gap(revision, 'missing_requirement', 'MISSING_ARTIFACTS'));
  for (const id of listed) {
    if (!available.includes(id)) gaps.push(gap(revision, 'version_conflict', 'MISSING_OR_STALE_ARTIFACT', null, [{ kind: 'artifact', id }]));
  }
  if (c.sourceArtifact && ![
    ...drafts,
    ...c.artifacts.filter(artifact => available.includes(artifact.id) && artifact.id !== c.sourceArtifact!.artifactId),
  ].some(isMarkdownRevision)) gaps.push(gap(revision, 'missing_requirement', 'MISSING_MARKDOWN_REVISION'));
  return { gaps, acceptance: { revision, criteria: [...acceptanceCriteria(c), ...mapRecoveryCriteria(c, e.partitionRecoveries)] } satisfies DeliveryAcceptance };
}

export function isMarkdownRevision(artifact: { name: string; content: string }): boolean {
  return /\.(?:md|markdown)$/i.test(artifact.name) && !!artifact.content.trim();
}

export function deliveryJudgments(c: TaskContext, revision: string | undefined): readonly CriterionJudgment[] {
  if (!revision) return [];
  return c.intents.find(work => work.kind === 'check' && work.criteriaResults
    && (work.payload.candidate as Candidate | undefined)?.revision === revision)?.criteriaResults ?? [];
}

function unverifiedRequirements(candidate: Candidate, revision: string) {
  return (candidate.acceptance?.criteria ?? []).map(criterion => gap(revision, 'missing_evidence', `未核实：${criterion.text}`, criterion.id));
}

export function currentDeliveryIssues(c: TaskContext): DeliveryGap[] {
  const candidate = c.candidate;
  if (!c.deliveryCycle || !candidate?.revision) return c.deliveryGaps ?? [];
  const revision = candidate.revision;
  const judgments = deliveryJudgments(c, revision);
  const issues = judgments.flatMap(item => item.status === 'passed' ? [] : [gap(revision,
    item.status === 'unverified' ? 'missing_evidence' : 'content_error', item.reason, item.criterionId,
    item.source ? [{ kind: 'evidence', id: item.source.id }] : [])]);
  if (candidate.deliveryIssue) {
    const { code, detail } = candidate.deliveryIssue;
    const kind = code === 'MISSING_ARTIFACTS' ? 'missing_requirement' : code.includes('ARTIFACT') ? 'version_conflict' : 'missing_evidence';
    issues.push(gap(revision, kind, detail ?? code));
    if (c.outcome && kind === 'missing_evidence' && !judgments.length) issues.push(...unverifiedRequirements(candidate, revision));
  }
  return issues;
}
