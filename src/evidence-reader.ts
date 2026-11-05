import { createHash } from 'node:crypto';
import type { LocalAction, LocalToolResult } from './local-operation.js';
import { artifactForWork, documentIdentity } from './task/delivery.js';
import { evidenceMetadata, evidenceSource, type CapturedEvidenceStream } from './task/evidence.js';
import type { Intent, TaskContext } from './types.js';

const pageSize = 4000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function capturedStream(value: unknown): CapturedEvidenceStream | undefined {
  if (typeof value !== 'string') return undefined;
  return { capturedContentHash: sha256(value), bytes: Buffer.byteLength(value, 'utf8'), chars: Array.from(value).length };
}

/** Measure only the redacted, bounded text that the runtime will persist in this receipt. */
export function attachCapturedEvidence(result: LocalToolResult): LocalToolResult {
  const stdout = capturedStream(result.data.stdout);
  const stderr = capturedStream(result.data.stderr);
  if (!stdout && !stderr) return result;
  return { ...result, data: { ...result.data, capturedEvidence: { stdout, stderr } } };
}

/** Called only after the persisted read intent is claimed. Never opens logs or runs a command. */
export function readSavedEvidence(c: TaskContext, work: Intent, action: Extract<LocalAction, { type: 'readEvidence' }>): LocalToolResult {
  const source = evidenceSource(c, work, action.sourceOperationId);
  if (!source) return { ok: false, code: 'EVIDENCE_UNAVAILABLE', data: {} };
  const evidence = evidenceMetadata(c, source);
  if (evidence.status === 'failed') return { ok: false, code: 'EVIDENCE_SOURCE_FAILED', data: { evidence, failureCode: source.operation.result!.code } };
  const text = source.operation.result!.data[action.stream];
  if (typeof text !== 'string') return { ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: { evidence, stream: action.stream } };
  return savedPage(text, [source.operation.id, action.stream], action.cursor, 'EVIDENCE', { evidence, stream: action.stream });
}

/** A distinct reference namespace prevents artifact IDs from being interpreted as operation IDs. */
export function readSavedArtifact(c: TaskContext, work: Intent, action: Extract<LocalAction, { type: 'readArtifact' }>): LocalToolResult {
  const artifact = artifactForWork(c, work, action.artifactId);
  if (!artifact) return { ok: false, code: 'ARTIFACT_UNAVAILABLE', data: {} };
  return savedPage(artifact.content, ['artifact', artifact.id], action.cursor, 'ARTIFACT', {
    artifact: { artifactId: artifact.id, documentId: documentIdentity(artifact), revision: artifact.revision ?? 1, goalVersion: artifact.goalVersion },
  });
}

function savedPage(text: string, identity: string[], cursor: string | undefined, type: 'EVIDENCE' | 'ARTIFACT', metadata: Record<string, unknown>): LocalToolResult {
  const codepoints = Array.from(text);
  const capturedContentHash = sha256(text);
  const cursorKey = sha256(JSON.stringify([...identity, capturedContentHash]));
  const offset = cursor === undefined ? 0 : Number(cursor.split(':')[1]);
  if (cursor !== undefined && (cursor !== `${cursorKey}:${offset}` || offset >= codepoints.length || offset % pageSize !== 0)) {
    return { ok: false, code: `${type}_CURSOR_INVALID`, data: metadata };
  }
  const end = Math.min(offset + pageSize, codepoints.length);
  const nextCursor = end < codepoints.length ? `${cursorKey}:${end}` : null;
  return { ok: true, code: `${type}_PAGE`, data: {
    ...metadata, capturedContentHash, offset, text: codepoints.slice(offset, end).join(''), nextCursor, atSavedBoundary: nextCursor === null,
  } };
}
