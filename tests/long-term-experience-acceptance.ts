import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import { CloudflareWebTools } from '../src/web-tools.js';
import { ControlledProcessBackend, localConfig } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { partitionUrls } from './partition-resilience-model-fixture.js';
import type { Intent } from '../src/types.js';
import { savedAcquisitions } from '../src/resource-acquisition.js';

const readBody = (url: string) => '原文和确切的引用 ' + new URL(url).pathname.slice(1);
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const expected = '输出摘要与来源地址';
const documentId = (url: string) => new URL(url).pathname.slice(1);

type Request = { messages: { role: string; content: string }[] };
type Attempt = { id: string; url: string; learned: boolean };
type Mode = 'seed' | 'read' | 'contrary';

function toolMessages(request: Request, type: string) {
  return request.messages.filter(message => message.role === 'user' && message.content.includes('"type":"' + type + '"'));
}

export class ExecutionMemoryFixture {
  readonly config = localConfig();
  readonly backend = new ControlledProcessBackend();
  private sequence = 0;
  private at = 1000;
  private runtime!: LocalRuntime;
  store!: SqliteStore;
  engine!: TeamEngine;
  room = 'execution-memory';
  task!: string;
  urls = partitionUrls.slice(0, 2);
  mode: Mode = 'seed';
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
      const source = join(fixture.dir, 'source');
      await mkdir(source);
      await writeFile(join(source, 'memory-reader.mjs'), [
        'const [url, id, mode] = process.argv.slice(2)',
        'const body = mode === "contrary" ? "<title>Login</title>" : "原文和确切的引用 " + new URL(url).pathname.slice(1)',
        'console.log(JSON.stringify({ id, body }))',
      ].join('\n'));
      fixture.runtime = await LocalRuntime.create({ dataRoot: join(fixture.dir, 'runtime'), workspaceRoot: source, skillRoots: [],
        backend: fixture.backend, cliCatalog: [{ command: 'node', description: 'Registered document reader', domains: ['docs.example.com'] }],
        catalogRefreshIntervalMs: 0, clock: () => fixture.at,
        acquisitionReaders: [{ id: 'memory-reader', version: '1', command: 'node', format: 'json-document', argsPrefix: ['memory-reader.mjs'],
          resource: { kind: 'url-argument', index: 1 }, documentIdArgument: 2 }],
      });
      fixture.open();
      return fixture;
    } catch (error) { await fixture.close(); throw error; }
  }
  open() {
    this.store?.close();
    this.store = new SqliteStore(join(this.dir, 'team.sqlite'));
    this.engine = new TeamEngine(this.store, this.config, () => this.at, undefined, () => this.runtime.toolInventory());
  }
  async close() {
    await this.runtime?.close();
    this.store?.close();
    await rm(this.dir, { recursive: true, force: true });
  }
  async changeCatalog() {
    this.runtime.options.cliCatalog = [{ command: 'node', description: 'Updated reader', domains: ['docs.example.com'] }];
    await this.runtime.refreshToolInventory();
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
        id: 'doc-' + (index + 1), objective: '提取 ' + url, expectedOutput: this.output,
      })) },
    } });
    if (workId.includes(':discussionSummary:')) return modelResponse({ type: 'answer', text: '保留全部已结算分片交给主笔' });
    if (workId.includes(':owner:')) {
      const results = context.discussion.results as { status: string; answer: string }[];
      const body = results.filter(item => item.status === 'success').map(item => item.answer).sort().join('\n');
      return modelResponse({ type: 'deliver', text: body, artifactIds: [], artifacts: [{ name: '报告.md', content: body }] });
    }
    assert(workId.includes(':assistance:'), 'Only existing execution roles may be dispatched');
    const url = String(context.partition.objective).slice('提取 '.length);
    const web = toolMessages(request, 'web_fetch_result');
    const local = toolMessages(request, 'local_tool_result');
    const recorded = this.context.intents.find(work => work.id === workId)!;
    const learned = toolMessages(request, 'shared_tool_experiences').some(message => message.content.includes('"id":"learned:'));
    const authSeed = this.mode === 'seed' && url === partitionUrls[0];
    if (!web.length && !local.length) {
      this.attempts.push({ id: workId, url, learned });
      if (learned) return this.cli(url, this.mode);
      return modelResponse({ type: 'web_fetch', url, format: 'auto' });
    }
    if (web.length && !local.length && authSeed) return this.cli(url);
    if (local.length && !web.length && this.mode === 'contrary') return modelResponse({ type: 'web_fetch', url, format: 'auto' });
    const receipt = savedAcquisitions(this.context).find(item => item.workId === recorded.id && item.status === 'acquired');
    assert(receipt, 'A successful fixture extraction must follow a real persisted source receipt');
    if (local.length) this.afterRead?.(workId);
    if (this.omitLast && url === this.urls.at(-1)) return modelResponse({ type: 'answer', status: 'failed', text: '文档已经取得，提取未完成' });
    const text = documentId(url) + ' 原文取证成功 ' + url;
    return modelResponse({ type: 'answer', status: 'success', text,
      artifacts: [{ name: documentId(url) + '.md', content: text, sourceItems: [
        { sourceDocId: documentId(url), sourceEvidenceId: receipt.id, status: '保存', text: '有来源的结果' },
      ] }] });
  }
  private cli(url: string, mode = 'read') {
    return modelResponse({ type: 'runCli', executable: 'node', args: ['memory-reader.mjs', url, documentId(url), mode], execution: 'sandbox' });
  }
  async run(work?: Intent) {
    const adapter = new OpenAICompatibleAdapter(this.config, { clock: () => this.at, transport: async (_url, init) => {
      this.requests++; this.at++;
      return this.reply(JSON.parse(String(init?.body)));
    } });
    const web = new CloudflareWebTools({ env: {}, transport: async input => {
      this.webReads++; this.at++;
      const url = String(input);
      const body = this.mode === 'seed' && url === partitionUrls[0] ? '<title>Login</title>' : readBody(url);
      return new Response(body, { headers: { 'content-type': 'text/markdown' } });
    } });
    const runner = new WorkRunner(this.engine, adapter, () => this.at, undefined, web, this.runtime);
    return runner.runOne(this.room, this.task, work?.id);
  }
  async submit(pins?: string) {
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
