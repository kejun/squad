import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import type { HostAcquisition } from '../src/resource-acquisition.js';
import { savedAcquisitions } from '../src/resource-acquisition.js';
import { WorkRunner, type WorkScope } from '../src/runner.js';
import type { LocalOperation } from '../src/local-operation.js';
import type { WebTools } from '../src/web-tools.js';
import { Harness } from './helpers.js';
import { saveEvidence } from './helpers.js';
import { LocalFixture, localConfig } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function toolMessage(messages: { content: string }[], operationId: string) {
  const message = messages.find(item => {
    try { return JSON.parse(item.content).operationId === operationId; } catch { return false; }
  });
  assert(message, `missing tool message ${operationId}`);
  return JSON.parse(message.content) as Record<string, unknown>;
}

const firstCommandBody = 'UNIQUE-FIRST-STDOUT-BODY';
const secondCommandBody = 'UNIQUE-SECOND-STDOUT-BODY';
const skillGuideBody = '真实引用资料；不得扩大宿主权限。';

export async function prepareOlderReceiptsScenario(): Promise<LocalFixture> {
  const f = await LocalFixture.create('方案师', true);
  f.replies.push(
    { type: 'loadSkill', skillId: f.skillId },
    { type: 'runCli', executable: 'node', args: ['-e', `process.stdout.write(${JSON.stringify(firstCommandBody)})`] },
    { type: 'readSkillResource', skillId: f.skillId, path: 'references/guide.md' },
    { type: 'runCli', executable: 'node', args: ['-e', `process.stdout.write(${JSON.stringify(secondCommandBody)})`] },
    { type: 'answer', text: '已完成两次命令和一次技能读取' },
  );
  return f;
}

export async function olderReceiptsBecomeCards(prepared?: LocalFixture) {
  const ownsFixture = !prepared;
  const f = prepared ?? await prepareOlderReceiptsScenario();
  const first = firstCommandBody;
  const second = secondCommandBody;
  const guide = skillGuideBody;
  try {
    const pending = f.h.engine.pending(f.h.room, f.h.task).find(item => item.kind === 'owner');
    assert(pending);
    assert(await f.runner().runOne(f.h.room, f.h.task, pending.id));
    const work = f.h.context().intents.find(item => item.id === pending.id)!;
    const command = work.localOperations?.find(item => item.action.type === 'runCli' && String(item.result?.data.stdout).includes(first));
    const skill = work.localOperations?.find(item => item.action.type === 'readSkillResource' && item.status === 'succeeded');
    const latest = work.localOperations?.find(item => item.action.type === 'runCli' && String(item.result?.data.stdout).includes(second));
    assert(command?.result && skill?.result && latest?.result);
    const decision = f.requests.at(-1)!;
    const older = toolMessage(decision.messages, command.id);
    const page = toolMessage(decision.messages, skill.id);
    const current = toolMessage(decision.messages, latest.id);
    assert.equal(older.bodyIncluded, false);
    assert.equal(older.ok, true);
    assert.equal(older.exitCode, 0);
    assert.equal(older.truncated, false);
    assert.equal(older.capturedContentHash, (command.result.data.capturedEvidence as { stdout: { capturedContentHash: string } }).stdout.capturedContentHash);
    assert.equal(JSON.stringify(older).includes(first), false);
    assert.equal(page.bodyIncluded, false);
    assert.equal(page.offset, 0);
    assert.equal(page.capturedContentHash, skill.result.data.hash);
    assert.equal(JSON.stringify(page).includes(guide), false);
    assert.equal(String((current.data as { stdout?: string } | undefined)?.stdout ?? ''), `${second}`);
    assert(decision.messages.some(message => message.role === 'assistant' && message.content.includes('"type":"runCli"')));
    return {
      operations: work.localOperations?.length,
      command: { operationId: older.operationId, bodyIncluded: older.bodyIncluded, ok: older.ok,
        exitCode: older.exitCode, truncated: older.truncated, capturedContentHash: older.capturedContentHash },
      skill: { bodyIncluded: page.bodyIncluded, offset: page.offset, capturedContentHash: page.capturedContentHash },
      latestBody: (current.data as { stdout?: string } | undefined)?.stdout,
      assistantToolCall: decision.messages.some(message => message.role === 'assistant' && message.content.includes('"type":"runCli"')),
    };
  } finally { if (ownsFixture) await f.close(); }
}

