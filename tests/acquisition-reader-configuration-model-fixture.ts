import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseCliAcquisitionReaders, AcquisitionReaderConfigurationError, observeCliAcquisitions, type CliAcquisitionReader } from '../src/acquisition-readers.js';
import { savedResourceAcquisitions } from '../src/resource-acquisition.js';
import { receiptModel, documentFive, documentUrl, currentReceiptWork, submitReceiptCandidate, finishReceiptCheck, assertReceiptBlocked } from './execution-receipts-model-fixture.js';

export const dedicatedReaderRegistration = { id: 'dedicated-document-reader', version: '1', command: 'document-reader',
  argsPrefix: ['document'], format: 'json-document',
  resource: { kind: 'document-argument', index: 1, service: documentFive.service, namespace: documentFive.namespace } } satisfies CliAcquisitionReader;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export function rejectedReaderConfigurationModel(label: string) {
  const valid = structuredClone(dedicatedReaderRegistration);
  const invalid: Record<string, unknown> = {
    任意JavaScript解析器: [{ ...valid, parser: '() => ({status:"acquired"})' }],
    通用node或echo命令: [{ ...valid, command: 'node' }],
    只有命令名而没有固定参数前缀: [{ ...valid, argsPrefix: [] }],
    重叠的命令及前缀: [valid, { ...valid, id: 'overlapping-reader', argsPrefix: ['document', 'five'] }],
    非法资源参数位置: [{ ...valid, resource: { ...valid.resource, index: 0 } }],
    URL缺少文档身份参数: [{ ...valid, resource: { kind: 'url-argument', index: 1 } }],
    文件资源配用文档JSON格式: [{ ...valid, resource: { kind: 'file', workspaceId: 'source', path: 'five.md' } }],
  };
  assert(Object.hasOwn(invalid, label));
  const m = receiptModel();
  assert.throws(() => parseCliAcquisitionReaders(invalid[label]), AcquisitionReaderConfigurationError);
  assert.equal(savedResourceAcquisitions(m.c).length, 0); assertReceiptBlocked(m);
  return m;
}

export function registeredReaderModel(label: 'matching' | 'wrong-document' | 'unregistered' | 'metadata-only' | 'description-only' | 'URL-without-id' | 'file-json' | 'URL-matching' = 'matching') {
  const url = label.startsWith('URL'), m = receiptModel(url ? documentUrl : documentFive);
  const reader: CliAcquisitionReader = label === 'URL-matching'
    ? { ...dedicatedReaderRegistration, resource: { kind: 'url-argument', index: 1 }, documentIdArgument: 2 }
    : label === 'URL-without-id' ? { ...dedicatedReaderRegistration, resource: documentUrl }
      : label === 'file-json' ? { ...dedicatedReaderRegistration, resource: { kind: 'file', workspaceId: 'source', path: 'five.md' } }
        : dedicatedReaderRegistration;
  const readers = ['URL-without-id', 'file-json'].includes(label) ? [reader]
    : label === 'unregistered' ? [] : parseCliAcquisitionReaders([reader]);
  const stdout = label === 'metadata-only' ? JSON.stringify({ id: 'five', title: 'metadata', status: 200 })
    : label === 'description-only' ? JSON.stringify({ id: 'five', description: '文档简介，不是正文' })
    : JSON.stringify({ id: label === 'wrong-document' ? 'four' : 'five', body: '真实文档五的完整正文' });
  assert(m.request({ type: 'runCli', executable: 'document-reader', args: label === 'URL-matching'
    ? ['document', documentUrl.url, 'five'] : ['document', 'five'] }).ok);
  assert(m.claim().ok); assert(m.started().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout, exitCode: 0, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: sha(stdout), bytes: Buffer.byteLength(stdout), chars: [...stdout].length } } } } }).ok);
  const work = currentReceiptWork(m), operation = work.localOperations![0]!;
  const receipts = observeCliAcquisitions(work, operation, readers, sha);
  assert.equal(receipts.length, 1); assert(m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt: receipts[0] }).ok);
  if (label === 'matching' || label === 'URL-matching') {
    assert.equal(receipts[0]!.status, 'acquired'); assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m);
    assert.equal(m.c.outcome, 'complete');
  } else {
    assert.equal(savedResourceAcquisitions(m.c).length, 0); assertReceiptBlocked(m);
    assert.equal(receipts[0]!.status, ['unregistered', 'URL-without-id', 'file-json'].includes(label) ? 'unknown'
      : ['metadata-only', 'description-only'].includes(label) ? 'empty' : 'resource_mismatch');
  }
  return { m, receipt: receipts[0]! };
}

