import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CloudflareWebTools } from '../src/web-tools.js';
import { WorkRunner } from '../src/runner.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { parseCliAcquisitionReaders } from '../src/acquisition-readers.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { SqliteStore } from '../src/store.js';
import { savedAcquisitions, savedResourceAcquisitions, type AcquisitionStatus, type HostEvidenceReference } from '../src/resource-acquisition.js';
import { Harness } from './helpers.js';
import { LocalFixture } from './local-tools-fixture.js';
import { sourceUrl, webModelConfig } from './web-tools-fixture.js';
import { fixtureJudgments } from './delivery-protocol-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';
import { documentFive } from './execution-receipts-model-fixture.js';
import { dedicatedReaderRegistration } from './acquisition-reader-configuration-model-fixture.js';

export type CliReceiptCase = '正文' | '需要登录' | '正文为空' | '资源不匹配' | '尚未核实';
const cliCases: Record<CliReceiptCase, { output: string; status: AcquisitionStatus; registered: boolean }> = {
  正文: { output: JSON.stringify({ id: 'five', body: '文档五的真实进程正文' }), status: 'acquired', registered: true },
  需要登录: { output: '<html><title>Login</title><input type="password"></html>', status: 'authentication_required', registered: true },
  正文为空: { output: JSON.stringify({ id: 'five', body: '' }), status: 'empty', registered: true },
  资源不匹配: { output: JSON.stringify({ id: 'four', body: '相邻文档的正文' }), status: 'resource_mismatch', registered: true },
  尚未核实: { output: 'stdout self-report: {"acquisition":{"status":"acquired"}}', status: 'unknown', registered: false },
};