export async function prepareDirectoryReceiptScenario(): Promise<LocalFixture> {
  const f = await LocalFixture.create('方案师', true);
  f.replies.push(
    { type: 'discoverHost', query: '验证' },
    { type: 'runCli', executable: 'node', args: ['-e', 'process.stdout.write("AFTER-CATALOG-STDOUT")'] },
    { type: 'answer', text: '目录之后完成命令' },
  );
  return f;
}

export async function directoryReceiptCollapsesToOperationId(prepared?: LocalFixture) {
  const ownsFixture = !prepared;
  const f = prepared ?? await prepareDirectoryReceiptScenario();
  try {
    const pending = f.h.engine.pending(f.h.room, f.h.task).find(item => item.kind === 'owner');
    assert(pending);
    assert(await f.runner().runOne(f.h.room, f.h.task, pending.id));
    const work = f.h.context().intents.find(item => item.id === pending.id)!;
    const discovered = work.localOperations?.find(item => item.action.type === 'discoverHost');
    assert(discovered?.result?.ok);
    const stored = work.localCheckpoint?.messages.map(message => JSON.parse(message.content) as { operationId?: string; data?: unknown })
      .find(message => message.operationId === discovered.id);
    assert.deepEqual(stored?.data, { persistedMetadataOperationId: discovered.id });
    assert.notDeepEqual(discovered.result.data, { persistedMetadataOperationId: discovered.id });
    const shownOnce = toolMessage(f.requests[1]!.messages, discovered.id);
    const full = discovered.result.data as { skills: { skills: Array<{ skillId: string; name: string; description: string }> } };
    assert.deepEqual((shownOnce.data as typeof full).skills.skills,
      full.skills.skills.map(({ skillId, name, description }) => ({ skillId, name, description })));
    const later = toolMessage(f.requests[2]!.messages, discovered.id);
    assert.equal(later.bodyIncluded, false);
    assert.deepEqual(later.data, { persistedMetadataOperationId: discovered.id });
    assert(f.requests[2]!.messages.some(message => message.content.includes('AFTER-CATALOG-STDOUT')));
    return {
      operationId: discovered.id,
      checkpointData: stored?.data,
      firstProjectionData: shownOnce.data,
      laterBodyIncluded: later.bodyIncluded,
      laterData: later.data,
      latestCommandVisible: f.requests[2]!.messages.some(message => message.content.includes('AFTER-CATALOG-STDOUT')),
    };
  } finally { if (ownsFixture) await f.close(); }
}

