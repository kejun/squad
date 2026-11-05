import { z } from 'zod';
import { isLongResult } from './presentation.js';
import type { DeliveryEvidenceSource } from './task/evidence.js';
import type { Candidate, InputAnalysis, InputReference, TaskContext, TaskEvent } from './types.js';

export type CriterionSource = { kind: 'goal' | 'input'; id: string };
export type AcceptanceCriterion = { id: string; text: string; goalVersion: number; sources: CriterionSource[] };
export type CriterionJudgment = { criterionId: string; source?: { id: string; quote: string } } & (
  | { status: 'passed'; reason?: string }
  | { status: 'failed' | 'unverified'; reason: string }
);
export type DeliveryAcceptance = { revision: string; criteria: AcceptanceCriterion[] };
export type CheckReferenceSource = { id: string; taskId: string; kind: InputReference['kind']; content: string };
export interface CheckMaterials {
  requirements: AcceptanceCriterion[];
  candidate: { revision: string; text: string };
  artifacts: { id: string; name: string; content: string; background?: boolean }[];
  evidence: DeliveryEvidenceSource[];
  references?: CheckReferenceSource[];
  rawInputs: { id: string; text: string }[];
  previousResults: CriterionJudgment[];
  revisionNotes?: string;
  verification?: { id: string; stdout?: string; stderr?: string; workspaceRevision: string };
}

export function checkCitationSources({ evidence, references, verification }: Pick<CheckMaterials, 'evidence' | 'references' | 'verification'>) {
  return [...evidence, ...(references ?? []), ...(verification ? [verification] : [])];
}

// Historical snapshot and presentation contracts. New check work never reads coverage or assessments.
export type DeliveryReference = { kind: 'candidateText' } | { kind: 'draft'; index: number } | { kind: 'artifact' | 'evidence'; id: string };
export type DeliveryGapKind = 'missing_evidence' | 'missing_source' | 'refresh_required' | 'version_conflict' | 'content_error' | 'missing_requirement';
export type DeliveryGap = { criterionId: string | null; candidateRevision: string; kind: DeliveryGapKind; reason: string; refs: DeliveryReference[] };
export type DeliveryAssessment = { candidateRevision: string; judgments: { criterionId: string; status: 'passed' | 'gap' | 'unknown' }[]; gaps: DeliveryGap[] };

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
export const deliveryRevision = (c: TaskContext, e: Delivery) => `${c.taskId}:candidate:${e.id}`;

type AddCriterion = (text: string, source: CriterionSource, key: string) => void;

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
  if (!validCriterionJudgments(results)) return 'CHECK_INVALID_CRITERIA_RESULTS';
  const remaining = new Set(criteria.map(item => item.id));
  for (const item of results) {
    if (!remaining.delete(item.criterionId)) return 'CHECK_UNKNOWN_OR_DUPLICATE_CRITERION';
    if (item.source) {
      const { id, quote } = item.source;
      const source = sources.find(entry => entry.id === id);
      if (!source || !source.stdout?.includes(quote) && !source.stderr?.includes(quote) && !source.content?.includes(quote)) return 'CHECK_INVALID_SOURCE_QUOTE';
    }
  }
  return remaining.size ? 'CHECK_MISSING_CRITERION' : null;
}

const gap = (candidateRevision: string, kind: DeliveryGapKind, reason: string, criterionId: string | null = null, refs: DeliveryReference[] = []): DeliveryGap =>
  ({ candidateRevision, criterionId, kind, reason, refs });

export function deliveryPreflight(c: TaskContext, e: Delivery) {
  const revision = deliveryRevision(c, e);
  const drafts = e.artifacts?.length ? e.artifacts : isLongResult(e.text) ? [{ name: 'result.md', content: e.text }] : [];
  const listed = [...new Set(e.artifactIds)];
  const gaps: DeliveryGap[] = [];
  const available = listed.filter(id => c.artifacts.some(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion && !!artifact.content.trim()));
  if (available.length + drafts.filter(draft => !!draft.content.trim()).length < c.goal.requiredArtifacts)
    gaps.push(gap(revision, 'missing_requirement', 'MISSING_ARTIFACTS'));
  for (const id of listed) {
    if (!available.includes(id)) gaps.push(gap(revision, 'version_conflict', 'MISSING_OR_STALE_ARTIFACT', null, [{ kind: 'artifact', id }]));
  }
  return { gaps, acceptance: { revision, criteria: acceptanceCriteria(c) } satisfies DeliveryAcceptance };
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
