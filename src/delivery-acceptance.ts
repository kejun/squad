import { createHash } from 'node:crypto';
import { isLongResult } from './presentation.js';
import { documentIdentity } from './task/delivery.js';
import { evidenceMetadata, evidenceSource } from './task/evidence.js';
import type { Intent, TaskContext, TaskEvent } from './types.js';

export type CriterionSource = { kind: 'goal' | 'input'; id: string };
export type AcceptanceCriterion = { id: string; text: string; goalVersion: number; sources: CriterionSource[] };
export type DeliveryReference = { kind: 'candidateText' } | { kind: 'draft'; index: number } | { kind: 'artifact' | 'evidence'; id: string };
export type CriterionCoverage = { criterionId: string; refs: DeliveryReference[] };
const gapKinds = ['missing_evidence', 'missing_source', 'refresh_required', 'version_conflict', 'content_error', 'missing_requirement'] as const;
export type DeliveryGapKind = typeof gapKinds[number];
export type CriterionJudgment = { criterionId: string; status: 'passed' | 'gap' | 'unknown'; reason?: string; kind?: DeliveryGapKind; refs?: DeliveryReference[] };
export type DeliveryGap = { criterionId: string | null; candidateRevision: string; kind: DeliveryGapKind; reason: string; refs: DeliveryReference[] };
export type DeliveryAssessment = { candidateRevision: string; judgments: CriterionJudgment[]; gaps: DeliveryGap[] };
export type DeliveryAcceptance = { revision: string; criteria: AcceptanceCriterion[]; coverage: CriterionCoverage[]; signature: string };