export interface PreparedWebReceiptScenario { f: LocalFixture; web: WebTools; adapter: OpenAICompatibleAdapter; getFetches(): number }
export async function prepareWebPagesScenario(): Promise<PreparedWebReceiptScenario> {
  const f = await LocalFixture.create('方案师', true);
  const pageA = 'PAGE-A-UNIQUE-BODY';
  const pageB = 'PAGE-B-UNIQUE-BODY';
  const snippet = 'SEARCH-SNIPPET-UNIQUE';
  const page = (url: string, content: string) => ({ url, finalUrl: url, status: 200, contentType: 'text/plain', via: 'raw' as const,
    content, totalChars: content.length, headers: {}, bytes: Buffer.byteLength(content), redirects: [], offset: 0, nextOffset: null });
  let fetches = 0;
  const web: WebTools = {
    search: async () => ({ output: { query: 'sources', items: [], metadata: { query: 'sources', requestId: 'search-fixture', latencyMs: 0 } }, text: snippet }) as unknown as Awaited<ReturnType<WebTools['search']>>,
    fetch: async input => {
      fetches++;
      const content = fetches === 1 ? pageA : pageB;
      const output = page(input.url, content);
      return { output, text: content, hostCapture: { url: output.url, finalUrl: output.finalUrl, status: output.status,
        content, totalChars: content.length, headers: {}, redirects: [] } };
    },
  };
  f.replies.push(
    { type: 'web_search', query: 'sources' },
    { type: 'web_fetch', url: 'https://source.fixture.example/a' },
    { type: 'web_fetch', url: 'https://source.fixture.example/b' },
    { type: 'answer', text: '已读取两页' },
  );
  const adapter = new OpenAICompatibleAdapter(f.h.config, { clock: () => f.h.now, transport: async (_url, init) => {
    f.requests.push(JSON.parse(String(init?.body)) as typeof f.requests[number]);
    return modelResponse(f.replies.shift());
  } });
  return { f, web, adapter, getFetches: () => fetches };
}

export async function webPagesProjectAndSearchStays(prepared?: PreparedWebReceiptScenario) {
  const ownsFixture = !prepared;
  const scenario = prepared ?? await prepareWebPagesScenario();
  const { f, web, adapter } = scenario;
  const pageA = 'PAGE-A-UNIQUE-BODY';
  const pageB = 'PAGE-B-UNIQUE-BODY';
  const snippet = 'SEARCH-SNIPPET-UNIQUE';
  try {
    const pending = f.h.engine.pending(f.h.room, f.h.task).find(item => item.kind === 'owner');
    assert(pending);
    assert(await new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, web, f.runtime).runOne(f.h.room, f.h.task, pending.id));
    const decision = f.requests.at(-1)!;
    const cards = decision.messages.filter(message => message.content.includes('"type":"web_fetch_result"'));
    assert.equal(cards.length, 2);
    const older = JSON.parse(cards[0]!.content) as { bodyIncluded: boolean; text?: string; offset: number; totalChars: number; contentHash: string; hostEvidence: { evidenceId: string } };
    const latest = JSON.parse(cards[1]!.content) as { text?: string };
    assert.equal(older.bodyIncluded, false);
    assert.equal(older.text, undefined);
    assert.equal(older.offset, 0);
    assert.equal(older.totalChars, pageA.length);
    assert.equal(older.contentHash, hash(pageA));
    assert.equal(JSON.stringify(older).includes(pageA), false);
    assert.equal(latest.text, pageB);
    const acquisitions = savedAcquisitions(f.h.context()).filter(item => item.workId === pending.id);
    assert(acquisitions.some(item => item.id === older.hostEvidence.evidenceId));
    assert(decision.messages.some(message => message.content.includes(snippet)));
    return {
      fetches: scenario.getFetches(), acquisitions: acquisitions.length,
      older: { bodyIncluded: older.bodyIncluded, text: older.text, offset: older.offset,
        totalChars: older.totalChars, contentHash: older.contentHash, evidenceId: older.hostEvidence.evidenceId },
      latestBody: latest.text,
      searchSnippetVisible: decision.messages.some(message => message.content.includes(snippet)),
      olderBodyAbsent: !JSON.stringify(decision.messages).includes(pageA),
    };
  } finally { if (ownsFixture) await f.close(); }
}

function scriptedScope(checkpoint: WorkScope['localTools'], sources: { operations: readonly LocalOperation[]; acquisitions: readonly HostAcquisition[] }): WorkScope {
  return { authorizeAdditionalRequest() {}, findSkills: async () => [], webSearch: async () => { throw new Error('unused'); },
    webFetch: async () => { throw new Error('unused'); }, receiptSources: () => sources,
    ...(checkpoint ? { localTools: checkpoint } : {}) };
}

