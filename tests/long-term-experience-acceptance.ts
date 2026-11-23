import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import { CloudflareWebTools } from '../src/web-tools.js';
import { ControlledProcessBackend, localConfig } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { parseCliAcquisitionReaders } from '../src/acquisition-readers.js';
import type { Intent } from '../src/types.js';
import { savedAcquisitions } from '../src/resource-acquisition.js';

const readBody = (url: string) => '原文和确切的引用 ' + new URL(url).pathname.slice(1);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const expected = '输出摘要与来源地址';
const documentId = (url: string) => new URL(url).pathname.split('/').at(-1)!;
export const protectedPrefix = 'https://www.yuque.com/team/book/';
const readerCommand = 'fixture-yuque';
const catalogEntry = { command: readerCommand, description: 'Registered document reader', domains: ['www.yuque.com'] };
const partitionUrls = Array.from({ length: 8 }, (_, index) => protectedPrefix + 'doc-' + (index + 1));

type Request = { messages: { role: string; content: string }[] };
type Attempt = { id: string; url: string; learned: boolean; observations: boolean };
export type MemoryFixtureMode = 'seed' | 'read' | 'contrary' | 'document-denied' | 'success' | 'web-failure'
  | 'sandbox-failure' | 'no-receipt' | 'timeout' | 'wrong-book' | 'page-incomplete' | 'truncated' | 'login-redirect' | 'ordinary-redirect';
class MemorySandbox extends ControlledProcessBackend {
  readingBoundary = 'controlled-memory-fixture';
  settledTimeout = false;
  override async execute(...args: Parameters<ControlledProcessBackend['execute']>) {
    if (!this.settledTimeout) return super.execute(...args);
    return { result: { ok: false, code: 'timeout', data: { truncated: false } }, settled: true, effectsKnown: true };
  }
}

function toolMessages(request: Request, type: string) {
  return request.messages.filter(message => message.role === 'user' && message.content.includes('"type":"' + type + '"'));
}

export class ExecutionMemoryFixture {
  readonly config = localConfig();
  readonly backend = new MemorySandbox();
  readonly accountVariable = 'SQUAD_FIXTURE_' + randomUUID().replaceAll('-', '').toUpperCase() + '_SCOPE';
  inventoryAvailable = true;
  structuredSources = false;
  execution: 'host' | 'sandbox' = 'sandbox';
  approvalCount = 0;
  private readonly webHits = new Map<string, number>();
  private sequence = 0;
  private at = 1000;
  private runtime!: LocalRuntime;
  store!: SqliteStore;
  engine!: TeamEngine;
  room = 'execution-memory';
  task!: string;
  urls = partitionUrls.slice(0, 2);
  mode: MemoryFixtureMode = 'seed';
  omitLast = false;
  output = expected;
  requests = 0; webReads = 0;
  readonly attempts: Attempt[] = [];
  afterRead?: (workId: string) => void;
  private constructor(readonly dir: string) {}
  static async create() {
    const fixture = new ExecutionMemoryFixture(await mkdtemp(join(tmpdir(), 'squad-execution-memory-')));
    try {
      fixture.config.executionMemory = true;
      fixture.config.deliveryReport = 'summary';
      fixture.config.inputAnalysis = { enabled: true };
      fixture.config.limits.ordinary = 100;
      fixture.config.limits.assists = 50;
      fixture.config.bots.push({ id: 'C1', name: '协助 C1', instructions: '', tools: [] });
      const source = join(fixture.dir, 'source'), bin = join(fixture.dir, 'bin'), modeFile = join(fixture.dir, 'mode');
      await mkdir(source);
      await mkdir(bin);
      await writeFile(join(bin, readerCommand), [
        '#!' + process.execPath,
        'const fs = require("node:fs");',
        'const url = new URL(process.argv[4]);',
        'const slug = url.pathname.split("/").at(-1);',
        'const mode = fs.readFileSync(' + JSON.stringify(modeFile) + ', "utf8");',
        'if (mode === "contrary") { console.log(JSON.stringify({error: {code: "credential_expired"}})); process.exitCode = 1; }',
        'else if (mode === "document-denied") console.log("<title>Login</title>");',
        'else if (mode === "sandbox-failure") { console.error("Error: spawn /bin/ps EPERM"); process.exitCode = 1; }',
        'else {',
        '  console.log(JSON.stringify({slug, book_id: mode === "wrong-book" ? "different-book" : "fixture-book",',
        '    complete: mode !== "page-incomplete", body: "原文和确切的引用 " + url.pathname.slice(1)}));',
        '  if (mode === "truncated") process.stdout.write(" ".repeat(128000));',
        '}',
      ].join('\n'), { mode: 0o700 });
      process.env[fixture.accountVariable] = 'account-a';
      const path = [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter);
      fixture.runtime = await LocalRuntime.create({ dataRoot: join(fixture.dir, 'runtime'), workspaceRoot: source, skillRoots: [],
        backend: fixture.backend, cliCatalog: [catalogEntry], commandEnv: { [readerCommand]: { PATH: path } },
        catalogRefreshIntervalMs: 0, clock: () => fixture.at,
        acquisitionReaders: parseCliAcquisitionReaders([{ id: 'memory-reader', version: '1', command: readerCommand,
          format: 'json-document', argsPrefix: ['show', 'doc'], resource: { kind: 'url-argument', index: 2 },
          fields: { ids: ['slug'], bodies: ['body'] }, reading: { urlPrefix: protectedPrefix,
            namespaceField: 'book_id', namespaceValue: 'fixture-book', completeField: 'complete',
            accountEnvironment: fixture.accountVariable, credentialErrorCode: 'credential_expired', sandboxStartupPs: true } }]),
      });
      fixture.open();
      return fixture;
    } catch (error) { await fixture.close(); throw error; }
  }
  open() {
    this.store?.close();
    this.store = new SqliteStore(join(this.dir, 'team.sqlite'));
    this.engine = new TeamEngine(this.store, this.config, () => this.at, undefined, () => this.inventoryAvailable ? this.runtime.executionMemoryInventory() : undefined);
  }
  async close() {
    delete process.env[this.accountVariable];
    await this.runtime?.close();
    this.store?.close();
    await rm(this.dir, { recursive: true, force: true });
  }
  async changeCatalog(unrelated = false) {
    this.runtime.options.cliCatalog = unrelated ? [catalogEntry, { command: 'different-tool', description: 'Unrelated catalog metadata' }]
      : [{ ...catalogEntry, description: 'Updated reader' }];
    await this.runtime.refreshToolInventory();
  }
  changeAccount() { process.env[this.accountVariable] = 'account-b'; }
  changeReader() { this.runtime.options.acquisitionReaders![0]!.version = '2'; }
  changeSandbox() { this.backend.readingBoundary = 'changed-sandbox'; }
  legacyRoute() {
    this.store.transact(this.room, tx => { delete tx.room.executionMemory!.routes[0]!.pattern; });
  }
  get pending() { return this.engine.pending(this.room, this.task).filter(work => work.kind === 'assistance'); }
  get context() { return this.engine.view(this.room, this.task)!.context; }
  get memory() { return this.store.read(this.room).executionMemory; }