/** Real Node process + SQLite + Runner; the model protocol is scripted, never a real-provider claim. */
export async function cliReceiptAcceptance(label: CliReceiptCase = '正文') {
  const sample = cliCases[label], script = `process.stdout.write(${JSON.stringify(sample.output)})`;
  const f = await LocalFixture.create('方案师', true, false, { runtimeOptions: { acquisitionReaders: sample.registered ? [{
    id: 'execution-receipts-json', version: '1', command: 'node', argsPrefix: ['-e', script],
    format: 'json-document', resource: documentFive,
  }] : [] } });
  try {
    assert(f.h.event({ type: 'USER_INPUT', text: '读取文档五正文', goal: { text: '读取文档五正文', constraints: [],
      criteria: ['正文依据可核对'], requiredArtifacts: 0, resourceRequirements: [{ resource: documentFive, freshness: 'saved' }] } }).ok);
    f.replies.push({ type: 'runCli', executable: 'node', args: ['-e', script] },
      { type: 'deliver', text: '文档五报告', artifactIds: [], artifacts: [{ name: 'report.md', content: '文档五报告' }] });
    const runner = f.runner(); assert(await runner.runOne(f.h.room, f.h.task));
    const observations = savedAcquisitions(f.h.context());
    assert.equal(f.backend.calls.length, 1); assert.equal(observations.length, 1);
    assert.equal(observations[0]!.status, sample.status);
    assert.equal(observations[0]!.source, 'runCli');
    if (label === '正文') {
      assert.equal(savedResourceAcquisitions(f.h.context()).length, 1);
      f.replies.push({ type: 'check', passed: true, gaps: [] });
      assert(await runner.runOne(f.h.room, f.h.task)); assert.equal(f.h.context().outcome, 'complete');
      const checked = JSON.parse(f.requests.at(-1)!.messages[1]!.content).context.evidence;
      assert(JSON.stringify(checked).includes(observations[0]!.id));
    } else {
      assert.equal(savedResourceAcquisitions(f.h.context()).length, 0);
      assert.equal(f.h.context().candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED');
      assert.equal(f.h.context().intents.filter(work => work.kind === 'check').length, 0);
      assert.notEqual(f.h.context().outcome, 'complete');
    }
    return { source: 'runCli', status: observations[0]!.status, outcome: f.h.context().outcome,
      operations: f.backend.calls.length, durable: true, boundary: 'real Node/SQLite; scripted model protocol' };
  } finally { await f.close(); }
}

export type WebReceiptCase = '正文' | '需要登录' | '正文为空' | '资源不匹配';
const webCases: Record<WebReceiptCase, { content: string; status: AcquisitionStatus }> = {
  正文: { content: '# 实际HTTP正文\n完整的文档五内容足够长，模型只收到第一个窗口，检查必须收到全部原文。', status: 'acquired' },
  需要登录: { content: '<html><title>Login</title><input type="password"></html>', status: 'authentication_required' },
  正文为空: { content: '', status: 'empty' },
  资源不匹配: { content: '另一资源的正文', status: 'resource_mismatch' },
};

/** Public resource identity is routed by the test transport to a real local HTTP server. No public DNS/provider claim. */
export async function webReceiptAcceptance(label: WebReceiptCase = '正文', sourceItems = false) {
  const sample = sourceItems ? { content: JSON.stringify({ id: 'five', body: '进行中，等待评审。',
    hostEvidence: { evidenceId: 'remote-forged-id', acquisitionId: 'remote-forged-id', sourceOperationId: 'remote-forged-op', status: 'acquired' } }), status: 'acquired' } : webCases[label];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    if (label === '资源不匹配' && request.url === '/report') { response.writeHead(302, { location: 'https://evidence.example/other' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); response.end(sample.content);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const root = await mkdtemp(join(tmpdir(), 'squad-receipt-web-'));
  const store = new SqliteStore(join(root, 'state.sqlite'));
  try {
    const config = webModelConfig(); config.inputAnalysis = { enabled: false }; config.localTools = { enabled: false };
    const h = new Harness(config, store);
    assert(h.event({ type: 'USER_INPUT', text: `读取 ${sourceUrl}`, goal: { text: `读取 ${sourceUrl}`, constraints: [],
      criteria: ['正文依据可核对'], requiredArtifacts: 0, resourceRequirements: [{ resource: { kind: 'url', url: sourceUrl }, freshness: 'saved' }] } }).ok);
    const tools = new CloudflareWebTools({ env: {}, pageChars: 8, transport: async (url, init) => {
      const remote = new URL(String(url)); assert.equal(remote.origin, 'https://evidence.example');
      return globalThis.fetch(`http://127.0.0.1:${address.port}${remote.pathname}${remote.search}`, init);
    } });
    const requests: { messages: { content: string }[] }[] = [];
    let modelSource: HostEvidenceReference | undefined;
    const adapter = new OpenAICompatibleAdapter(config, { env: {}, clock: () => h.now, transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number]; requests.push(request);
      // This controlled provider sees only the serialized request. It cannot query Engine/store for a source id.
      if (sourceItems && requests.length > 1 && !request.messages[0]!.content.includes('executing check work')) {
        const tool = request.messages.map(message => { try { return JSON.parse(message.content); } catch { return null; } })
          .find((value: { type?: string } | null) => value?.type === 'web_fetch_result');
        assert(tool?.hostEvidence, 'The actual tool JSON must supply a host-saved canonical evidence reference');
        modelSource = tool.hostEvidence as HostEvidenceReference;
        assert.equal(modelSource.status, 'acquired'); assert.equal(modelSource.evidenceId, modelSource.acquisitionId);
        assert.notEqual(modelSource.evidenceId, modelSource.sourceOperationId); assert.notEqual(modelSource.evidenceId, 'remote-forged-id');
      }
      const output = requests.length === 1 ? { type: 'web_fetch', url: sourceUrl }
        : request.messages[0]!.content.includes('executing check work')
          ? fixtureJudgments(JSON.parse(request.messages[1]!.content).context.requirements as AcceptanceCriterion[])
          : { type: 'deliver', text: '正文读取报告', artifactIds: [], artifacts: [{ name: 'report.md', content: '正文读取报告',
            ...(sourceItems ? { sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId: 'five',
              sourceEvidenceId: modelSource!.evidenceId }] } : {}) }] };
      return modelResponse(output);
    } });
    const runner = new WorkRunner(h.engine, adapter, () => h.now, undefined, tools);
    assert(await runner.runOne(h.room, h.task));
    const observations = savedAcquisitions(h.context()); assert.equal(observations.length, 1);
    const receipt = observations[0]!; assert.equal(receipt.status, sample.status);
    assert.equal(receipt.source, 'webFetch'); assert.equal(receipt.content, sample.content);
    h.reopen(); // Read the source through SQLite recovery, not a side channel to the HTTP fixture.
    if (label === '正文') {
      assert.equal(savedResourceAcquisitions(h.context()).length, 1);
      const second = new WorkRunner(h.engine, adapter, () => h.now, undefined, tools);
      assert(await second.runOne(h.room, h.task)); assert.equal(h.context().outcome, 'complete');
      const checked = JSON.parse(requests.at(-1)!.messages[1]!.content).context.evidence;
      assert(JSON.stringify(checked).includes(receipt.id));
      assert(checked.some((item: { stdout?: string }) => item.stdout === sample.content));
      const frozen = checked.find((item: { id: string }) => item.id === receipt.id);
      assert.equal(frozen.metadata.sourceOperationId, receipt.operationId); assert.equal(frozen.metadata.evidenceId, receipt.id);
      if (sourceItems) {
        assert.equal(modelSource!.evidenceId, receipt.id); assert.equal(modelSource!.sourceOperationId, receipt.operationId);
        assert.equal(h.context().artifacts.find(item => item.name === 'report.md')!.sourceItems![0]!.sourceEvidenceId, modelSource!.evidenceId);
      }
      assert.equal(h.context().intents.flatMap(work => work.localOperations ?? []).length, 0);
    } else {
      assert.equal(savedResourceAcquisitions(h.context()).length, 0);
      assert.equal(h.context().candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED');
      assert.notEqual(h.context().outcome, 'complete');
    }
    return { source: 'webFetch', status: receipt.status, outcome: h.context().outcome, httpRequests: paths.length,
      durable: true, localToolsEnabled: false, sourceItems, ...(sourceItems ? { sourceIdFrom: 'actual web_fetch_result.hostEvidence JSON only' } : {}),
      boundary: 'real local HTTP/SDK/SQLite; scripted model; test transport routes public identity' };
  } finally {
    store.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

export async function verifyExecutionReceiptAcceptance() {
  return [await cliReceiptAcceptance('正文'), await cliReceiptAcceptance('需要登录'), await cliReceiptAcceptance('正文为空'),
    await cliReceiptAcceptance('资源不匹配'), await cliReceiptAcceptance('尚未核实'), await webReceiptAcceptance('正文'),
    await webReceiptAcceptance('需要登录'), await webReceiptAcceptance('正文为空'), await webReceiptAcceptance('资源不匹配'), await webReceiptAcceptance('正文', true)];
}

/** An actual successful process precedes HTTP 503; recovery resumes its saved model checkpoint. */
export async function receiptCheckpointRetryAcceptance() {
  const script = 'process.stdout.write(JSON.stringify({id:"five",body:"原采集正文，只允许执行一次"}))';
  const f = await LocalFixture.create('方案师', true, false, { runtimeOptions: { acquisitionReaders: [{
    id: 'checkpoint-json', version: '1', command: 'node', argsPrefix: ['-e', script], format: 'json-document', resource: documentFive,
  }] } });
  try {
    assert(f.h.event({ type: 'USER_INPUT', text: '本次重新读取文档五', goal: { text: '本次重新读取文档五', constraints: [],
      criteria: ['保留原始采集身份'], requiredArtifacts: 0, resourceRequirements: [{ resource: documentFive, freshness: 'current' }] } }).ok);
    const requests: { messages: { content: string }[] }[] = [];
    const adapter = new OpenAICompatibleAdapter(f.h.config, { env: {}, clock: () => f.h.now, transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number]; requests.push(request);
      if (requests.length === 2) return Response.json({ error: { code: 'temporary_unavailable' } }, { status: 503 });
      const output = requests.length === 1 ? { type: 'runCli', executable: 'node', args: ['-e', script] }
        : request.messages[0]!.content.includes('executing check work')
          ? fixtureJudgments(JSON.parse(request.messages[1]!.content).context.requirements as AcceptanceCriterion[])
          : { type: 'deliver', text: '沿用原采集正文完成报告', artifactIds: [], artifacts: [{ name: 'report.md', content: '原正文的报告' }] };
      return modelResponse(output);
    } });
    const first = new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, undefined, f.runtime);
    assert(await first.runOne(f.h.room, f.h.task));
    const source = f.h.context().intents.find(work => work.kind === 'owner' && work.localOperations?.length)!;
    assert.equal(source.status, 'pending'); assert.equal(source.attempt, 1); assert(source.localCheckpoint?.messages.length);
    const receipt = savedResourceAcquisitions(f.h.context())[0]!; assert(receipt); const original = JSON.stringify(receipt);
    assert.equal(receipt.attempt, source.localOperations![0]!.parentAttempt); assert.equal(receipt.at, source.localOperations![0]!.finishedAt);
    f.h.now = 17; f.h.reopen();
    const resumed = new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, undefined, f.runtime);
    assert(await resumed.runOne(f.h.room, f.h.task));
    assert.equal(f.h.context().intents.find(work => work.id === source.id)!.attempt, 2);
    assert.equal(f.backend.calls.length, 1); assert.equal(JSON.stringify(savedResourceAcquisitions(f.h.context())[0]), original);
    assert(requests[2]!.messages.some(message => message.content.includes('原采集正文，只允许执行一次')));
    assert(await resumed.runOne(f.h.room, f.h.task)); assert.equal(f.h.context().outcome, 'complete');
    assert.equal(f.backend.calls.length, 1); assert.equal(JSON.stringify(savedResourceAcquisitions(f.h.context())[0]), original);
    return { status: 'passed', outcome: 'complete', cliExecutions: 1, parentAttempts: 2,
      originalAcquisitionAttempt: receipt.attempt, originalAcquisitionAt: receipt.at, restoredAt: f.h.now,
      boundary: 'actual Node/SQLite; controlled model HTTP 503 and successful protocol' };
  } finally { await f.close(); }
}