async function captureRequest(config: ReturnType<typeof localConfig>, work: Parameters<OpenAICompatibleAdapter['execute']>[0], scope: WorkScope) {
  let request: { messages: { role: string; content: string }[]; truncation?: unknown; truncate?: unknown; truncate_prompt_tokens?: unknown } | undefined;
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => 0, env: {}, transport: async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return modelResponse({ type: 'answer', text: '已组装' });
  } });
  try { await adapter.execute(work, new AbortController().signal, scope); }
  catch (error) { if (!request) throw error; }
  assert(request);
  return request;
}

type PreparedWork = ReturnType<Harness['context']>['intents'][number];
export interface PreparedReceiptRequest {
  config: ReturnType<typeof localConfig>;
  h: Harness;
  work: PreparedWork;
  scope: WorkScope;
}

export function prepareProjectionHashScenario(): PreparedReceiptRequest {
  const config = localConfig();
  const h = new Harness(config);
  const owner = h.claim('owner');
  const first = saveEvidence(h, owner, 'REAL-RECEIPT-BODY');
  const second = saveEvidence(h, owner, 'LATEST-RECEIPT-BODY');
  const current = h.context().intents.find(item => item.id === owner.id)!;
  const tampered = 'TAMPERED-OLD-BODY';
  const scope = scriptedScope({
    catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
    checkpoint: { nextOperation: 3, messages: [
      { role: 'assistant', content: '{"type":"runCli","executable":"node"}' },
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: first, untrusted: true, ok: true, code: 'succeeded',
        data: { stdout: tampered, truncated: false, capturedEvidence: { stdout: { capturedContentHash: 'a'.repeat(64), bytes: 1, chars: 1 } } } }) },
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: second, untrusted: true, ok: true, code: 'succeeded',
        data: { stdout: 'LATEST-RECEIPT-BODY', truncated: false } }) },
    ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
  }, { operations: current.localOperations ?? [], acquisitions: [] });
  return { config, h, work: current, scope };
}

export async function executeProjectionHashScenario(prepared: PreparedReceiptRequest) {
  const request = await captureRequest(prepared.config, prepared.work, prepared.scope);
  const actual = JSON.stringify(request.messages);
  const expectedHash = hash('REAL-RECEIPT-BODY');
  const hasTampered = actual.includes('TAMPERED-OLD-BODY');
  const latestVisible = request.messages.some(message => message.content.includes('LATEST-RECEIPT-BODY'));
  const receipt = (prepared.work.localOperations ?? []).find(operation => operation.result?.data.stdout === 'REAL-RECEIPT-BODY');
  assert(receipt);
  const actualCard = toolMessage(request.messages, receipt.id);
  assert.equal(actualCard.bodyIncluded, false);
  assert.equal(actualCard.capturedContentHash, expectedHash);
  assert.equal(hasTampered, false);
  assert(latestVisible);
  return { hash: actualCard.capturedContentHash, bodyIncluded: actualCard.bodyIncluded,
    tamperedBodyAbsent: !hasTampered, latestBodyVisible: latestVisible };
}

export function prepareCheckMaterialsScenario(): PreparedReceiptRequest {
  const config = localConfig();
  const h = new Harness(config);
  const owner = h.claim('owner');
  assert(h.event({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'CANDIDATE-FULL-TEXT', artifactIds: [] }).ok);
  const check = h.claim('check');
  const oldId = 'check-old-command';
  const latestId = 'check-latest-command';
  const operations = [oldId, latestId].map((id, index): LocalOperation => ({ id, namespace: 'c'.repeat(64), requestHash: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['check.js'] }, status: index === 0 ? 'failed' : 'succeeded', parentAttempt: check.attempt, attempt: 1, createdAt: 1,
    result: index === 0 ? { ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: {} }
      : { ok: true, code: 'succeeded', data: { stdout: 'CHECK-LATEST-STDOUT', truncated: false, exitCode: 0 } } }));
  check.payload.checkMaterials = { requirements: [{ id: 'need-complete', text: '候选完整' }],
    artifacts: [{ id: 'artifact:candidate', name: 'report.md', content: 'CANDIDATE-FULL-TEXT' }],
    evidence: [{ id: 'evidence:bound', stdout: 'EVIDENCE-FULL-BODY' }] } as never;
  const scope = scriptedScope({
    catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
    checkpoint: { nextOperation: 3, messages: [
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: oldId, untrusted: true, ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: { stdout: 'SHOULD-NOT-LEAK' } }) },
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: latestId, untrusted: true, ok: true, code: 'succeeded', data: { stdout: 'CHECK-LATEST-STDOUT' } }) },
    ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
  }, { operations, acquisitions: [] });
  return { config, h, work: check, scope };
}

