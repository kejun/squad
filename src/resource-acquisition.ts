import { deliveryVerificationProblem } from './task/verification.js';
import type { LocalOperation } from './local-operation.js';
import type { Artifact, Intent, TaskContext } from './types.js';

export type ResourceIdentity =
  | { kind: 'url'; url: string }
  | { kind: 'document'; service: string; namespace: string; id: string }
  | { kind: 'file'; workspaceId: string; path: string; revision?: string };
export interface ResourceRequirement { resource: ResourceIdentity; freshness: 'current' | 'saved' }
export type AcquisitionStatus = 'acquired' | 'authentication_required' | 'resource_mismatch' | 'empty' | 'incomplete' | 'unknown';
export interface AcquisitionVerifier { id: string; version: string }
export interface HostAcquisition {
  id: string; operationId: string; taskId: string; workId: string; attempt: number; epoch: number; goalVersion: number;
  requestHash: string; source: 'runCli' | 'webFetch'; requestedResource: ResourceIdentity; resource: ResourceIdentity;
  /** Present only when a trusted document parser matched this exact original id/slug. */
  documentId?: string;
  status: AcquisitionStatus; content: string; contentHash: string | null; complete: boolean;
  verifier: AcquisitionVerifier | null; at: number; sourceSnapshot: string;
  /** Frozen by the trusted host, compared as data in the browser-compatible state model. */
  snapshot: string;
  configuration?: { id: string; version: string; authentication: 'satisfied' | 'required' | 'unknown' };
}
export interface AcquisitionEvent { type: 'RECORD_ACQUISITION'; intentId: string; receipt: HostAcquisition }
/** Host tool metadata: the frozen evidence reference differs from a Web request's execution id. */
export interface HostEvidenceReference {
  evidenceId: string; acquisitionId: string; sourceOperationId: string; status: AcquisitionStatus;
}
export function hostEvidenceReference(receipt: HostAcquisition): HostEvidenceReference {
  return { evidenceId: receipt.id, acquisitionId: receipt.id, sourceOperationId: receipt.operationId, status: receipt.status };
}
export type AcquisitionObservationInput = Omit<HostAcquisition, 'status' | 'snapshot' | 'resource' | 'content' | 'contentHash' | 'verifier'> & {
  resource?: ResourceIdentity; content?: string; contentHash?: string | null; verifier?: AcquisitionVerifier | null;
  executionSucceeded: boolean;
};

const identityText = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value === value.trim() && value.length <= 4096 && !/[\r\n\0]/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function resourceIdentity(value: unknown): ResourceIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (r.kind === 'url' && identityText(r.url)) {
    try { const url = new URL(r.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? { kind: 'url', url: url.href } : undefined; } catch { return undefined; }
  }
  if (r.kind === 'document' && identityText(r.service) && identityText(r.namespace) && identityText(r.id))
    return { kind: 'document', service: r.service, namespace: r.namespace, id: r.id };
  if (r.kind === 'file' && identityText(r.workspaceId) && identityText(r.path)
    && (r.revision === undefined || identityText(r.revision)))
    return { kind: 'file', workspaceId: r.workspaceId, path: r.path, ...(r.revision === undefined ? {} : { revision: r.revision }) };
  return undefined;
}

export function sameResourceIdentity(a: ResourceIdentity, b: ResourceIdentity): boolean {
  const left = resourceIdentity(a), right = resourceIdentity(b);
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}

export function operationAcquisitionSnapshot(op: LocalOperation): string {
  return JSON.stringify({ id: op.id, requestHash: op.requestHash, action: op.action,
    parentAttempt: op.parentAttempt, attempt: op.attempt, status: op.status, result: op.result,
    workspaceId: op.workspaceId, workspaceRevision: op.workspaceRevision, sessionId: op.sessionId,
    startedAt: op.startedAt, finishedAt: op.finishedAt, isolated: op.isolated });
}

