import type { LocalOperation } from './local-operation.js';
import type { Goal, Intent } from './types.js';
import { authenticationPage, observeResourceAcquisition, operationAcquisitionSnapshot, resourceIdentity,
  type HostAcquisition, type ResourceIdentity } from './resource-acquisition.js';

export type ReaderResource = ResourceIdentity | { kind: 'url-argument'; index: number }
  | { kind: 'document-argument'; index: number; service: string; namespace: string }
  | { kind: 'document-batch'; documents: { id: string; resource: ResourceIdentity }[] };
/** Trusted host configuration. This profile never grants permission to execute its command. */
export interface CliAcquisitionReader {
  id: string; version: string; command: string; argsPrefix?: string[];
  format: 'text' | 'json-document'; resource: ReaderResource;
  documentIdArgument?: number;
  /** Explicit provider-specific content fields, never inferred from generic description/title metadata. */
  fields?: { ids: string[]; bodies: string[] };
}

export class AcquisitionReaderConfigurationError extends Error {
  constructor() { super('ACQUISITION_READERS_INVALID'); this.name = 'AcquisitionReaderConfigurationError'; }
}
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && !!value.trim()
  && value === value.trim() && value.length <= max && !/[\r\n\0]/.test(value);
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const genericCommands = /^(?:node(?:js)?|npx|npm|pnpm|yarn|bun|deno|python[\d.]*|ruby|perl|php|lua|(?:ba|da|z|fi|c|k)?sh|powershell|pwsh|cmd|echo|printf|cat|tee|head|tail|sed|awk|jq|curl|wget|env|xargs|find|timeout)$/i;
const fieldNames = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 8
  && new Set(value).size === value.length && value.every(key => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)
    && !['__proto__', 'constructor', 'prototype'].includes(key));

/** Administrator data, never code: dedicated JSON readers with an unambiguous fixed invocation prefix. */
export function parseCliAcquisitionReaders(value: unknown): CliAcquisitionReader[] {
  if (!Array.isArray(value) || value.length > 100 || JSON.stringify(value).length > 100_000) throw new AcquisitionReaderConfigurationError();
  const readers: CliAcquisitionReader[] = [];
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !keys(raw, ['id', 'version', 'command', 'argsPrefix', 'format', 'resource', 'documentIdArgument', 'fields'])) throw new AcquisitionReaderConfigurationError();
    const item = raw as Record<string, unknown>;
    if (!text(item.id, 128) || !text(item.version, 128) || typeof item.command !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(item.command) || genericCommands.test(item.command)
      || item.format !== 'json-document' || !Array.isArray(item.argsPrefix) || !item.argsPrefix.length || item.argsPrefix.length > 32
      || !item.argsPrefix.every(arg => text(arg)) || !item.resource || typeof item.resource !== 'object' || Array.isArray(item.resource))
      throw new AcquisitionReaderConfigurationError();
    const prefix = item.argsPrefix as string[], resource = item.resource as Record<string, unknown>;
    const argument = (index: unknown): index is number => Number.isSafeInteger(index) && Number(index) >= prefix.length && Number(index) < 128;
    const fixed = resourceIdentity(resource);
    const batch = resource.kind === 'document-batch' && keys(resource, ['kind', 'documents']) && Array.isArray(resource.documents)
      && resource.documents.length > 0 && resource.documents.length <= 64 && resource.documents.every(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !keys(value, ['id', 'resource'])) return false;
        const target = value as Record<string, unknown>, identity = resourceIdentity(target.resource);
        return text(target.id, 1024) && !!identity && (identity.kind === 'url'
          ? !!target.resource && keys(target.resource as object, ['kind', 'url'])
          : identity.kind === 'document' && identity.id === target.id && keys(target.resource as object, ['kind', 'service', 'namespace', 'id']));
      }) && new Set(resource.documents.map(value => (value as { id: string }).id)).size === resource.documents.length
      && new Set(resource.documents.map(value => JSON.stringify(resourceIdentity((value as { resource: ResourceIdentity }).resource)))).size === resource.documents.length;
    const validResource = batch || (resource.kind === 'document' ? !!fixed && keys(resource, ['kind', 'service', 'namespace', 'id'])
      : resource.kind === 'document-argument' ? keys(resource, ['kind', 'service', 'namespace', 'index']) && text(resource.service)
        && text(resource.namespace) && argument(resource.index)
        : resource.kind === 'url' ? !!fixed && keys(resource, ['kind', 'url']) && argument(item.documentIdArgument)
          : resource.kind === 'url-argument' && keys(resource, ['kind', 'index']) && argument(resource.index) && argument(item.documentIdArgument));
    if (!validResource || item.documentIdArgument !== undefined && !['url', 'url-argument'].includes(String(resource.kind))
      || item.fields !== undefined && (!item.fields || typeof item.fields !== 'object' || Array.isArray(item.fields)
        || !keys(item.fields, ['ids', 'bodies']) || !fieldNames((item.fields as Record<string, unknown>).ids)
        || !fieldNames((item.fields as Record<string, unknown>).bodies))) throw new AcquisitionReaderConfigurationError();
    if (readers.some(reader => reader.id === item.id || reader.command === item.command
      && ((reader.argsPrefix ?? []).every((arg, index) => prefix[index] === arg)
        || prefix.every((arg, index) => reader.argsPrefix?.[index] === arg)))) throw new AcquisitionReaderConfigurationError();
    readers.push(structuredClone(item) as unknown as CliAcquisitionReader);
  }
  return readers;
}