export async function executeCheckMaterialsScenario(prepared: PreparedReceiptRequest) {
  const request = await captureRequest(prepared.config, prepared.work, prepared.scope);
  const body = JSON.stringify(request);
  const card = toolMessage(request.messages, 'check-old-command');
  const latestVisible = request.messages.some(message => message.content.includes('CHECK-LATEST-STDOUT'));
  assert(body.includes('CANDIDATE-FULL-TEXT'));
  assert(!body.includes('EVIDENCE-FULL-BODY'));
  assert(JSON.parse(request.messages[1]!.content).context.sourceIndex.some((source: { id: string }) => source.id === 'evidence:bound'));
  assert.equal(body.includes('truncate_prompt_tokens'), false);
  assert.equal(body.includes('SHOULD-NOT-LEAK'), false);
  assert.equal(card.bodyIncluded, false);
  assert.equal(card.code, 'EVIDENCE_CONTENT_MISSING');
  assert.equal(card.completeness, 'failed');
  assert(latestVisible);
  return { candidate: true, evidence: true, code: card.code, completeness: card.completeness,
    latestReceiptVisible: latestVisible, fixedInputNotTruncated: !body.includes('truncate_prompt_tokens') };
}

export function prepareFailedReceiptScenario(): PreparedReceiptRequest {
  const config = localConfig();
  const h = new Harness(config);
  const owner = h.claim('owner');
  const failed = saveEvidence(h, owner, 'SECRET-FAILURE-BODY', false);
  const latest = saveEvidence(h, owner, 'VISIBLE-LATEST-BODY');
  const current = h.context().intents.find(item => item.id === owner.id)!;
  const missing: LocalOperation = { id: 'missing-body', namespace: 'c'.repeat(64), requestHash: 'c'.repeat(64),
    action: { type: 'readEvidence', sourceOperationId: failed, stream: 'stdout' }, status: 'failed', parentAttempt: owner.attempt, attempt: 1, createdAt: 1,
    result: { ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: {} } };
  const scope = scriptedScope({
    catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
    checkpoint: { nextOperation: 4, messages: [
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: failed, untrusted: true, ok: false, code: 'EXIT_NONZERO', data: { stdout: 'SECRET-FAILURE-BODY' } }) },
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: missing.id, untrusted: true, ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: { stdout: 'INVENTED-MISSING-BODY' } }) },
      { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: latest, untrusted: true, ok: true, code: 'succeeded', data: { stdout: 'VISIBLE-LATEST-BODY' } }) },
    ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
  }, { operations: [...(current.localOperations ?? []), missing], acquisitions: [] });
  return { config, h, work: current, scope };
}

