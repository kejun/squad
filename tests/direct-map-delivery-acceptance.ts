import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from './helpers.js';
import { parsedIntent } from './input-intent-fixture.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WebService } from '../src/web/service.js';
import { CloudflareWebTools } from '../src/web-tools.js';
import { createWebServer } from '../src/web/http.js';
import { deletionUntil } from './room-deletion-acceptance.js';
import type { RoomSnapshot } from '../src/web/contracts.js';

/** Native HTTP provider boundary. The real adapter, parallel runner and SQLite remain in use. */
export class DirectMapProvider {
  server!: Server; url = ''; ownerCalls = 0; checks = 0; summaries = 0; requests = 0;
  readonly children: string[] = []; readonly bodies: string[] = [];
  constructor(readonly legacyAnswer = false, readonly webSource = false, readonly checkRepair = false) {}
  checkToolRequests = 0; checkModelRequests = 0;
  checkFault?: string;
  failAfterRead = false; networkFailureSent = false;
  webReads = 0;
  async open() {
    this.server = createServer(async (req, res) => {
      if (req.url === '/source') { this.webReads++; res.writeHead(200, { 'content-type': 'text/markdown' }); res.end('# doc-7\n新取得的普通网页正文'); return; }
      let body = ''; for await (const chunk of req) body += chunk;
      this.requests++; this.bodies.push(body);
      const messages = JSON.parse(body).messages;
      const context = JSON.parse(messages.find((m: { role: string; content: string }) => m.role === 'user' && m.content.startsWith('{"workId":')).content).context;
      let output: unknown;
      if (context.requirements) {
        this.checkModelRequests++;
        if (this.checkFault) {
          this.checks++; res.writeHead(200, { 'content-type': 'application/json' });
          res.end(this.checkFault === 'invalid-json' ? '{broken' : this.checkFault === 'invalid-body' ? 'null'
            : JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{}] } }] })); return;
        }
        const acquired = messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content.includes('"type":"web_fetch_result"'))
          || context.evidence.some((source: { stdout?: string }) => source.stdout?.includes('新取得的普通网页正文'));
        if (this.checkRepair && !acquired) {
          this.checkToolRequests++;
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'web_fetch', url: 'https://docs.example.test/current' }) } }] })); return;
        }
        if (this.failAfterRead && !this.networkFailureSent) {
          this.networkFailureSent = true; res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'temporary' } })); return;
        }
        this.checks++;
        assert(!JSON.stringify(context).includes('partitionRecoveries'));
        assert(context.requirements.every((r: { id: string }) => !r.id.startsWith('map-recovery:')));
        output = { type: 'check', criteriaResults: context.requirements.map((r: { id: string }) => ({ criterionId: r.id, status: 'passed',
          source: { id: 'optional-unlisted-source', quote: '下游检查的非逐字说明' } })),
          ...(this.checkRepair ? { repair: { text: '检查员已直接补充真实网页资料并交付。', artifacts: [{ name: '修正汇总.md', content: 'doc-7 可用；已补充新取得的普通网页正文；其他资料缺口已声明。' }] } } : {}) };
      } else if (context.input) {
        output = { type: 'interpretation', spec: parsedIntent('request', { objective: '汇总可用资料并列出失败项',
          constraints: [], expectedOutputs: ['汇总.md'], acceptanceCriteria: ['保留可用结果并列出失败项'],
          decomposition: { kind: 'mapReduce', synthesis: '汇总可用结果并列出未取得的资料',
            partitions: Array.from({ length: 8 }, (_, n) => ({ id: `doc-${n + 1}`, objective: `读取doc-${n + 1}`, expectedOutput: '可用正文或明确失败' })) } }) };
      } else if (context.partition) {
        const id = context.partition.id as string; this.children.push(id);
        output = { type: 'answer', status: id === 'doc-7' ? 'success' : 'failed',
          text: id === 'doc-7' ? 'doc-7 已保存的可用正文' : this.legacyAnswer ? '' : `FAILURE_BODY_${id}`,
          artifacts: id !== 'doc-7' && this.legacyAnswer ? { ignored: `FAILED_FILE_${id}` }
            : [{ name: id + '.md', content: id === 'doc-7' ? 'doc-7 可用文件' : `FAILED_FILE_${id}` }] };
      } else if (context.discussion?.status === 'summarizing') {
        this.summaries++; output = { type: 'answer', status: 'partial', text: 'doc-7 可用，其他七片失败且交付为空。' };
      } else {
        if (this.webSource && !messages.some((m: { role: string; content: string }) => m.role === 'user' && m.content.includes('\"type\":\"web_fetch_result\"'))) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'web_fetch', url: 'https://docs.example.test/current' }) } }] })); return;
        }
        this.ownerCalls++;
        const results = context.discussion.results as { status: string; answer: string; artifactIds: string[] }[];
        assert.equal(results.filter(r => r.status === 'failed').length, 7);
        assert(results.filter(r => r.status === 'failed').every(r => r.answer === '' && r.artifactIds.length === 0));
        assert(!JSON.stringify(context.artifacts).includes('FAILED_FILE_'));
        assert(!body.includes('partitionRecoveries'), 'The prompt must no longer request the removed protocol');
        output = { type: this.legacyAnswer ? 'answer' : 'deliver', text: 'doc-7 已汇总，其余七份资料未取得并列入失败项。', artifactIds: [],
          artifacts: [{ name: '汇总.md', content: '# 可用结果\n\ndoc-7 已保存的可用正文\n\n# 失败项\n\ndoc-1、doc-2、doc-3、doc-4、doc-5、doc-6、doc-8 未取得正文。' }],
          partitionRecoveries: [{ discussionId: context.discussion.id, partitionId: 'doc-7', sourceOperationIds: [] }] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`; return this;
  }
  config() {
    const config = configuration({ ordinary: 80, checks: 4, retries: 2 }); config.inputAnalysis = { enabled: true };
    config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 10_000, cancelGraceMs: 1000 };
    config.models = { default: 'fixture', services: { fixture: { baseUrl: this.url, model: 'direct-map-fixture' } } };
    return config;
  }
  verify(snapshot: RoomSnapshot) {
    const task = snapshot.tasks.find(t => t.id === snapshot.activeTaskId) ?? snapshot.tasks.at(-1)!;
    assert.equal(task.outcome, 'complete'); assert.equal(this.ownerCalls, 1); assert.equal(this.checks, 1); assert.equal(this.summaries, 1);
    assert.equal(this.children.length, 8); assert.equal(new Set(this.children).size, 8);
    assert(!JSON.stringify(snapshot).includes('MAP_RECOVERY_'));
  }
  async close() {
    if (this.server?.listening) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  }
}

export async function directMapEngineAcceptance(legacyAnswer = false, webSource = false, checkRepair = false, checkFault?: string, failAfterRead = false) {
  const root = await mkdtemp(join(tmpdir(), 'squad-direct-map-'));
  const provider = await new DirectMapProvider(legacyAnswer, webSource, checkRepair).open();
  if (checkFault) provider.checkFault = checkFault;
  provider.failAfterRead = failAfterRead;
  let service: WebService | undefined, server: Server | undefined;
  try {
    const config = provider.config();
    if (checkFault) { config.limits.checks = Number.MAX_SAFE_INTEGER; config.limits.retries = Number.MAX_SAFE_INTEGER; }
    const tools = webSource || checkRepair ? new CloudflareWebTools({ env: {}, transport: (_url, init) => globalThis.fetch(provider.url.replace('/v1', '/source'), init) }) : undefined;
    service = new WebService(config, join(root, 'team.sqlite'), new OpenAICompatibleAdapter(config), tools);
    await service.ready(); server = createWebServer(service);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const create = await fetch(origin + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const room = await create.json() as { id: string };
    const response = await fetch(origin + '/api/rooms/' + room.id + '/messages', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'direct-map-request', text: '分别读取八份资料，汇总可用内容并列出失败项。' }) });
    assert.equal(response.status, 200);
    const snapshot = await deletionUntil(() => service!.snapshot(room.id), value => value.tasks.some(t => t.outcome !== null), 'ordinary map completion');
    const c = service.engine.view(room.id, snapshot.tasks.at(-1)!.id)!.context;
    if (checkFault) {
      assert.equal(c.outcome, 'partial'); assert.equal(provider.checks, 2); assert.equal(c.usage.retries, 1);
      assert.equal(provider.ownerCalls, 1); assert.equal(c.candidate?.deliveryIssue?.code, 'DELIVERY_CHECK_FAILED');
      assert(!c.intents.some(work => work.status === 'pending' && work.kind !== 'cancel'));
    } else provider.verify(snapshot);
    assert.equal(c.discussion!.results.filter(r => r.status === 'failed').length, 7);
    assert(c.discussion!.results.filter(r => r.status === 'failed').every(r => r.answer === '' && r.artifactIds.length === 0));
    assert(c.intents.every(w => !w.outputRepair));
    assert(c.discussion!.mapReduce!.queue!.every(p => !Reflect.has(p, 'resolution')));
    if (checkRepair) {
      assert.equal(provider.checkToolRequests, 1); assert.equal(provider.webReads, 1);
      assert(c.candidate!.text.includes('检查员已直接补充'));
      assert(c.artifacts.some(a => c.candidate!.artifactIds.includes(a.id) && a.content.includes('新取得的普通网页正文')));
      assert.equal(c.intents.filter(w => w.kind === 'check').length, 1);
      assert(!c.intents.some(w => w.payload.deliveryRevision));
      if (failAfterRead) { assert(provider.networkFailureSent); assert.equal(c.usage.retries, 1); }
    }
    return { outcome: c.outcome, ownerRequests: provider.ownerCalls, checkRequests: provider.checkModelRequests, checkWorks: c.intents.filter(work=>work.kind==='check').length, totalModelRequests: provider.requests, children: provider.children,
      legacyAnswerIgnored: legacyAnswer, webReads: provider.webReads, boundary: 'Native model HTTP -> adapter/runner -> SQLite -> public Web API, controlled provider content' };
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await service?.close(); await provider.close(); await rm(root, { recursive: true, force: true });
  }
}
