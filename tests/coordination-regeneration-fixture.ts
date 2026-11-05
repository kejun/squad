import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision, Intent, TaskContext, TeamConfig } from '../src/index.js';
import { WebService } from '../src/web/service.js';
import { RegenerationFixture, regenerationConfig, type CapturedModelRequest } from './model-regeneration-fixture.js';

export const coordinationQuestion = '请核对恢复路径';
export const realHumanQuestion = '请确认使用生产环境还是测试环境？';
export function assistDecision(target: string): Decision {
  return { action: 'assist', target, question: coordinationQuestion, expected: '证据与限制', reason: '需要独立核对' };
}
export const decisionOutput = (decision: Decision) => ({ type: 'decision', decision });

/** Real engine, claim transaction, runner and adapter; only provider completions are scripted. */
export class CoordinationFixture {
  readonly repair: RegenerationFixture;
  constructor(readonly owner = 'A', limits: Partial<TeamConfig['limits']> = {}, sqlite = false, blocked = true) {
    this.repair = new RegenerationFixture('owner', limits, sqlite);
    if (owner !== 'A') assert(this.h.event({ type: 'HANDOFF', owner }).ok);
    if (blocked) assert(this.h.event({ type: 'BLOCKED', reason: '需要协调独立核对' }).ok);
    this.repair.fallback = decisionOutput({ action: 'continue', reason: '继续当前目标' });
  }
  get h() { return this.repair.h; }
  get context() { return this.h.context(); }
  get requests() { return this.repair.requests; }
  get repairs() { return this.repair.repairs; }
  get work(): Intent {
    const work = this.context.intents.filter(item => item.kind === 'facilitator').at(-1);
    assert(work, '当前任务应保存协调意图'); return work;
  }
  get requestContexts(): Record<string, unknown>[] {
    return this.requests.map(request => JSON.parse(request.messages.find(message => message.role === 'user')!.content).context);
  }
  invalidThenCorrected(invalidTarget: string, action: string, target: string) {
    const corrected = action === 'continue' ? { action: 'continue' as const, reason: '继续当前目标' } : assistDecision(target);
    this.repair.replies = [decisionOutput(assistDecision(invalidTarget)), decisionOutput(corrected)];
  }
  continueInvalid() { this.repair.fallback = decisionOutput(assistDecision(this.owner)); }
  async run() { return this.repair.run(); }
  claim() { return this.h.claim('facilitator'); }
  sendSelfDecision(stale = false) {
    const work = this.work;
    return this.h.event({ type: 'COORDINATE', decision: assistDecision(this.owner), workId: work.id,
      fence: { epoch: work.epoch, goalVersion: stale ? work.goalVersion - 1 : work.goalVersion } });
  }
  /** Reproduce only the old input shape; no expected execution result is written. */
  async prepareLegacyWork(restart: boolean) {
    if (restart) this.claim();
    const workId = this.work.id;
    this.repair.currentStore.transact(this.h.room, transaction => {
      const stored = transaction.room.tasks[this.h.task] as { snapshot: { context: TaskContext } };
      const work = stored.snapshot.context.intents.find(item => item.id === workId)!;
      delete work.payload.owner;
    });
    assert.equal(this.work.payload.owner, undefined);
    if (restart) await this.repair.reopen();
    this.repair.beforeResponse = () => {
      // The adapter has already received the claimed work. Read the independent committed store now.
      const stored = this.repair.currentStore.read(this.h.room).tasks[this.h.task] as { snapshot: { context: TaskContext } };
      const saved = stored.snapshot.context.intents.find(item => item.id === workId)!;
      assert.equal(saved.status, 'inflight'); assert.equal(saved.payload.owner, 'B');
    };
    this.repair.fallback = decisionOutput(assistDecision('A'));
  }
  close() { this.repair.close(); }
}

export function assertRepairWait(reason: string) {
  assert(/[\u4e00-\u9fff]/u.test(reason), reason);
  assert(reason.includes('修正'), reason);
  assert(/继续|补充|调整|重试|选择|指定/u.test(reason), reason);
}

/** Real HTTP provider + WebService/SQLite projection, with no browser or user data. */
export class CoordinationWebFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-web-coordination-'));
  readonly requests: CapturedModelRequest[] = [];
  readonly server: Server;
  service!: WebService;
  room = '';
  task = '';
  private closed = false;
  private constructor() {
    this.server = createServer(async (request, response) => {
      try {
        let body = ''; for await (const chunk of request) body += chunk;
        const captured = JSON.parse(body) as CapturedModelRequest; this.requests.push(captured);
        const context = JSON.parse(captured.messages.find(message => message.role === 'user')!.content).context as { owner?: string };
        const isFacilitator = captured.messages[0]!.content.includes('executing facilitator work');
        const output = isFacilitator ? decisionOutput(assistDecision(context.owner ?? 'A')) : { type: 'blocked', reason: '请协调独立核对' };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
      } catch {
        response.writeHead(500); response.end('Controlled provider could not decode request');
      }
    });
  }
  static async create() {
    const fixture = new CoordinationWebFixture();
    await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
    const config = regenerationConfig({ retries: 2 });
    config.models!.services.test!.baseUrl = 'http://127.0.0.1:' + (fixture.server.address() as AddressInfo).port + '/v1';
    config.skillSearch = { enabled: false }; config.webTools = { enabled: false }; config.localTools = { enabled: false };
    fixture.service = new WebService(config, join(fixture.directory, 'team.sqlite'));
    fixture.room = fixture.service.createRoom('协调自动修正').id;
    return fixture;
  }
  async run() {
    const result = this.service.submit(this.room, { id: 'coordination-self', text: '形成一份可检查方案' });
    this.task = result.taskId!;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (this.service.snapshot(this.room).tasks[0]?.phase === 'waitingHuman') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('协调自动修正未在3秒内进入等待人工');
  }
  get snapshot() { return this.service.snapshot(this.room); }
  async close() {
    if (this.closed) return; this.closed = true;
    await this.service?.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    rmSync(this.directory, { recursive: true, force: true });
  }
}