export async function executeFailedReceiptScenario(prepared: PreparedReceiptRequest) {
  const request = await captureRequest(prepared.config, prepared.work, prepared.scope);
  const failureOperation = prepared.work.localOperations?.find(operation => operation.result?.data.stdout === 'SECRET-FAILURE-BODY');
  assert(failureOperation);
  const failure = toolMessage(request.messages, failureOperation.id);
  const absent = toolMessage(request.messages, 'missing-body');
  const failedBodyAbsent = !JSON.stringify(request.messages).includes('SECRET-FAILURE-BODY');
  const missingBodyAbsent = !JSON.stringify(request.messages).includes('INVENTED-MISSING-BODY');
  const latestBodyVisible = request.messages.some(message => message.content.includes('VISIBLE-LATEST-BODY'));
  assert.equal(failure.code, 'EXIT_NONZERO');
  assert.equal(failure.completeness, 'failed');
  assert.equal(absent.code, 'EVIDENCE_CONTENT_MISSING');
  assert.equal(failedBodyAbsent, true);
  assert.equal(missingBodyAbsent, true);
  assert(latestBodyVisible);
  return { failure: failure.code, failureCompleteness: failure.completeness, missing: absent.code,
    failedBodyAbsent, missingBodyAbsent, latestBodyVisible };
}

export async function projectionUsesReceiptHash() {
  const config = localConfig();
  const h = new Harness(config);
  try {
    const owner = h.claim('owner');
    const first = saveEvidence(h, owner, 'REAL-RECEIPT-BODY');
    const second = saveEvidence(h, owner, 'LATEST-RECEIPT-BODY');
    const current = h.context().intents.find(item => item.id === owner.id)!;
    const tampered = 'TAMPERED-OLD-BODY';
    const request = await captureRequest(config, current, scriptedScope({
      catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: { nextOperation: 3, messages: [
        { role: 'assistant', content: '{"type":"runCli","executable":"node"}' },
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: first, untrusted: true, ok: true, code: 'succeeded',
          data: { stdout: tampered, truncated: false, capturedEvidence: { stdout: { capturedContentHash: 'a'.repeat(64), bytes: 1, chars: 1 } } } }) },
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: second, untrusted: true, ok: true, code: 'succeeded',
          data: { stdout: 'LATEST-RECEIPT-BODY', truncated: false } }) },
      ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
    }, { operations: current.localOperations ?? [], acquisitions: [] }));
    const card = toolMessage(request.messages, first);
    assert.equal(card.bodyIncluded, false);
    assert.equal(card.capturedContentHash, hash('REAL-RECEIPT-BODY'));
    assert.equal(JSON.stringify(request.messages).includes(tampered), false);
    assert(request.messages.some(message => message.content.includes('LATEST-RECEIPT-BODY')));
    return { hash: card.capturedContentHash, bodyIncluded: card.bodyIncluded,
      tamperedBodyAbsent: !JSON.stringify(request.messages).includes(tampered),
      latestBodyVisible: request.messages.some(message => message.content.includes('LATEST-RECEIPT-BODY')) };
  } finally { h.store.close(); }
}

export async function checkMaterialsStayComplete() {
  const config = localConfig();
  const h = new Harness(config);
  try {
    const owner = h.claim('owner');
    assert(h.event({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'CANDIDATE-FULL-TEXT', artifactIds: [] }).ok);
    const check = h.claim('check');
    const oldId = 'check-old-command';
    const latestId = 'check-latest-command';
    const operations = [oldId, latestId].map((id, index): LocalOperation => ({ id, namespace: 'c'.repeat(64), requestHash: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64),
      action: { type: 'runCli', executable: 'node', args: ['check.js'] }, status: index === 0 ? 'failed' : 'succeeded', parentAttempt: check.attempt, attempt: 1, createdAt: 1,
      result: index === 0 ? { ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: {} }
        : { ok: true, code: 'succeeded', data: { stdout: 'CHECK-LATEST-STDOUT', truncated: false, exitCode: 0 } } }));
    check.payload.checkMaterials = { requirements: [{ id: 'need-complete', text: '候选完整' }],
      artifacts: [{ id: 'artifact:candidate', name: 'report.md', content: 'CANDIDATE-FULL-TEXT' }],
      evidence: [{ id: 'evidence:bound', stdout: 'EVIDENCE-FULL-BODY' }] } as never;
    const request = await captureRequest(config, check, scriptedScope({
      catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: { nextOperation: 3, messages: [
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: oldId, untrusted: true, ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: { stdout: 'SHOULD-NOT-LEAK' } }) },
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: latestId, untrusted: true, ok: true, code: 'succeeded', data: { stdout: 'CHECK-LATEST-STDOUT' } }) },
      ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
    }, { operations, acquisitions: [] }));
    const body = JSON.stringify(request);
    assert(body.includes('CANDIDATE-FULL-TEXT'));
    assert(body.includes('EVIDENCE-FULL-BODY'));
    assert.equal(body.includes('truncate_prompt_tokens'), false);
    assert.equal(body.includes('SHOULD-NOT-LEAK'), false);
    const card = toolMessage(request.messages, oldId);
    assert.equal(card.bodyIncluded, false);
    assert.equal(card.code, 'EVIDENCE_CONTENT_MISSING');
    assert.equal(card.completeness, 'failed');
    assert(request.messages.some(message => message.content.includes('CHECK-LATEST-STDOUT')));
    return { candidate: true, evidence: true, code: card.code, completeness: card.completeness,
      latestReceiptVisible: request.messages.some(message => message.content.includes('CHECK-LATEST-STDOUT')),
      fixedInputNotTruncated: !body.includes('truncate_prompt_tokens') };
  } finally { h.store.close(); }
}