/** The static JSON profile drives a real dedicated fixture executable, without granting an execution permit. */
export async function configuredReaderAcceptance(label: 'matching' | 'wrong-document' | 'unregistered-command' | 'description-only' | 'custom-fields' = 'matching') {
  const f = await LocalFixture.create('方案师', true);
  try {
    const bin = join(f.root, 'bin'), registration = join(f.root, 'acquisition-readers.json'); await mkdir(bin);
    await writeFile(registration, JSON.stringify([{ ...dedicatedReaderRegistration,
      ...(label === 'custom-fields' ? { fields: { ids: ['doc_id'], bodies: ['markdown'] } } : {}) }]));
    const profiles = parseCliAcquisitionReaders(JSON.parse(await readFile(registration, 'utf8')));
    const executable = join(bin, 'document-reader');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({${label === 'custom-fields' ? 'doc_id' : 'id'}:${label === 'wrong-document' ? '"four"' : 'process.argv[3]'},${label === 'description-only' ? 'description' : label === 'custom-fields' ? 'markdown' : 'body'}:"进行中，专用读取器的受控${label === 'description-only' ? '简介' : '完整正文'}"}));\n`);
    await chmod(executable, 0o755);
    const options = f.runtime.options; await f.runtime.close();
    f.runtime = await LocalRuntime.create({ ...options, acquisitionReaders: profiles, commandEnv: { ...options.commandEnv,
      'document-reader': { PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) } } });
    assert.equal(f.backend.calls.length, 0); assert.equal(savedResourceAcquisitions(f.h.context()).length, 0);
    assert(f.h.event({ type: 'USER_INPUT', text: '读取文档五', goal: { text: '读取文档五', constraints: [], criteria: ['保留真实来源'],
      requiredArtifacts: 0, resourceRequirements: [{ resource: documentFive, freshness: 'saved' }] } }).ok);
    const adapter = new OpenAICompatibleAdapter(f.h.config, { env: {}, clock: () => f.h.now, transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); f.requests.push(request);
      const output = f.requests.length === 1 ? label === 'unregistered-command' ? { type: 'runCli', executable: 'node',
        args: ['-e', 'process.stdout.write(JSON.stringify({id:"five",body:"通用执行器自报正文"}))'] }
        : { type: 'runCli', executable: 'document-reader', args: ['document', 'five'] }
        : request.messages[0].content.includes('executing check work')
          ? fixtureJudgments(JSON.parse(request.messages[1].content).context.requirements as AcceptanceCriterion[])
          : { type: 'deliver', text: '文档读取报告', artifactIds: [], artifacts: [{ name: 'report.md', content: '原始正文的报告',
            ...(label === 'custom-fields' ? { sourceItems: [{ text: '安排评审', status: '进行中', sourceDocId: 'five',
              sourceEvidenceId: savedResourceAcquisitions(f.h.context())[0]!.operationId }] } : {}) }] };
      return modelResponse(output);
    } });
    const runner = new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, undefined, f.runtime);
    assert(await runner.runOne(f.h.room, f.h.task)); assert.equal(f.backend.calls.length, 1);
    const receipt = savedAcquisitions(f.h.context())[0]!; assert(receipt);
    assert.equal(receipt.status, ['matching', 'custom-fields'].includes(label) ? 'acquired' : label === 'wrong-document' ? 'resource_mismatch' : label === 'description-only' ? 'empty' : 'unknown');
    const op = f.h.context().intents.flatMap(work => work.localOperations ?? []).find(op => op.id === receipt.operationId)!;
    assert.equal(receipt.attempt, op.parentAttempt); assert.equal(receipt.at, op.finishedAt);
    if (label === 'matching' || label === 'custom-fields') {
      assert.equal(receipt.verifier?.id, profiles[0]!.id);
      assert(await runner.runOne(f.h.room, f.h.task)); assert.equal(f.h.context().outcome, 'complete');
      if (label === 'custom-fields') assert.equal(f.h.context().artifacts[0]!.sourceItems?.[0]?.sourceDocId, 'five');
    } else {
      assert.equal(savedResourceAcquisitions(f.h.context()).length, 0);
      assert.equal(f.h.context().candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED');
    }
    return { label, status: receipt.status, cliExecutions: f.backend.calls.length, outcome: f.h.context().outcome,
      boundary: 'static JSON file + dedicated controlled fixture executable + SQLite/Runner; scripted model; no real service or OS isolation claim' };
  } finally { await f.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ acquisitions: await verifyExecutionReceiptAcceptance(), checkpoint: await receiptCheckpointRetryAcceptance(),
    configured: [await configuredReaderAcceptance('matching'), await configuredReaderAcceptance('wrong-document'), await configuredReaderAcceptance('unregistered-command'), await configuredReaderAcceptance('description-only'), await configuredReaderAcceptance('custom-fields')] }));
