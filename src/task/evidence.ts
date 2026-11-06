import { createHash } from 'node:crypto';
import type { LocalOperation } from '../local-operation.js';
import { localEnabled, type Intent, type TaskContext } from '../types.js';

export type EvidenceStream = 'stdout' | 'stderr';

interface EvidenceSource {
  work: Intent;
  operation: LocalOperation;
}

export interface CapturedEvidenceStream {
  capturedContentHash: string;
  bytes: number;
  chars: number;
}

function settledSources(c: TaskContext, includeResources = false): EvidenceSource[] {
  return c.intents.flatMap(work => work.goalVersion === c.goalVersion
    ? (work.localOperations ?? []).flatMap(operation =>
      (operation.action.type === 'runCli' || includeResources && operation.action.type === 'readSkillResource')
        && (operation.status === 'succeeded' || operation.status === 'failed') && operation.result
        ? [{ work, operation }] : [])
    : []);
}

/** Project a saved resource page without rereading the filesystem or changing its receipt. */
function capturedData(operation: LocalOperation): Record<string, unknown> {
  const data = operation.result!.data;
  if (operation.action.type !== 'readSkillResource' || typeof data.content !== 'string') return data;
  const content = data.content;
  return { ...data, stdout: content,
    truncated: (operation.action.offset ?? 0) !== 0 || data.nextOffset !== null,
    capturedEvidence: { stdout: { capturedContentHash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content), chars: Array.from(content).length } } };
}

function canSeeEvidence(c: TaskContext, work: Intent, id: string): boolean {
  if (work.goalVersion !== c.goalVersion || work.epoch !== c.epoch) return false;
  if (work.kind === 'assistance') return work.evidenceRefs?.includes(id) ?? false;
  return work.kind === 'owner' || work.kind === 'facilitator' || work.kind === 'check';
}

export function assignedEvidenceRefs(c: TaskContext, refs: readonly unknown[]): string[] {
  const requested = new Set(refs);
  return settledSources(c).filter(source => requested.has(source.operation.id)).map(source => source.operation.id);
}

export function evidenceSource(c: TaskContext, work: Intent, id: string): EvidenceSource | undefined {
  if (!canSeeEvidence(c, work, id)) return undefined;
  return settledSources(c).find(source => source.operation.id === id);
}

function capturedStream(result: Record<string, unknown>, stream: EvidenceStream): CapturedEvidenceStream | null {
  const streams = result.capturedEvidence;
  if (!streams || typeof streams !== 'object') return null;
  const value = (streams as Partial<Record<EvidenceStream, CapturedEvidenceStream>>)[stream];
  return value && /^[a-f0-9]{64}$/.test(value.capturedContentHash) && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && Number.isSafeInteger(value.chars) && value.chars >= 0 ? value : null;
}

export function evidenceMetadata(c: TaskContext, source: EvidenceSource) {
  const { work, operation } = source;
  const data = capturedData(operation);
  const resource = operation.action.type === 'readSkillResource' ? operation.action : null;
  const sourceStatus = operation.status === 'succeeded' ? 'succeeded' : 'failed';
  const stdout = capturedStream(data, 'stdout'), stderr = capturedStream(data, 'stderr');
  const completeness = sourceStatus === 'failed' ? 'failed' : typeof data.stdout !== 'string' ? 'missing'
    : data.truncated === true ? 'truncated' : data.truncated === false ? 'complete' : 'unknown';
  return {
    evidenceId: operation.id, taskId: c.taskId, goalVersion: work.goalVersion, sourceWorkId: work.id,
    sourceOperationId: operation.id, epoch: work.epoch, sourceRole: work.kind, sourceMember: work.target,
    historicalObservation: work.epoch !== c.epoch, status: sourceStatus, completeness,
    command: { type: operation.action.type, requestHash: operation.requestHash },
    execution: operation.action.type === 'runCli' ? operation.action.execution ?? 'sandbox' : null,
    workspaceId: operation.workspaceId ?? null, workspaceRevision: operation.workspaceRevision ?? null,
    exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
    startedAt: operation.startedAt ?? null, finishedAt: operation.finishedAt ?? null, obtainedAt: operation.finishedAt ?? null,
    sessionId: operation.sessionId ?? null, logId: typeof data.logId === 'string' ? data.logId : null,
    logBytes: typeof data.logBytes === 'number' ? data.logBytes : null,
    capturedContentHash: stdout?.capturedContentHash ?? null, stdoutBytes: stdout?.bytes ?? null, stdoutChars: stdout?.chars ?? null,
    stderrContentHash: stderr?.capturedContentHash ?? null, stderrBytes: stderr?.bytes ?? null, stderrChars: stderr?.chars ?? null,
    resourceId: resource ? `${resource.skillId}:${resource.path}` : null,
    resourceVersion: resource && typeof data.skillVersion === 'string' ? data.skillVersion : null, sourceUpdatedAt: null,
  };
}

export function evidenceIndex(c: TaskContext, work: Intent) {
  return settledSources(c).filter(source => canSeeEvidence(c, work, source.operation.id)).map(source => evidenceMetadata(c, source));
}

export interface DeliveryEvidenceRef { id: string; stdoutHash: string | null; stderrHash: string | null }
export interface DeliveryEvidenceSource {
  id: string;
  metadata: ReturnType<typeof evidenceMetadata>;
  stdout?: string;
  stderr?: string;
}

function completeCapturedText(metadata: DeliveryEvidenceSource['metadata'], hash: string | null, text: unknown) {
  return metadata.completeness === 'complete' && hash && typeof text === 'string' ? text : undefined;
}

/** Bind to the exact saved receipt and its captured content, without opening a process or log. */
export function deliveryEvidence(c: TaskContext, work: Intent, refs?: readonly DeliveryEvidenceRef[]) {
  const available = localEnabled(c.config, work.target) ? settledSources(c, true).filter(source => canSeeEvidence(c, work, source.operation.id)
    && source.work.kind !== 'check') : [];
  const byId = new Map(available.map(source => [source.operation.id, source]));
  const sources: DeliveryEvidenceSource[] = [];
  const savedRefs: DeliveryEvidenceRef[] = [];
  for (const id of refs?.map(item => item.id) ?? byId.keys()) {
    const source = byId.get(id);
    if (!source) return undefined;
    const metadata = evidenceMetadata(c, source);
    const data = capturedData(source.operation);
    const saved = { id, stdoutHash: metadata.capturedContentHash, stderrHash: metadata.stderrContentHash };
    const expected = refs?.[savedRefs.length];
    if (expected && (expected.stdoutHash !== saved.stdoutHash || expected.stderrHash !== saved.stderrHash)) return undefined;
    const stdout = completeCapturedText(metadata, saved.stdoutHash, data.stdout);
    const stderr = completeCapturedText(metadata, saved.stderrHash, data.stderr);
    sources.push({ id, metadata, ...(stdout === undefined ? {} : { stdout }), ...(stderr === undefined ? {} : { stderr }) });
    savedRefs.push(saved);
  }
  return { sources, refs: savedRefs };
}