function receiptSnapshot(receipt: Omit<HostAcquisition, 'snapshot'>): string {
  return JSON.stringify({ id: receipt.id, operationId: receipt.operationId, taskId: receipt.taskId,
    workId: receipt.workId, attempt: receipt.attempt, epoch: receipt.epoch, goalVersion: receipt.goalVersion,
    requestHash: receipt.requestHash, source: receipt.source, requestedResource: resourceIdentity(receipt.requestedResource),
    resource: resourceIdentity(receipt.resource), documentId: receipt.documentId, status: receipt.status, content: receipt.content,
    contentHash: receipt.contentHash, complete: receipt.complete, verifier: receipt.verifier, at: receipt.at,
    sourceSnapshot: receipt.sourceSnapshot, configuration: receipt.configuration });
}

/** Conservative content classification. A host verifier still owns resource matching. */
export function authenticationPage(content: string): boolean {
  return /<(?:title|h1)[^>]*>\s*(?:log\s*in|sign\s*in|登录|登入)(?:\s|<|[-|])/i.test(content)
    || /<input[^>]+type\s*=\s*["']?password/i.test(content)
    || /^\s*(?:#\s*)?(?:authentication required|login required|please (?:log|sign) in|请先登录|需要登录)(?:\b|[，。！!\s])/i.test(content);
}

function observedStatus(input: AcquisitionObservationInput, content: string): AcquisitionStatus {
  if (input.configuration?.authentication === 'required' || authenticationPage(content)) return 'authentication_required';
  if (!input.executionSucceeded || !input.verifier || !identityText(input.verifier.id) || !identityText(input.verifier.version)) return 'unknown';
  if (!input.resource || !sameResourceIdentity(input.requestedResource, input.resource)) return 'resource_mismatch';
  if (input.documentId !== undefined && (!identityText(input.documentId)
    || input.resource.kind === 'document' && input.resource.id !== input.documentId)) return 'resource_mismatch';
  if (!content.trim()) return 'empty';
  return input.complete && hash(input.contentHash) ? 'acquired' : 'incomplete';
}

/** Called by trusted host readers, never from parsed model output or CLI self-reported metadata. */
export function observeResourceAcquisition(input: AcquisitionObservationInput): HostAcquisition {
  const { executionSucceeded: _executionSucceeded, ...identity } = input;
  const content = input.content ?? '';
  const status = observedStatus(input, content);
  const configuration = input.configuration ? { ...input.configuration,
    authentication: status === 'acquired' ? 'satisfied' as const
      : status === 'authentication_required' ? 'required' as const : input.configuration.authentication } : undefined;
  const receipt: Omit<HostAcquisition, 'snapshot'> = { ...identity, resource: input.resource ?? input.requestedResource,
    content, contentHash: input.contentHash ?? null, verifier: input.verifier ?? null, status,
    ...(configuration ? { configuration } : {}) };
  return { ...receipt, snapshot: receiptSnapshot(receipt) };
}

function receiptValid(receipt: HostAcquisition): boolean {
  return !!receipt && typeof receipt === 'object' && identityText(receipt.id) && identityText(receipt.operationId) && identityText(receipt.taskId)
    && identityText(receipt.workId) && hash(receipt.requestHash) && Number.isSafeInteger(receipt.attempt) && receipt.attempt > 0
    && Number.isSafeInteger(receipt.epoch) && receipt.epoch > 0 && Number.isSafeInteger(receipt.goalVersion) && receipt.goalVersion > 0
    && Number.isSafeInteger(receipt.at) && receipt.at >= 0 && !!resourceIdentity(receipt.requestedResource)
    && !!resourceIdentity(receipt.resource) && typeof receipt.content === 'string' && typeof receipt.sourceSnapshot === 'string'
    && (receipt.documentId === undefined || identityText(receipt.documentId))
    && typeof receipt.complete === 'boolean' && ['acquired', 'authentication_required', 'resource_mismatch', 'empty', 'incomplete', 'unknown'].includes(receipt.status)
    && (receipt.contentHash === null || hash(receipt.contentHash))
    && (receipt.verifier === null || !!receipt.verifier && identityText(receipt.verifier.id) && identityText(receipt.verifier.version))
    && receipt.snapshot === receiptSnapshot(receipt);
}

export function acquisitionEventProblem(c: TaskContext, event: AcquisitionEvent): string | null {
  const work = c.intents.find(item => item.id === event.intentId), receipt = event.receipt;
  if (!work || work.status !== 'inflight' || c.stopped || c.outcome !== null) return 'ACQUISITION_WORK_UNAVAILABLE';
  if (!receiptValid(receipt)) return 'INVALID_ACQUISITION_RECEIPT';
  if (receipt.taskId !== c.taskId || receipt.workId !== work.id || receipt.attempt > work.attempt
    || receipt.epoch !== c.epoch || receipt.goalVersion !== c.goalVersion || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion)
    return 'STALE_ACQUISITION_RECEIPT';
  if (work.hostAcquisitions?.some(item => item.id === receipt.id && item.snapshot !== receipt.snapshot)) return 'ACQUISITION_ID_CONFLICT';
  if (receipt.source === 'runCli') {
    const op = work.localOperations?.find(item => item.id === receipt.operationId);
    if (!op || op.action.type !== 'runCli' || !['succeeded', 'failed'].includes(op.status)
      || op.parentAttempt !== receipt.attempt || op.finishedAt !== receipt.at
      || op.requestHash !== receipt.requestHash || operationAcquisitionSnapshot(op) !== receipt.sourceSnapshot) return 'ACQUISITION_SOURCE_UNAVAILABLE';
    if (receipt.attempt < work.attempt && (op.status !== 'succeeded' || !op.result?.ok
      || typeof op.result.data.stdout !== 'string' || op.result.data.truncated !== false)) return 'ACQUISITION_SOURCE_UNAVAILABLE';
    if (receipt.status === 'acquired' && (op.status !== 'succeeded' || !op.result?.ok)) return 'ACQUISITION_SOURCE_UNAVAILABLE';
  } else if (receipt.attempt !== work.attempt || receipt.source !== 'webFetch' || !receipt.operationId.startsWith(`request:${work.id}:${work.attempt}:web_fetch:`)
    || !c.trace.some(item => item.event === 'CONSUME' && item.detail === receipt.operationId))
    return 'ACQUISITION_SOURCE_UNAVAILABLE';
  return null;
}

export function recordAcquisition(c: TaskContext, event: AcquisitionEvent): void {
  const work = c.intents.find(item => item.id === event.intentId)!;
  if (!work.hostAcquisitions?.some(item => item.id === event.receipt.id)) (work.hostAcquisitions ??= []).push(structuredClone(event.receipt));
}

/** Saved observations remain history; their host identity and source must still be intact. */
export function acquisitionsForOperation(c: TaskContext, work: Intent, op: LocalOperation): HostAcquisition[] {
  return (work.hostAcquisitions ?? []).filter(receipt => receiptValid(receipt) && receipt.taskId === c.taskId
    && receipt.workId === work.id && receipt.operationId === op.id && receipt.requestHash === op.requestHash
    && receipt.goalVersion === work.goalVersion && receipt.epoch === work.epoch && receipt.attempt <= work.attempt
    && receipt.attempt === op.parentAttempt && receipt.at === op.finishedAt
    && receipt.source === 'runCli' && receipt.sourceSnapshot === operationAcquisitionSnapshot(op)
    && (receipt.status !== 'acquired' || op.status === 'succeeded' && op.result?.ok));
}

export function acquisitionForOperation(c: TaskContext, work: Intent, op: LocalOperation): HostAcquisition | undefined {
  return acquisitionsForOperation(c, work, op)[0];
}

export function verifiedResourceAcquisition(receipt: HostAcquisition): boolean {
  return receiptValid(receipt) && receipt.status === 'acquired' && receipt.complete && !!receipt.content.trim()
    && hash(receipt.contentHash) && !!receipt.verifier && sameResourceIdentity(receipt.requestedResource, receipt.resource)
    && (receipt.documentId === undefined || receipt.resource.kind !== 'document' || receipt.documentId === receipt.resource.id)
    && !authenticationPage(receipt.content) && receipt.configuration?.authentication !== 'required';
}

export function verifiedAcquisitionForOperation(c: TaskContext, work: Intent, op: LocalOperation): HostAcquisition | undefined {
  return acquisitionsForOperation(c, work, op).find(verifiedResourceAcquisition);
}

export function savedAcquisitions(c: TaskContext): HostAcquisition[] {
  return c.intents.flatMap(work => (work.hostAcquisitions ?? []).filter(receipt => {
    if (receipt.goalVersion !== c.goalVersion || !receiptValid(receipt) || receipt.taskId !== c.taskId) return false;
    if (receipt.source === 'webFetch') return receipt.workId === work.id && receipt.epoch === work.epoch
      && receipt.attempt <= work.attempt;
    const op = work.localOperations?.find(item => item.id === receipt.operationId);
    return !!op && acquisitionsForOperation(c, work, op).some(item => item.snapshot === receipt.snapshot);
  }));
}

export function savedResourceAcquisitions(c: TaskContext): HostAcquisition[] {
  return savedAcquisitions(c).filter(verifiedResourceAcquisition);
}

function directText(text: string): string {
  let fenced = false;
  return text.split(/\r?\n/).filter(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return false; }
    return !fenced && !/^\s*>/.test(line);
  }).join('\n').replace(/`[^`]*`|“[^”]*”|"[^"\n]*"/g, '');
}

function explicitRequirements(c: TaskContext): ResourceRequirement[] {
  if (c.goal.resourceRequirements) return c.goal.resourceRequirements.filter(item => !!resourceIdentity(item.resource)
    && ['saved', 'current'].includes(item.freshness));
  const texts = [c.goal.text, ...(c.inputAnalyses ?? []).filter(item => item.goalVersion === c.goalVersion
    && item.status === 'resolved' && item.action !== 'review').map(item => item.rawText)].map(directText);
  return texts.flatMap(text => {
    if (!/(?:读取|抓取|获取|下载|访问|汇总|逐篇|逐个|\b(?:read|fetch|retrieve|download|summarize)\b)/i.test(text)) return [];
    const freshness = /(?:重新|最新|刷新|本次|\b(?:refresh|fresh|again|current)\b)/i.test(text) ? 'current' as const : 'saved' as const;
    return [...text.matchAll(/https?:\/\/[^\s<>"'，。；！？、)\]}]+/g)].flatMap(match => {
      const resource = resourceIdentity({ kind: 'url', url: match[0] });
      return resource ? [{ resource, freshness }] : [];
    });
  });
}

export function requiredResources(c: TaskContext, work?: Intent): ResourceRequirement[] {
  const byId = new Map<string, ResourceRequirement>();
  for (const requirement of explicitRequirements(c)) {
    const key = JSON.stringify(resourceIdentity(requirement.resource)), prior = byId.get(key);
    if (!prior || requirement.freshness === 'current') byId.set(key, requirement);
  }
  for (const resources of Object.values(c.goal.partitionResources ?? {})) for (const value of resources) {
    const resource = resourceIdentity(value);
    if (resource && !byId.has(JSON.stringify(resource))) byId.set(JSON.stringify(resource), { resource, freshness: 'saved' });
  }
  const requirements = [...byId.values()];
  if (!work?.payload.partition) return requirements;
  const partition = work.payload.partition as { id?: string; objective?: string; expectedOutput?: string };
  if (c.goal.partitionResources) return (c.goal.partitionResources[partition.id ?? ''] ?? []).flatMap(value => {
    const resource = resourceIdentity(value), requirement = resource && byId.get(JSON.stringify(resource));
    return requirement ? [requirement] : [];
  });
  const assignment = `${partition.objective ?? ''}\n${partition.expectedOutput ?? ''}`;
  return requirements.filter(item => item.resource.kind === 'url' && assignment.includes(item.resource.url));
}

function acquisitionMatches(c: TaskContext, receipt: HostAcquisition, requirement: ResourceRequirement, work?: Intent): boolean {
  return sameResourceIdentity(requirement.resource, receipt.resource)
    && (requirement.freshness !== 'current' || receipt.epoch === c.epoch && (!work || receipt.workId === work.id));
}

/** Select original verified observations; reuse never changes their execution identity or capture time. */
export function resourceAcquisitionSources(c: TaskContext, work?: Intent, allowedOperationIds?: readonly string[]): HostAcquisition[] {
  const available = savedResourceAcquisitions(c).filter(receipt => !allowedOperationIds
    || allowedOperationIds.includes(receipt.operationId) || allowedOperationIds.includes(receipt.id));
  const priority = (receipt: HostAcquisition) => Number(receipt.workId === work?.id) * 4
    + Number(receipt.epoch === c.epoch) * 2 + Number(receipt.attempt === work?.attempt);
  const selected = requiredResources(c, work).flatMap(requirement => {
    const receipt = available.filter(item => acquisitionMatches(c, item, requirement, work))
      .sort((a, b) => priority(b) - priority(a) || b.at - a.at || a.id.localeCompare(b.id))[0];
    return receipt ? [receipt] : [];
  });
  return [...new Map(selected.map(receipt => [receipt.id, receipt])).values()];
}

export function missingResourceAcquisitions(c: TaskContext, work?: Intent, allowedOperationIds?: readonly string[]): ResourceRequirement[] {
  const receipts = resourceAcquisitionSources(c, work, allowedOperationIds);
  return requiredResources(c, work).filter(requirement => !receipts.some(receipt => acquisitionMatches(c, receipt, requirement, work)));
}

export function resourceAcquisitionProblem(c: TaskContext, work?: Intent): string | null {
  return missingResourceAcquisitions(c, work).length ? 'RESOURCE_ACQUISITION_UNVERIFIED' : null;
}

/** Verified source acquisition does not independently verify an author's generated artifact. */
export function artifactVerification(c: TaskContext, artifact: Artifact): { status: 'verified' | 'unverified'; reason?: string } {
  if (artifact.goalVersion !== c.goalVersion) return { status: 'unverified', reason: '旧目标文件' };
  const candidate = c.candidate;
  const check = candidate?.revision ? [...c.intents].reverse().find(work => work.kind === 'check' && work.status === 'done'
    && work.goalVersion === c.goalVersion
    && (work.payload.candidate as { revision?: string } | undefined)?.revision === candidate.revision && work.criteriaResults?.length) : undefined;
  const fixed = check?.payload.candidate as { artifactIds?: string[]; acceptance?: { criteria: { id: string }[] } } | undefined;
  const frozen = (check?.payload.artifacts as Artifact[] | undefined)?.find(item => item.id === artifact.id);
  return fixed?.acceptance?.criteria.length === check?.criteriaResults?.length
    && check?.criteriaResults?.every(item => item.status === 'passed' && fixed?.acceptance?.criteria.some(criterion => criterion.id === item.criterionId))
    && fixed?.artifactIds?.includes(artifact.id) && frozen?.content === artifact.content
    && check && !deliveryVerificationProblem(check, true)
    ? { status: 'verified' } : { status: 'unverified', reason: '没有通过绑定此候选及文件的独立完整检查' };
}
