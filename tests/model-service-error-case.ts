import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from './helpers.js';
import { mapIntent } from './map-reduce-fixture.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import { taskHumanGate } from '../src/task/resilience.js';
import { verifyModelServiceErrorModel } from './model-service-error-model-fixture.js';

/** A real local HTTP provider. Only this external dependency returns synthetic errors. */
export class ModelErrorProvider {
  server!: Server; requests = 0; failures = 0; url = '';
  constructor(readonly status: number, readonly map = false) {}
  async open() {
    this.server = createServer(async (req, res) => {
      this.requests++;
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text), last = body.messages.at(-1);
      const context = JSON.parse(last.content).context;
      const success = this.map && (context.input || context.partition?.id === 'beta');
      res.writeHead(success ? 200 : this.status, { 'content-type': 'application/json' });
      if (success) res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(context.input
        ? { type: 'interpretation', spec: mapIntent() } : { type: 'answer', status: 'success', text: '已完成且必须保留的beta独立结果' }) } }] }));
      else {
        this.failures++;
        res.end(JSON.stringify({ error: { type: this.status === 403 ? 'permission_error' : 'invalid_request_error',
          message: 'private provider message with fixture-model-secret' } }));
      }
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }
  config() {
    const config = configuration(); config.inputAnalysis = { enabled: this.map };
    config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    config.resilience = { automaticTimeoutMs: 60_000, repairTimeoutMs: 10_000, cancelGraceMs: 1000 };
    config.models = { default: 'provider', services: { provider: { baseUrl: this.url, model: 'error-fixture', apiKeyEnv: 'ERROR_FIXTURE_KEY' } } };
    return config;
  }
  adapter(config = this.config()) { return new OpenAICompatibleAdapter(config, { env: { ERROR_FIXTURE_KEY: 'fixture-model-secret' } }); }
  async close() { if (this.server?.listening) await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

export class ModelServiceErrorCase {
  provider!: ModelErrorProvider; service!: WebService; server!: Server; runner!: WorkRunner;
  room = ''; task = ''; root = ''; url = ''; gateId = ''; failedWork = '';
  constructor(readonly id: string) {}
  async given(status = 403) {
    verifyModelServiceErrorModel();
    this.provider = await new ModelErrorProvider(status, this.id === 'BT_Y169').open();
    const config = this.provider.config(), adapter = this.provider.adapter(config);
    this.root = await mkdtemp(join(tmpdir(), 'squad-model-error-'));
    this.service = new WebService(config, join(this.root, 'team.sqlite'), adapter);
    await this.service.ready(); this.server = createWebServer(this.service);
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.room = this.service.createRoom('模型错误处理').id;
    this.task = this.service.engine.submit(this.room, { id: randomUUID(), text: '分别研究甲乙两个来源，保留出处后汇总' }).taskId!;
    assert(this.service.engine.send(this.room, this.task, { type: 'ARTIFACT', id: randomUUID(), at: Date.now(),
      artifact: { id: 'saved-before-error', name: 'saved.md', content: '错误发生前已保存的成果' } }).ok);
    this.runner = new WorkRunner(this.service.engine, adapter);
    if (this.id !== 'BT_Y168' && this.id !== 'BT_Y172') await this.receive();
  }
  c() { return this.service.engine.view(this.room, this.task)!.context; }
  async receive() {
    if (this.id === 'BT_Y169') {
      assert(await this.runner.runOne(this.room, this.task)); // Actual interpretation HTTP 200.
      const members = this.service.engine.pending(this.room, this.task).filter(w => w.kind === 'assistance');
      const beta = members.find(w => (w.payload.partition as { id: string }).id === 'beta')!;
      assert(await this.runner.runOne(this.room, this.task, beta.id)); // Preserve an actual independent success.
    }
    this.failedWork = this.service.engine.pending(this.room, this.task)[0]!.id;
    assert(await this.runner.runOne(this.room, this.task, this.failedWork));
    this.gateId = taskHumanGate(this.c())?.id ?? '';
  }
  async decide(decision: 'skip' | 'stop') {
    const gate = (this.service.snapshot(this.room).blockers ?? []).find(g => g.id === this.gateId)!;
    const response = await fetch(this.url + '/api/rooms/' + this.room + '/blocker-decision', {
      method: 'POST', headers: { origin: this.url, 'content-type': 'application/json' },
      body: JSON.stringify({ id: randomUUID(), taskId: this.task, blockerId: gate.id, blockerVersion: gate.version, actionId: decision }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  verifyError() {
    const gate = (this.service.snapshot(this.room).blockers ?? []).find(g => g.id === this.gateId)!;
    assert.equal(gate.title, '模型服务调用失败');
    assert.equal(gate.code, `MODEL_HTTP_${this.provider.status}`);
    assert(gate.question.includes(`HTTP ${this.provider.status}`));
    assert.deepEqual(gate.actions.map(a => a.id), ['skip', 'stop']);
    assert(!JSON.stringify(this.service.engine.store.read(this.room)).includes('fixture-model-secret'));
    assert(!JSON.stringify(this.service.engine.store.read(this.room)).includes('private provider message'));
  }
  verifyRestore() {
    const requests = this.provider.requests;
    this.service.engine.recover(this.room);
    assert.equal(taskHumanGate(this.c())?.id, this.gateId);
    assert.equal(this.service.engine.pending(this.room, this.task).length, 0);
    assert.equal(this.provider.requests, requests);
  }
  verifySkip() {
    assert.equal(this.c().discussion!.mapReduce!.queue!.find(p => p.workId === this.failedWork)!.status, 'cancelled');
    assert(this.c().discussion!.results.some(r => r.answer === '已完成且必须保留的beta独立结果'));
    assert.equal(this.provider.failures, 1);
    this.verifySaved();
  }
  verifyStop() { assert.equal(this.c().outcome, 'stopped'); assert.equal(this.provider.failures, 1); this.verifySaved(); }
  verifySaved() { assert(this.c().artifacts.some(a => a.id === 'saved-before-error' && a.content === '错误发生前已保存的成果')); }
  verifyTransient() { assert.equal(taskHumanGate(this.c()), undefined); assert(this.service.engine.pending(this.room, this.task).some(w => w.id === this.failedWork)); }
  async close() {
    await this.runner?.drainExecutions(1000);
    if (this.server?.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.service?.close(); await this.provider?.close();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