export async function failedReceiptIsNotRewritten() {
  const config = localConfig();
  const h = new Harness(config);
  try {
    const owner = h.claim('owner');
    const failed = saveEvidence(h, owner, 'SECRET-FAILURE-BODY', false);
    const latest = saveEvidence(h, owner, 'VISIBLE-LATEST-BODY');
    const current = h.context().intents.find(item => item.id === owner.id)!;
    const missing: LocalOperation = { id: 'missing-body', namespace: 'c'.repeat(64), requestHash: 'c'.repeat(64),
      action: { type: 'readEvidence', sourceOperationId: failed, stream: 'stdout' }, status: 'failed', parentAttempt: owner.attempt, attempt: 1, createdAt: 1,
      result: { ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: {} } };
    const request = await captureRequest(config, current, scriptedScope({
      catalog: { catalogVersion: '0', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: { nextOperation: 4, messages: [
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: failed, untrusted: true, ok: false, code: 'EXIT_NONZERO', data: { stdout: 'SECRET-FAILURE-BODY' } }) },
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: missing.id, untrusted: true, ok: false, code: 'EVIDENCE_CONTENT_MISSING', data: { stdout: 'INVENTED-MISSING-BODY' } }) },
        { role: 'user', content: JSON.stringify({ type: 'local_tool_result', operationId: latest, untrusted: true, ok: true, code: 'succeeded', data: { stdout: 'VISIBLE-LATEST-BODY' } }) },
      ] }, invoke: async () => { throw new Error('unused'); }, resume: async () => { throw new Error('unused'); },
    }, { operations: [...(current.localOperations ?? []), missing], acquisitions: [] }));
    const failure = toolMessage(request.messages, failed);
    const absent = toolMessage(request.messages, missing.id);
    assert.equal(failure.code, 'EXIT_NONZERO');
    assert.equal(failure.completeness, 'failed');
    assert.equal(absent.code, 'EVIDENCE_CONTENT_MISSING');
    assert.equal(JSON.stringify(request.messages).includes('SECRET-FAILURE-BODY'), false);
    assert.equal(JSON.stringify(request.messages).includes('INVENTED-MISSING-BODY'), false);
    assert(request.messages.some(message => message.content.includes('VISIBLE-LATEST-BODY')));
    return { failure: failure.code, failureCompleteness: failure.completeness, missing: absent.code,
      failedBodyAbsent: !JSON.stringify(request.messages).includes('SECRET-FAILURE-BODY'),
      missingBodyAbsent: !JSON.stringify(request.messages).includes('INVENTED-MISSING-BODY'),
      latestBodyVisible: request.messages.some(message => message.content.includes('VISIBLE-LATEST-BODY')) };
  } finally { h.store.close(); }
}