function readerResource(reader: CliAcquisitionReader, args: string[]): ResourceIdentity | undefined {
  if (reader.resource.kind === 'url-argument') return resourceIdentity({ kind: 'url', url: args[reader.resource.index] });
  if (reader.resource.kind === 'document-argument') return resourceIdentity({ kind: 'document', service: reader.resource.service,
    namespace: reader.resource.namespace, id: args[reader.resource.index] });
  return resourceIdentity(reader.resource);
}

function readerTargets(reader: CliAcquisitionReader, args: string[]) {
  if (reader.resource.kind === 'document-batch') return reader.resource.documents.flatMap(target => {
    const resource = resourceIdentity(target.resource);
    return resource && text(target.id, 1024) ? [{ resource, documentId: target.id }] : [];
  });
  const resource = readerResource(reader, args);
  if (!resource) return [];
  const documentId = resource.kind === 'document' ? resource.id : resource.kind === 'url' && reader.documentIdArgument !== undefined
    ? args[reader.documentIdArgument] : undefined;
  return [{ resource, documentId }];
}

const bodyFields = ['body', 'body_markdown', 'body_html', 'content'] as const;
function matchingDocumentContents(stdout: string, id: string, fields?: CliAcquisitionReader['fields']): string[][] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const queue: unknown[] = [parsed], bodies: string[][] = [];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { queue.push(...value); continue; }
    const record = value as Record<string, unknown>;
    const matches = (fields?.ids ?? ['id', 'slug']).map(key => record[key])
      .some(key => (typeof key === 'string' || typeof key === 'number' && Number.isSafeInteger(key)) && String(key) === id);
    const content = (fields?.bodies ?? bodyFields).flatMap(key => typeof record[key] === 'string' ? [record[key] as string] : []);
    if (matches) bodies.push(content);
    queue.push(...Object.values(record).filter(child => child !== null && typeof child === 'object'));
  }
  return bodies;
}

export function documentBodies(stdout: string, id: string, fields?: CliAcquisitionReader['fields']): string[][] {
  return matchingDocumentContents(stdout, id, fields).filter(content => content.length > 0);
}

function unknownTarget(work: Intent, op: LocalOperation): ResourceIdentity | undefined {
  const goal = work.payload.goal as Goal | undefined;
  const declared = goal?.resourceRequirements;
  if (declared?.length === 1) return resourceIdentity(declared[0]!.resource);
  if (op.action.type !== 'runCli') return undefined;
  return op.action.args.flatMap(arg => resourceIdentity({ kind: 'url', url: arg }) ?? [])[0];
}

/** Parse only the already persisted, redacted receipt. No process, credential read or network access. */
export function observeCliAcquisitions(work: Intent, op: LocalOperation, readers: readonly CliAcquisitionReader[],
  digest: (content: string) => string, configuration?: HostAcquisition['configuration']): HostAcquisition[] {
  if (op.action.type !== 'runCli' || !op.result || !['succeeded', 'failed'].includes(op.status)) return [];
  const action = op.action, result = op.result;
  const reader = readers.find(item => item.command === action.executable
    && (item.argsPrefix ?? []).every((arg, index) => action.args[index] === arg));
  const unknown = reader ? undefined : unknownTarget(work, op);
  const targets = reader ? readerTargets(reader, action.args) : unknown ? [{ resource: unknown, documentId: undefined }] : [];
  const stdout = typeof result.data.stdout === 'string' ? result.data.stdout : '';
  const taskBoundary = work.id.lastIndexOf(':E');
  return targets.map(({ resource, documentId }) => {
    const supported = reader?.format !== 'json-document' || !!documentId;
    const documents = reader?.format === 'json-document' ? documentId ? matchingDocumentContents(stdout, documentId, reader.fields) : [] : undefined;
    const content = authenticationPage(stdout) ? stdout
      : documents ? documents.length === 1 ? documents[0]!.find(body => !!body.trim()) ?? '' : '' : stdout;
    const matched = !documents || documents.length === 1;
    return observeResourceAcquisition({ id: `${op.id}:acquisition:${digest(JSON.stringify(resource))}`,
      operationId: op.id, taskId: taskBoundary >= 0 ? work.id.slice(0, taskBoundary) : work.id,
      workId: work.id, attempt: op.parentAttempt, epoch: work.epoch, goalVersion: work.goalVersion,
      source: 'runCli', requestHash: op.requestHash, requestedResource: resource,
      ...(matched && documentId ? { documentId } : {}),
      ...(matched ? { resource } : {}), content, contentHash: digest(content), complete: result.data.truncated === false,
      verifier: reader && supported ? { id: reader.id, version: reader.version } : null,
      executionSucceeded: op.status === 'succeeded' && result.ok && result.data.exitCode === 0,
      at: op.finishedAt ?? op.createdAt, sourceSnapshot: operationAcquisitionSnapshot(op),
      ...(configuration ? { configuration } : {}) });
  });
}