export function verifyReaderConfigurationModels() {
  for (const label of ['任意JavaScript解析器', '通用node或echo命令', '只有命令名而没有固定参数前缀', '重叠的命令及前缀', '非法资源参数位置', 'URL缺少文档身份参数', '文件资源配用文档JSON格式']) rejectedReaderConfigurationModel(label);
  for (const label of ['matching', 'wrong-document', 'unregistered', 'metadata-only', 'description-only', 'URL-without-id', 'file-json', 'URL-matching'] as const) registeredReaderModel(label);
  batchReaderModel('两份匹配正文'); batchReaderModel('只有第二份正文');
  customReaderSourceItemsModel('document'); customReaderSourceItemsModel('url');
  customReaderSourceItemsModel('document', true); customReaderSourceItemsModel('url', true);
  return { model: 'real taskMachine public local result -> trusted registry parser -> acquisition -> delivery gate', cases: 21,
    status: 'passed', boundary: 'controlled saved CLI receipts; no process/network/model I/O; no dynamic JS or permission grant' };
}

export function batchReaderModel(label: '两份匹配正文' | '只有第二份正文') {
  const m = receiptModel(), six = { ...documentFive, id: 'six' };
  assert(m.send({ type: 'USER_INPUT', text: '读取五和六', goal: { text: '读取五和六', constraints: [], criteria: ['两份正文'],
    requiredArtifacts: 0, resourceRequirements: [{ resource: documentFive, freshness: 'saved' }, { resource: six, freshness: 'saved' }] } }).ok);
  assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
  const pending = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
  assert(m.send({ type: 'CLAIM', intentId: pending.id }).ok); m.work = m.c.intents.find(work => work.id === pending.id)!;
  const readers = parseCliAcquisitionReaders([{ ...dedicatedReaderRegistration, argsPrefix: ['batch'], resource: {
    kind: 'document-batch', documents: [{ id: 'five', resource: documentFive }, { id: 'six', resource: six }],
  } }]);
  const documents = label === '两份匹配正文' ? [{ id: 'five', body: '五的完整正文' }, { id: 'six', body: '六的完整正文' }]
    : [{ id: 'six', body: '六的完整正文' }];
  const stdout = JSON.stringify(documents);
  assert(m.request({ type: 'runCli', executable: 'document-reader', args: ['batch'] }).ok); assert(m.claim().ok); assert(m.started().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout, exitCode: 0, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: sha(stdout), bytes: Buffer.byteLength(stdout), chars: [...stdout].length } } } } }).ok);
  const work = currentReceiptWork(m), operation = work.localOperations![0]!;
  const receipts = observeCliAcquisitions(work, operation, readers, sha); assert.equal(receipts.length, 2);
  for (const receipt of receipts) assert(m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt }).ok);
  assert.equal(receipts[1]!.status, 'acquired');
  if (label === '两份匹配正文') {
    assert.equal(receipts[0]!.status, 'acquired'); assert(submitReceiptCandidate(m).ok); finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete');
  } else { assert.equal(receipts[0]!.status, 'resource_mismatch'); assertReceiptBlocked(m); }
  assert.equal(work.localOperations!.length, 1);
  return { m, receipts };
}

export function customReaderSourceItemsModel(kind: 'document' | 'url' = 'document', wrongId = false) {
  const m = receiptModel(kind === 'url' ? documentUrl : documentFive);
  const reader = { ...dedicatedReaderRegistration, fields: { ids: ['doc_id'], bodies: ['markdown'] },
    ...(kind === 'url' ? { resource: { kind: 'url-argument' as const, index: 1 }, documentIdArgument: 2 } : {}) };
  const readers = parseCliAcquisitionReaders([reader]), stdout = JSON.stringify({ doc_id: 'five', markdown: '进行中，等待评审。' });
  assert(m.request({ type: 'runCli', executable: 'document-reader', args: kind === 'url'
    ? ['document', documentUrl.url, 'five'] : ['document', 'five'] }).ok);
  assert(m.claim().ok); assert(m.started().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout, exitCode: 0, truncated: false,
    capturedEvidence: { stdout: { capturedContentHash: sha(stdout), bytes: Buffer.byteLength(stdout), chars: [...stdout].length } } } } }).ok);
  const work = currentReceiptWork(m), op = work.localOperations![0]!, receipt = observeCliAcquisitions(work, op, readers, sha)[0]!;
  assert(m.send({ type: 'RECORD_ACQUISITION', intentId: work.id, receipt }).ok); assert.equal(receipt.status, 'acquired');
  assert(m.send({ type: 'DELIVER', workId: work.id, fence: work, attempt: work.attempt, text: '文档工作清单', artifactIds: [],
    artifacts: [{ name: 'work.md', content: '当前工作项', sourceItems: [{ text: '安排评审', status: '进行中',
      sourceDocId: wrongId ? 'six' : 'five', sourceEvidenceId: op.id }] }] }).ok);
  if (wrongId) { assert.equal(m.c.candidate?.deliveryIssue?.code, 'SOURCE_DOCUMENT_NOT_FOUND'); assert.notEqual(m.c.outcome, 'complete'); }
  else { assert.equal(m.c.candidate?.deliveryIssue, undefined); finishReceiptCheck(m); assert.equal(m.c.outcome, 'complete'); }
  return { m, receipt };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyReaderConfigurationModels()));
