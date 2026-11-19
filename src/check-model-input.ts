import type { CheckMaterials } from './delivery-acceptance.js';
import { savedPage } from './evidence-reader.js';
import type { LocalToolResult } from './local-operation.js';

type CheckSourceRead = { sourceId: string; stream?: 'content' | 'stdout' | 'stderr'; cursor?: string };
export const checkSourceFields = ['sourceId', 'stream', 'cursor'] as const;

export function checkModelInput(materials: CheckMaterials) {
  const { requirements, candidate, artifacts, rawInputs, evidence, references, reviewRecords, verification,
    sourceArtifact, missingResources, retryDiagnostic } = materials;
  const sourceIndex = [
    ...evidence.map(({ id, metadata }) => ({ id, kind: metadata?.command?.type ?? 'evidence',
      resourceId: metadata?.resourceId, completeness: metadata?.completeness,
      ...(metadata?.acquisitions?.length ? { acquisitionIds: metadata.acquisitions.map(item => item.id) } : {}) })),
    ...(references ?? []).map(({ id, kind, unavailable }) => ({ id, kind, ...(unavailable ? { unavailable } : {}) })),
    ...(reviewRecords ?? []).map(({ id }) => ({ id, kind: 'review' })),
    ...artifacts.filter(item => item.background).map(({ id, name }) => ({ id, kind: 'backgroundArtifact', name })),
    ...(verification ? [{ id: verification.id, kind: 'verification', status: verification.status, code: verification.code }] : []),
  ];
  return { requirements, candidate, artifacts: artifacts.filter(item => !item.background), rawInputs, sourceIndex,
    ...(sourceArtifact ? { sourceArtifact } : {}), ...(missingResources?.length ? { missingResources } : {}),
    ...(retryDiagnostic ? { retryDiagnostic } : {}) };
}

export function checkSourceReadProblem(value: Record<string, unknown>): string | undefined {
  if (Object.keys(value).some(key => !['type', ...checkSourceFields].includes(key))) return 'additionalProperties';
  if (typeof value.sourceId !== 'string' || !value.sourceId.trim() || value.sourceId.length > 4096 || value.sourceId.includes('\0')) return 'sourceId';
  if (value.stream !== undefined && value.stream !== 'content' && value.stream !== 'stdout' && value.stream !== 'stderr') return 'stream';
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || !/^[a-f0-9]{64}:[1-9][0-9]{0,14}$/.test(value.cursor))) return 'cursor';
  return undefined;
}

export function validCheckSourceRead(value: Record<string, unknown>): value is Record<string, unknown> & CheckSourceRead {
  return checkSourceReadProblem(value) === undefined;
}

/** Pages are selected from the already bound materials, independent of live filesystem and web privileges. */
export function readCheckSource(materials: CheckMaterials, { sourceId, stream, cursor }: CheckSourceRead): LocalToolResult {
  const { evidence, references, reviewRecords, artifacts, verification, candidate } = materials;
  const receipt = evidence.find(item => item.id === sourceId || item.metadata?.acquisitions?.some(acquisition => acquisition.id === sourceId));
  const reference = references?.find(item => item.id === sourceId && !item.unavailable);
  const review = reviewRecords?.find(item => item.id === sourceId);
  const background = artifacts.find(item => item.id === sourceId && item.background);
  const verified = verification?.id === sourceId ? verification : undefined;
  const selectedStream = stream ?? (receipt || verified ? 'stdout' : 'content');
  const text = selectedStream === 'content' ? reference?.content ?? review?.content ?? background?.content
    : receipt?.[selectedStream] ?? verified?.[selectedStream] ?? (selectedStream === 'stdout' ? review?.stdout : undefined);
  const { stdout: _stdout, stderr: _stderr, ...verificationMetadata } = verified ?? {};
  const metadata = { sourceId, stream: selectedStream, ...(receipt ? { evidence: receipt.metadata } : {}),
    ...(verified ? { verification: verificationMetadata } : {}) };
  return text === undefined ? { ok: false, code: 'CHECK_SOURCE_UNAVAILABLE', data: metadata }
    : savedPage(text, [candidate.revision, sourceId, selectedStream], cursor, 'CHECK_SOURCE', metadata);
}
