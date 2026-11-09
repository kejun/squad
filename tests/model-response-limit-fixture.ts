import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter, SqliteStore, WorkRunner } from '../src/index.js';
import { candidateJudgments, Harness } from './helpers.js';
import { regenerationConfig } from './model-regeneration-fixture.js';

export const privateBodyMarker = 'provider-private-body-不应持久化';
export type ResponseTransfer = '正确长度' | '无长度分块并拆分中文字符' | '无长度分块' | '夸大长度' | '压缩长度很小但解压超限' | '暂停';
export class ResponseLimitFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-response-limit-'));
  readonly store = new SqliteStore(join(this.directory, 'team.sqlite'));
  readonly server: Server;
  readonly requests: unknown[] = [];
  readonly evidence: { sentBytes: number; responseClosed: boolean; cleanup?: boolean } = { sentBytes: 0, responseClosed: false };
  h!: Harness;
  runner!: WorkRunner;
  body!: Buffer;
  limit!: number;
  label?: string;
  private response?: ServerResponse;
  private interval?: ReturnType<typeof setInterval>;
  private releaseStarted!: () => void;
  readonly started = new Promise<void>(resolve => { this.releaseStarted = resolve; });

  constructor(readonly kind: 'owner' | 'check', readonly transfer: ResponseTransfer, readonly overflow = false, readonly timeoutMs = 4000) {
    this.server = createServer(async (request, response) => {
      let incoming = '';
      for await (const chunk of request) incoming += String(chunk);
      this.requests.push(JSON.parse(incoming));
      this.response = response;
      const wire = transfer === '压缩长度很小但解压超限' ? gzipSync(this.body) : this.body;
      response.setHeader('content-type', 'application/json');
      if (transfer === '正确长度') response.setHeader('content-length', wire.length);
      if (transfer === '夸大长度') response.setHeader('content-length', wire.length * 2);
      if (transfer === '压缩长度很小但解压超限') {
        assert(wire.length < this.limit, 'compressed declaration must fit while decoded body exceeds the cap');
        response.setHeader('content-encoding', 'gzip'); response.setHeader('content-length', wire.length);
      }
      response.on('close', () => { this.evidence.responseClosed = true; if (this.interval) clearInterval(this.interval); });
      response.flushHeaders();
      if (transfer === '暂停') {
        response.write(wire.subarray(0, 24)); this.evidence.sentBytes = 24; this.releaseStarted(); return;
      }
      if (transfer === '压缩长度很小但解压超限') {
        response.end(wire); this.evidence.sentBytes = wire.length; this.releaseStarted(); return;
      }
      // Single-byte chunks deliberately split every UTF-8 character in the exact-boundary case.
      const chunkSize = transfer === '无长度分块并拆分中文字符' ? 1 : 256;
      let offset = 0;
      this.interval = setInterval(() => {
        const end = Math.min(offset + chunkSize, wire.length);
        response.write(wire.subarray(offset, end)); this.evidence.sentBytes += end - offset; offset = end;
        this.releaseStarted();
        if (offset === wire.length) { clearInterval(this.interval); response.end(); }
      }, transfer === '无长度分块并拆分中文字符' ? 1 : 3);
    });
  }
  async start() {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); assert(address && typeof address !== 'string');
    const config = regenerationConfig({ workTimeoutMs: this.timeoutMs });
    const service = config.models!.services.test!;
    service.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const content = this.overflow ? { type: 'answer', text: privateBodyMarker.repeat(2048) } : { type: 'answer', text: '完整中文结果：字节边界安全。' };
    // Prepare the candidate with the same public engine API used by regeneration acceptance.
    const provisional = new Harness(config);
    const output = this.kind === 'check' ? { type: 'check', criteriaResults: candidateJudgments(provisional.context().candidate) } : content;
    this.body = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      ...(this.overflow ? { padding: privateBodyMarker.repeat(2048) } : {}) }));
    this.limit = this.overflow ? 1024 : this.body.length;
    Object.assign(service, { maxResponseBytes: this.limit });
    this.h = new Harness(config, this.store);
    if (this.kind === 'check') {
      const owner = this.h.claim('owner');
      assert(this.h.event({ type: 'DELIVER', workId: owner.id, text: '完整候选', artifactIds: [] }).ok);
      // Match actual acceptance IDs after the candidate exists, preserving identical byte count setup.
      const result = { type: 'check', criteriaResults: candidateJudgments(this.h.context().candidate) };
      this.body = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        ...(this.overflow ? { padding: privateBodyMarker.repeat(2048) } : {}) }));
    }
    const adapter = new OpenAICompatibleAdapter(config, { clock: () => this.h.now });
    this.runner = new WorkRunner(this.h.engine, adapter, () => this.h.now);
    return this;
  }
  async run() { return this.runner.runOne(this.h.room, this.h.task); }
  async stop() { assert(this.h.event({ type: 'STOP' }).ok); }
  async waitClosed() {
    const end = Date.now() + 1000;
    while (!this.evidence.responseClosed && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert(this.evidence.responseClosed, 'actual provider response must close after read cancellation');
  }
  async close() {
    if (this.interval) clearInterval(this.interval);
    this.response?.destroy();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.store.close(); rmSync(this.directory, { recursive: true, force: true }); this.evidence.cleanup = true;
  }
  async closeWithEvidence() {
    const context = this.h.context();
    const proof = { transfer: this.transfer, kind: this.kind, limit: this.limit, bodyBytes: this.body.length,
      requests: this.requests.length, phase: this.h.view().phase, outcome: context.outcome, reason: context.reason,
      retries: context.usage.retries, published: !!context.publishedDelivery, artifacts: context.artifacts.length,
      inflight: context.intents.filter(work => work.status === 'inflight').length,
      privateBodyRetained: JSON.stringify(this.store.read(this.h.room)).includes(privateBodyMarker),
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
      sourceHashes: Object.fromEntries(['src/model-adapter.ts', 'src/model-env.ts', 'src/types.ts'].map(path =>
        [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) };
    await this.close();
    const root = process.env.MODEL_RESPONSE_EVIDENCE ?? 'reports/kej-105'; mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${this.kind}-${this.label ?? this.transfer}-${this.overflow}.json`), JSON.stringify({ ...proof, evidence: this.evidence }, null, 2));
  }
}