  private reply(request: Request): Response {
    const { workId, context } = JSON.parse(request.messages[1]!.content);
    if (workId.includes(':interpretation:')) return modelResponse({ type: 'interpretation', spec: {
      action: 'request', objective: '逐篇提取并保留出处', constraints: [], expectedOutputs: ['摘要和出处'],
      acceptanceCriteria: ['各篇齐备'], confidence: 1, clarification: null, references: [],
      decomposition: { kind: 'mapReduce', synthesis: '保持全部文档来源', partitions: this.urls.map((url, index) => ({
        id: 'doc-' + (index + 1), objective: this.structuredSources ? '逐篇提取第 ' + (index + 1) + ' 份' : '提取 ' + url,
        expectedOutput: this.output, ...(this.structuredSources ? { sourceIndices: [index + 1] } : {}),
      })) },
    } });
    if (workId.includes(':discussionSummary:')) return modelResponse({ type: 'answer', text: '保留全部已结算分片交给主笔' });
    if (workId.includes(':owner:')) {
      const results = context.discussion.results as { status: string; answer: string }[];
      const body = results.filter(item => item.status === 'success').map(item => item.answer).sort().join('\n');
      return modelResponse({ type: 'deliver', text: body, artifactIds: [], artifacts: [{ name: '报告.md', content: body }] });
    }
    assert(workId.includes(':assistance:'), 'Only existing execution roles may be dispatched');
    const url = context.resourceRequirements?.[0]?.resource.url ?? String(context.partition.objective).slice('提取 '.length);
    const web = toolMessages(request, 'web_fetch_result');
    const local = toolMessages(request, 'local_tool_result');
    const recorded = this.context.intents.find(work => work.id === workId)!;
    const experiences = toolMessages(request, 'shared_tool_experiences');
    const learned = experiences.some(message => message.content.includes('"id":"learned:'));
    const first = url === this.urls[0];
    const authSeed = this.mode === 'seed' && first;
    const webFetch = () => modelResponse({ type: 'web_fetch', url, format: 'auto' });
    if (!web.length && !local.length) {
      this.attempts.push({ id: workId, url, learned, observations: experiences.some(message => message.content.includes('"id":"read-observation:')) });
      if (learned && this.mode !== 'no-receipt' || first && ['success', 'sandbox-failure', 'wrong-book', 'page-incomplete', 'truncated'].includes(this.mode))
        return this.cli(url);
      return webFetch();
    }
    if (web.length && !local.length && authSeed) return this.cli(url);
    const receipt = savedAcquisitions(this.context).find(item => item.workId === recorded.id && item.status === 'acquired');
    if (!receipt && web.length < 2) return webFetch();
    assert(receipt, 'A successful fixture extraction must follow a real persisted source receipt');
    if (local.length) this.afterRead?.(workId);
    if (this.omitLast && url === this.urls.at(-1)) return modelResponse({ type: 'answer', status: 'failed', text: '文档已经取得，提取未完成' });
    const text = documentId(url) + ' 原文取证成功 ' + url;
    return modelResponse({ type: 'answer', status: 'success', text,
      artifacts: [{ name: documentId(url) + '.md', content: text, sourceItems: [
        { sourceDocId: documentId(url), sourceEvidenceId: receipt.id, status: '保存', text: '有来源的结果' },
      ] }] });
  }
  private cli(url: string) {
    return modelResponse({ type: 'runCli', executable: readerCommand, args: ['show', 'doc', url], execution: this.execution,
      ...(this.execution === 'host' ? { reason: '使用当前登录态读取指定文档' } : {}),
      ...(this.mode === 'timeout' ? { timeoutMs: 100 } : {}) });
  }
  async run(work?: Intent) {
    this.backend.settledTimeout = this.mode === 'timeout';
    await writeFile(join(this.dir, 'mode'), this.mode);
    const adapter = new OpenAICompatibleAdapter(this.config, { clock: () => this.at, transport: async (_url, init) => {
      this.requests++; this.at++;
      return this.reply(JSON.parse(String(init?.body)));
    } });
    const web = new CloudflareWebTools({ env: {}, transport: async input => {
      this.webReads++; this.at++;
      const url = String(input), hits = this.webHits.get(url) ?? 0;
      this.webHits.set(url, hits + 1);
      const first = url === this.urls[0] && hits === 0;
      if (first && this.mode === 'login-redirect') return new Response(null, { status: 302, headers: { location: 'https://www.yuque.com/login' } });
      if (first && this.mode === 'ordinary-redirect') return new Response(null, { status: 302, headers: { location: 'https://www.yuque.com/canonical' } });
      const body = first && ['seed', 'web-failure'].includes(this.mode) ? '<title>Login</title>' : readBody(url);
      return new Response(body, { headers: { 'content-type': 'text/markdown' } });
    } });
    let approvalError: string | undefined;
    const runner = new WorkRunner(this.engine, adapter, () => this.at, undefined, web, this.runtime, (context, observation) => {
      if (observation.phase !== 'local.approvalRequired') return;
      const operation = this.context.intents.find(item => item.id === context.workId)?.localOperations?.find(item => item.id === observation.operationId);
      if (operation?.status !== 'awaitingApproval' || operation.result) { approvalError = 'Expected a pending, unexecuted host operation'; return; }
      const result = this.engine.decideHostApproval(this.room, this.task, context.workId, observation.operationId, observation.approvalId,
        'approve', 'fixture-approval:' + ++this.approvalCount);
      if (!result.ok) approvalError = result.code;
      this.runtime.notifyWorkspace(`approval:${observation.operationId}`);
    });
    const result = await runner.runOne(this.room, this.task, work?.id);
    assert.equal(approvalError, undefined);
    return result;
  }
  async submit(pins?: string) {
    this.webHits.clear();
    const refresh = pins === '明确请求刷新' ? '请重新读取，' : '';
    const urls = this.urls.map((url, index) => pins && !(pins === '未提供正文版本' && index === 0)
      ? url + ' sha256:' + (pins === '正文版本' && index === 0 ? 'f'.repeat(64) : hash(readBody(url))) : url);
    const text = refresh + '请逐篇提取并保留出处\n' + urls.join('\n');
    const result = this.engine.submit(this.room, { id: 'exec-memory-' + ++this.sequence, text, intent: 'new' });
    assert(result.ok && result.taskId, result.code);
    this.task = result.taskId;
    assert(await this.run());
    assert(this.context.discussion?.mapReduce, 'Input analysis must open the actual partition queue');
  }
  async finish() {
    for (let step = 0; step < 25 && await this.run(); step++) { /* From interpretation to the original publish entry. */ }
    assert.equal(this.context.outcome, 'complete', JSON.stringify({ phase: this.engine.view(this.room, this.task)?.phase, reason: this.context.reason }));
    assert.equal(this.context.intents.filter(work => work.kind === 'check').length, 0);
    return this.context;
  }
  async seed(count = 2) {
    this.urls = partitionUrls.slice(0, count);
    this.mode = 'seed'; this.omitLast = count === 8;
    await this.submit();
    const context = await this.finish();
    this.mode = 'read'; this.omitLast = false;
    return context;
  }
}

export async function memoryAB(fixture: ExecutionMemoryFixture) {
  fixture.config.executionMemory = false;
  const start = fixture.requests;
  await fixture.submit('same');
  const off = await fixture.finish(), without = fixture.requests - start;
  fixture.config.executionMemory = true;
  const next = fixture.requests;
  await fixture.submit('same');
  const on = await fixture.finish(), withMemory = fixture.requests - next;
  return { off, on, without, withMemory };
}
