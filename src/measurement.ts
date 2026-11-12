import { createHash, randomUUID } from 'node:crypto';
import { currentDeliveryIssues, deliveryJudgments, type DeliveryGap, type DeliveryGapKind } from './delivery-acceptance.js';
import { modelSignature } from './model-config.js';
import type { Candidate, Intent, TaskContext, TaskEvent, TeamConfig } from './types.js';

export const initialModelRequestId = '__initial_reserved_request__';

export type ModelOutputField = 'text' | 'artifactIds' | 'backgroundArtifactIds' | 'summary' | 'artifacts' | 'status';

type Usage = { input: number | null; output: number | null; total: number | null };
export type ModelObservation = { requestId: string } & (
  | { phase: 'model.transport'; serviceId: string; model: string }
  | { phase: 'model.response'; status: number; providerRequestId: string | null }
  | { phase: 'model.responseBody'; durationMs: number }
  | { phase: 'model.interrupted' | 'model.transportFailed'; durationMs: number }
  | { phase: 'model.usage'; usage: Usage }
  | { phase: 'model.protocol'; valid: boolean; terminal?: boolean; code?: string; invalidFields?: ModelOutputField[] }
);

export type LocalObservation = { operationId: string; action: string; sessionId?: string; retryRequestId?: string; batchId?: string } & (
  | { phase: 'local.saved' | 'local.claimed' | 'local.prepareStarted' | 'local.prepareFinished'
    | 'local.startAuthorized' | 'local.processStarted' | 'local.processFinished' }
  | { phase: 'local.receiptRead'; readKind?: 'evidencePage' | 'artifactPage' | 'receiptReplay'; sourceOperationId?: string }
  | { phase: 'local.retryQueued'; retryRequestId: string; sourceOperationId: string }
  | { phase: 'local.approvalRequired'; approvalId: string; sessionApproved: boolean }
  | { phase: 'local.approvalDecision'; approvalId: string; decisionId: string; decision: 'approve' | 'approveSession' | 'deny' }
  | { phase: 'local.result'; committed: boolean; settled: boolean; effectsKnown: boolean; code: string; ok?: boolean }
);

type MeasurementGap = { criterionId: string | null; kind: DeliveryGapKind };
type MeasurementJudgment = { criterionId: string; status: 'passed' | 'gap' | 'unknown' };
type DeliveryObservation = { candidateRevision: string } & (
  | { phase: 'delivery.submitted' | 'delivery.published' }
  | { phase: 'delivery.preflightRejected'; gaps: MeasurementGap[] }
  | { phase: 'delivery.checked'; passed: boolean; gaps: MeasurementGap[]; judgments: MeasurementJudgment[] }
);

export type ExecutionObservation = ModelObservation | LocalObservation | DeliveryObservation
  | { phase: 'budget.authorized'; requestId: string; category: 'model' | 'externalTool' | 'web_search' | 'web_fetch' | 'findSkills' }
  | { phase: 'work.started'; kind: string; candidateRevision?: string }
  | { phase: 'work.result'; eventId: string; eventType: string; accepted: boolean; code: string; requestId: string | null };

export interface MeasurementContext {
  roomId: string;
  taskId: string;
  workId: string;
  agentId: string;
  attempt: number;
  epoch: number;
  goalVersion: number;
}

export interface MeasurementIdentity { commit?: string; dirty?: boolean; dataset?: string }

export interface MeasurementRun {
  runId: string;
  commit: string | null;
  dirty: boolean | null;
  executionVersion: string;
  toolVersion: string;
  measurementVersion: 1;
  configDigest: string;
  dataset: string | null;
  timezone: 'UTC';
}

export interface MeasurementRecord extends MeasurementContext {
  run: MeasurementRun;
  at: number;
  monotonicMs: number;
  observation: ExecutionObservation;
}

export type MeasurementSink = (context: MeasurementContext, observation: ExecutionObservation) => void;

export function measurementRun(config: TeamConfig, identity: MeasurementIdentity = {}): MeasurementRun {
  return {
    runId: randomUUID(), commit: identity.commit && /^[a-f0-9]{40}$/.test(identity.commit) ? identity.commit : null,
    dirty: identity.dirty ?? null, executionVersion: config.version, toolVersion: config.toolVersion, measurementVersion: 1,
    configDigest: createHash('sha256').update(modelSignature(config)).digest('hex'),
    dataset: identity.dataset && /^[a-zA-Z0-9._-]{1,100}$/.test(identity.dataset) ? identity.dataset : null, timezone: 'UTC',
  };
}

export function publishObservation<T>(observer: ((observation: T) => void) | undefined, observation: T): void {
  try { observer?.(observation); } catch { /* Observation does not own execution or retries. */ }
}

const gapMetadata = (candidate: Candidate, gaps: DeliveryGap[]) => gaps
  .filter(gap => gap.candidateRevision === candidate.revision)
  .map(gap => ({ kind: gap.kind,
    criterionId: candidate.acceptance?.criteria.some(item => item.id === gap.criterionId) ? gap.criterionId : null }));

/** Only describe the change visible in the committed business snapshots. */
export function deliveryObservations(before: TaskContext, after: TaskContext, event: TaskEvent, work: Intent): DeliveryObservation[] {
  const events: DeliveryObservation[] = [];
  const candidate = after.candidate;
  if (event.type === 'DELIVER' && candidate?.revision && candidate.workId === work.id && candidate.revision !== before.candidate?.revision) {
    events.push({ phase: 'delivery.submitted', candidateRevision: candidate.revision });
    const gaps = gapMetadata(candidate, currentDeliveryIssues(after));
    if (gaps.length) events.push({ phase: 'delivery.preflightRejected', candidateRevision: candidate.revision, gaps });
  }
  if (event.type === 'CHECK_RESULT' && !before.consumedResults.includes(event.resultId) && after.consumedResults.includes(event.resultId)) {
    const checked = work.payload.candidate as Candidate | undefined;
    if (checked?.revision && candidate?.revision === checked.revision) {
      const judgments: MeasurementJudgment[] = deliveryJudgments(after, checked.revision).map(({ criterionId, status }) => ({ criterionId,
        status: status === 'passed' ? 'passed' : status === 'failed' ? 'gap' : 'unknown' }));
      const gaps = gapMetadata(checked, currentDeliveryIssues(after));
      const passed = after.outcome === 'complete' && after.publishedDelivery?.revision === checked.revision;
      events.push({ phase: 'delivery.checked', candidateRevision: checked.revision, passed, gaps, judgments });
    }
  }
  const publication = after.publishedDelivery;
  if (publication?.revision && publication.at === event.at && (publication.revision !== before.publishedDelivery?.revision
    || publication.at !== before.publishedDelivery?.at)) {
    events.push({ phase: 'delivery.published', candidateRevision: publication.revision });
  }
  return events;
}

export function providerUsage(data: unknown): Usage {
  const usage = data && typeof data === 'object' ? (data as Record<string, unknown>).usage : undefined;
  const fields = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { input: count(fields.prompt_tokens), output: count(fields.completion_tokens), total: count(fields.total_tokens) };
}

type Interval = readonly [start: number, end: number];

export function coveredDuration(intervals: readonly Interval[]): number {
  const ordered = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of ordered) {
    covered += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(end, previousEnd);
  }
  return covered;
}
