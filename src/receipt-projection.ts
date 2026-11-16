import type { LocalOperation } from './local-operation.js';
import { hostEvidenceReference, type HostAcquisition } from './resource-acquisition.js';

export interface ReceiptSources {
  operations: readonly LocalOperation[];
  acquisitions: readonly HostAcquisition[];
}

const replayTypes = new Set(['local_tool_result', 'web_fetch_result', 'web_search_result', 'skillSearchResults']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function counted(value: unknown): { capturedContentHash: string; bytes: number; chars: number } | undefined {
  const item = record(value);
  if (!item || typeof item.capturedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.capturedContentHash)) return undefined;
  if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || !Number.isSafeInteger(item.chars) || Number(item.chars) < 0) return undefined;
  return { capturedContentHash: item.capturedContentHash, bytes: Number(item.bytes), chars: Number(item.chars) };
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function completeness(operation: LocalOperation): 'failed' | 'missing' | 'truncated' | 'complete' | 'unknown' {
  const result = operation.result!;
  const data = result.data;
  if (!result.ok || operation.status === 'failed') return 'failed';
  const captured = typeof data.stdout === 'string' || typeof data.text === 'string' || typeof data.content === 'string';
  if (!captured) return 'missing';
  if (data.truncated === true) return 'truncated';
  if (operation.action.type === 'readSkillResource')
    return (operation.action.offset ?? 0) === 0 && data.nextOffset === null ? 'complete' : 'truncated';
  if (data.truncated === false || data.atSavedBoundary === true) return 'complete';
  if (data.atSavedBoundary === false || typeof data.nextCursor === 'string') return 'truncated';
  return 'unknown';
}

function localCard(operation: LocalOperation): Record<string, unknown> {
  const result = operation.result!;
  if (['discoverHost', 'listSkills'].includes(operation.action.type) && operation.status === 'succeeded'
    && result.ok && result.code === operation.action.type) {
    return { type: 'local_tool_result', untrusted: true, bodyIncluded: false, operationId: operation.id,
      ok: true, code: result.code, data: { persistedMetadataOperationId: operation.id } };
  }
  const data = result.data;
  const streams = record(data.capturedEvidence);
  const stdout = counted(streams?.stdout);
  const stderr = counted(streams?.stderr);
  const hash = typeof data.capturedContentHash === 'string' && /^[a-f0-9]{64}$/.test(data.capturedContentHash)
    ? data.capturedContentHash : stdout?.capturedContentHash ?? (typeof data.hash === 'string' && /^[a-f0-9]{64}$/.test(data.hash) ? data.hash : undefined);
  const execution = operation.action.type === 'runCli' ? operation.action.execution ?? 'sandbox'
    : data.execution === 'host' || data.execution === 'sandbox' ? data.execution : undefined;
  const offset = typeof data.offset === 'number' ? data.offset
    : operation.action.type === 'readSkillResource' ? operation.action.offset ?? 0 : undefined;
  const page = typeof data.content === 'string' ? data.content : typeof data.text === 'string' && typeof data.stdout !== 'string' ? data.text : undefined;
  return { type: 'local_tool_result', untrusted: true, bodyIncluded: false, operationId: operation.id,
    ok: result.ok, code: result.code, completeness: completeness(operation),
    ...(execution ? { execution } : {}),
    ...(typeof data.exitCode === 'number' ? { exitCode: data.exitCode } : {}),
    ...(typeof data.truncated === 'boolean' ? { truncated: data.truncated } : {}),
    ...(hash ? { capturedContentHash: hash } : {}),
    ...(stdout ? { stdoutBytes: stdout.bytes, stdoutChars: stdout.chars } : {}),
    ...(stderr ? { stderrContentHash: stderr.capturedContentHash, stderrBytes: stderr.bytes, stderrChars: stderr.chars } : {}),
    ...(page ? { chars: Array.from(page).length, bytes: Buffer.byteLength(page) } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(data.nextCursor === null || typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}),
    ...(data.nextOffset === null || typeof data.nextOffset === 'number' ? { nextOffset: data.nextOffset } : {}),
    ...(typeof data.atSavedBoundary === 'boolean' ? { atSavedBoundary: data.atSavedBoundary } : {}),
  };
}

function windowIdentity(receipt: HostAcquisition): { offset?: number; totalChars?: number; nextOffset?: number | null } {
  let offset: number | undefined;
  let totalChars: number | undefined;
  let nextOffset: number | null | undefined;
  try {
    const snap = JSON.parse(receipt.sourceSnapshot) as { input?: { offset?: unknown }; output?: { offset?: unknown; totalChars?: unknown; nextOffset?: unknown }; hostCapture?: { totalChars?: unknown } };
    offset = wholeNumber(snap.output?.offset) ?? wholeNumber(snap.input?.offset);
    totalChars = wholeNumber(snap.hostCapture?.totalChars) ?? wholeNumber(snap.output?.totalChars);
    if (snap.output?.nextOffset === null) nextOffset = null;
    else nextOffset = wholeNumber(snap.output?.nextOffset);
  } catch { /* A receipt without a readable window still projects its hash and status. */ }
  return { ...(offset === undefined ? {} : { offset }), ...(totalChars === undefined ? {} : { totalChars }),
    ...(nextOffset === undefined ? {} : { nextOffset }) };
}

function webCard(message: Record<string, unknown>, sources: ReceiptSources): Record<string, unknown> | undefined {
  const host = record(message.hostEvidence);
  const evidenceId = typeof host?.evidenceId === 'string' ? host.evidenceId : typeof host?.acquisitionId === 'string' ? host.acquisitionId : undefined;
  const receipt = evidenceId ? sources.acquisitions.find(item => item.id === evidenceId && item.source === 'webFetch') : undefined;
  if (!receipt) return undefined;
  return { type: 'web_fetch_result', untrusted: true, bodyIncluded: false, ok: receipt.status === 'acquired', code: 'WEB_FETCH_RESULT',
    hostEvidence: hostEvidenceReference(receipt), status: receipt.status, complete: receipt.complete, contentHash: receipt.contentHash,
    ...windowIdentity(receipt) };
}

function receiptCard(message: Record<string, unknown>, sources: ReceiptSources): Record<string, unknown> | undefined {
  if (message.type === 'web_search_result' || message.type === 'skillSearchResults') return undefined;
  if (message.type === 'web_fetch_result') return webCard(message, sources);
  if (message.type !== 'local_tool_result' || typeof message.operationId !== 'string') return undefined;
  const operation = sources.operations.find(item => item.id === message.operationId);
  if (!operation?.result || !['succeeded', 'failed'].includes(operation.status)) return undefined;
  return localCard(operation);
}

/** Replace settled tool results older than the newest one. Messages without a receipt stay unchanged. */
export function projectModelToolResults<T extends { role: string; content: string }>(messages: readonly T[], sources: ReceiptSources | undefined): T[] {
  if (!sources) return [...messages];
  const parsed = messages.map(message => {
    if (message.role !== 'user') return undefined;
    try { return record(JSON.parse(message.content)); } catch { return undefined; }
  });
  const indexes = parsed.flatMap((value, index) => value && replayTypes.has(String(value.type)) ? [index] : []);
  const latest = indexes.at(-1);
  if (latest === undefined) return [...messages];
  return messages.map((message, index) => {
    if (index === latest || !indexes.includes(index)) return message;
    const card = receiptCard(parsed[index]!, sources);
    return card ? { ...message, content: JSON.stringify(card) } : message;
  });
}