type Delivery = Extract<TaskEvent, { type: 'DELIVER' }>;
type Check = Extract<TaskEvent, { type: 'CHECK_RESULT' }>;
export const deliveryRevision = (c: TaskContext, e: Delivery) => `${c.taskId}:candidate:${e.id}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function acceptanceCriteria(c: TaskContext): AcceptanceCriterion[] {
  const criteria = new Map<string, AcceptanceCriterion>();
  const inputs = (c.inputAnalyses ?? []).filter(input => input.goalVersion === c.goalVersion && input.status === 'resolved');
  const goalSource: CriterionSource = { kind: 'goal', id: inputs[0]?.id ?? c.messages[0]?.id ?? c.taskId };
  const add = (text: string, source: CriterionSource) => {
    const normalized = text.trim();
    if (!normalized) return;
    const current = criteria.get(normalized);
    if (current) {
      if (!current.sources.some(item => item.kind === source.kind && item.id === source.id)) current.sources.push(source);
    } else {
      const id = `G${c.goalVersion}:${digest(normalized).slice(0, 24)}`;
      criteria.set(normalized, { id, text: normalized, goalVersion: c.goalVersion, sources: [source] });
    }
  };
  for (const text of [c.goal.text, ...c.goal.constraints, ...c.goal.criteria]) add(text, goalSource);
  for (const input of inputs) {
    const source: CriterionSource = { kind: 'input', id: input.id };
    add(input.rawText, source);
    if (input.spec) {
      for (const text of [...input.spec.constraints, ...input.spec.expectedOutputs, ...input.spec.acceptanceCriteria]) add(text, source);
    }
  }
  return [...criteria.values()];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const references = (value: unknown): value is DeliveryReference[] => Array.isArray(value) && value.every(ref => record(ref) &&
  (ref.kind === 'candidateText'
    || ref.kind === 'draft' && Number.isSafeInteger(ref.index) && Number(ref.index) >= 0
    || (ref.kind === 'artifact' || ref.kind === 'evidence') && nonempty(ref.id)));

export function validCriterionCoverage(value: unknown): value is CriterionCoverage[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(item => record(item) && nonempty(item.criterionId) && references(item.refs));
}

export function validCriterionJudgments(value: unknown): value is CriterionJudgment[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(item => record(item) && nonempty(item.criterionId)
    && (item.status === 'passed' || (item.status === 'gap' || item.status === 'unknown') && nonempty(item.reason))
    && (item.reason === undefined || nonempty(item.reason)) && (item.refs === undefined || references(item.refs))
    && (item.kind === undefined || gapKinds.includes(item.kind as DeliveryGapKind)));
}

function currentArtifact(c: TaskContext, id: string): boolean {
  return c.artifacts.some(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion && !!artifact.content.trim());
}

function supported(c: TaskContext, work: Intent | undefined, ref: DeliveryReference, draftCount: number, backgroundIds: readonly string[], supersededIds: readonly string[] = []) {
  switch (ref.kind) {
    case 'candidateText': return true;
    case 'draft': return ref.index < draftCount;
    case 'artifact': {
      const artifact = c.artifacts.find(item => item.id === ref.id && item.goalVersion === c.goalVersion && !!item.content.trim());
      if (!artifact) return false;
      if (backgroundIds.includes(ref.id)) return true;
      const newer = c.artifacts.slice(c.artifacts.indexOf(artifact) + 1).some(item =>
        item.goalVersion === c.goalVersion && documentIdentity(item) === documentIdentity(artifact));
      return !newer && !supersededIds.includes(ref.id);
    }
    case 'evidence': {
      const source = work && evidenceSource(c, work, ref.id);
      if (!source || source.operation.result?.ok !== true) return false;
      return evidenceMetadata(c, source).completeness === 'complete';
    }
  }
}

const gap = (candidateRevision: string, kind: DeliveryGapKind, reason: string, criterionId: string | null = null, refs: DeliveryReference[] = []): DeliveryGap =>
  ({ candidateRevision, criterionId, kind, reason, refs });

export function deliveryPreflight(c: TaskContext, e: Delivery) {
  const revision = deliveryRevision(c, e);
  const work = c.intents.find(intent => intent.id === e.workId);
  const coverage = e.coverage ?? (c.candidate?.acceptance ? [] : undefined);
  const draftCount = e.artifacts?.length || Number(isLongResult(e.text));
  const listed = [...new Set(e.artifactIds)];
  const gaps: DeliveryGap[] = [];
  if (listed.length + draftCount < c.goal.requiredArtifacts) gaps.push(gap(revision, 'missing_requirement', 'MISSING_ARTIFACTS'));
  for (const id of listed.filter(id => !currentArtifact(c, id))) {
    gaps.push(gap(revision, 'version_conflict', 'MISSING_OR_STALE_ARTIFACT', null, [{ kind: 'artifact', id }]));
  }
  if (coverage === undefined) return { gaps, repeated: false };
  const criteria = acceptanceCriteria(c);
  const coverageById = new Map<string, CriterionCoverage>();
  const criterionIds = new Set(criteria.map(criterion => criterion.id));
  for (const item of coverage) {
    if (!criterionIds.has(item.criterionId) || coverageById.has(item.criterionId)) {
      gaps.push(gap(revision, 'missing_requirement', '验收项不存在或被重复提交', item.criterionId, item.refs));
    } else {
      coverageById.set(item.criterionId, item);
    }
  }
  for (const criterion of criteria) {
    const refs = coverageById.get(criterion.id)?.refs ?? [];
    if (!refs.length) gaps.push(gap(revision, 'missing_requirement', `缺少覆盖：${criterion.text}`, criterion.id));
    else if (refs.some(ref => !supported(c, work, ref, draftCount, e.backgroundArtifactIds ?? [], e.artifacts?.flatMap(draft => draft.replacesArtifactId ? [draft.replacesArtifactId] : []) ?? []))) gaps.push(gap(revision, 'missing_evidence', `凭证不可用：${criterion.text}`, criterion.id, refs));
  }
  const signature = digest([e.text, listed.slice().sort(), e.artifacts ?? [], criteria.map(criterion => criterion.id),
    [...coverage].sort((a, b) => a.criterionId.localeCompare(b.criterionId)).map(item =>
      [item.criterionId, item.refs.map(ref => JSON.stringify(ref)).sort()])]);
  const repeated = c.candidate?.acceptance?.signature === signature && (c.deliveryGaps?.length ?? 0) > 0;
  if (repeated && !gaps.length) gaps.push(gap(revision, 'content_error', '候选未处理上一轮缺口'));
  return { gaps, repeated, acceptance: { revision, criteria, coverage, signature } satisfies DeliveryAcceptance };
}

export function bindDraftReferences(acceptance: DeliveryAcceptance, ids: string[]): DeliveryAcceptance {
  return { ...acceptance, coverage: acceptance.coverage.map(item => ({
    ...item, refs: item.refs.map(ref => ref.kind === 'draft' && ids[ref.index] ? { kind: 'artifact', id: ids[ref.index]! } : ref),
  })) };
}

export function acceptanceCheckProblem(c: TaskContext, e: Check): string | null {
  const acceptance = c.candidate?.acceptance;
  if (!acceptance) return e.criteriaResults === undefined ? null : 'CHECK_ACCEPTANCE_REQUIRED';
  const work = c.intents.find(item => item.id === e.workId && item.kind === 'check');
  const candidate = work?.payload.candidate as TaskContext['candidate'] | undefined;
  return candidate?.acceptance?.revision === acceptance.revision ? null : 'STALE_ACCEPTANCE_CHECK';
}

export function deliveryCheckGaps(c: TaskContext, e: Check): DeliveryGap[] {
  const acceptance = c.candidate?.acceptance;
  if (!acceptance) return [];
  const work = c.intents.find(intent => intent.id === e.workId);
  const gaps = e.gaps.map(reason => gap(acceptance.revision, 'content_error', reason));
  const judgments = new Map<string, CriterionJudgment>();
  const criterionIds = new Set(acceptance.criteria.map(criterion => criterion.id));
  for (const judgment of e.criteriaResults ?? []) {
    if (!criterionIds.has(judgment.criterionId) || judgments.has(judgment.criterionId)) {
      gaps.push(gap(acceptance.revision, 'missing_requirement', '检查引用了未知或重复的验收项', judgment.criterionId));
    } else {
      judgments.set(judgment.criterionId, judgment);
    }
  }
  for (const criterion of acceptance.criteria) {
    const result = judgments.get(criterion.id);
    if (!result) {
      gaps.push(gap(acceptance.revision, 'missing_requirement', `缺少检查：${criterion.text}`, criterion.id));
    } else {
      const refs = result.refs ?? [];
      if (result.status !== 'passed') gaps.push(gap(acceptance.revision, result.kind ?? 'content_error', result.reason!, criterion.id, refs));
      else if (refs.some(ref => !supported(c, work, ref, 0, c.candidate?.backgroundArtifactIds ?? []))) {
        gaps.push(gap(acceptance.revision, 'missing_evidence', `检查引用不可用：${criterion.text}`, criterion.id, refs));
      }
    }
  }
  if (!e.passed && !gaps.length) gaps.push(gap(acceptance.revision, 'content_error', '独立检查未通过'));
  return gaps;
}
