import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { LocalRuntime } from '../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import type { RoomSnapshot, WebHostApproval, WebRoom } from '../src/web/contracts.js';
import type { LocalAction } from '../src/local-operation.js';
import { localConfig } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

export async function hostUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Host approval fixture timed out');
}
export class HostApprovalFixture {
  root = ''; source = ''; executable = ''; url = ''; taskId = ''; service!: WebService; server!: Server; runtime!: LocalRuntime; room!: WebRoom;
  requests: { messages: { role: string; content: string }[] }[] = [];
  action!: LocalAction;
  private previousToken = process.env.EXAMPLE_CLI_TOKEN;
  private previousModelKey = process.env.FIXTURE_MODEL_KEY;
  readonly token = 'fixture-cli-secret-' + randomUUID();
  readonly modelKey = 'fixture-model-secret-' + randomUUID();
  async open() {
    this.root = await mkdtemp(join(tmpdir(), 'squad-host-approval-')); this.source = join(this.root, 'source');
    await mkdir(this.source); this.executable = join(this.root, 'fixture-cli');
    await writeFile(this.executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('runs.txt', 'once\\n');
console.log(JSON.stringify({home:process.env.HOME,cwd:process.cwd(),modelSecret:!!process.env.FIXTURE_MODEL_KEY,auth:!!process.env.EXAMPLE_CLI_TOKEN}));
const token = process.env.EXAMPLE_CLI_TOKEN || '';
process.stdout.write(token.slice(0, 9));
setTimeout(() => { process.stdout.write(token.slice(9) + '\\n'); }, 5);
`, { mode: 0o755 });
    process.env.EXAMPLE_CLI_TOKEN = this.token; process.env.FIXTURE_MODEL_KEY = this.modelKey;
    this.action = { type: 'runCli', executable: this.executable, args: ['argument with spaces', '$(not-a-shell)'], execution: 'host', reason: '复用服务账号的终端登录态' };
    await this.start(); this.room = this.service.createRoom('宿主授权验证');
  }
  async start() {
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.root, 'runtime'), workspaceRoot: this.source, skillRoots: [], redact: [this.modelKey],
      backend: { available: false, async execute() { throw new Error('No automatic sandbox fallback'); } } });
    const config = localConfig(); config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
    const adapter = new OpenAICompatibleAdapter(config, { transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof this.requests[number]; this.requests.push(request);
      if (request.messages.some(m => m.role === 'user' && m.content.startsWith('{"type":"local_tool_result",'))) return modelResponse({ type: 'answer', text: '已处理真实命令回执' });
      return modelResponse(this.action);
    } });
    // Keep final checking independent of the scripted owner transport.
    this.service = new WebService(config, join(this.root, 'team.sqlite'), {
      execute: (work, signal, scope) => work.kind === 'check' ? Promise.resolve({ type: 'check', passed: true, gaps: [] }) : adapter.execute(work, signal, scope),
    }, undefined, false, this.runtime);
    await this.service.ready(); this.server = createWebServer(this.service);
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  route() { return `/api/rooms/${this.room.id}`; }
  submit() { const reply = this.service.submit(this.room.id, { id: randomUUID(), text: '执行命令并返回结果' }); this.taskId = reply.taskId!; return reply; }
  snapshot() { return this.service.snapshot(this.room.id); }
  approval() { return hostUntil(() => this.snapshot().hostApprovals ?? [], list => list.length === 1).then(list => list[0]!); }
  operation() { return this.service.engine.view(this.room.id, this.taskId)?.context.intents.flatMap(w => w.localOperations ?? [])[0]; }
  decisionData(a: WebHostApproval, decision: 'approve' | 'deny', id = randomUUID()) {
    return { id, taskId: a.taskId, workId: a.workId, operationId: a.operationId, approvalId: a.approvalId, decision };
  }
  async request(data: unknown, origin: string | null = this.url) {
    const response = await fetch(this.url + this.route() + '/host-approval', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() as unknown };
  }
  async complete() { return hostUntil(() => this.snapshot(), snapshot => snapshot.tasks.at(-1)?.outcome !== null); }
  async runs() { try { return await readFile(join(this.source, 'runs.txt'), 'utf8'); } catch { return ''; } }
  async assertSuccessfulRun() {
    const snapshot = await this.complete(); assert.equal(await this.runs(), 'once\n');
    const op = this.operation()!; assert.equal(op.status, 'succeeded'); assert.equal(op.result?.data.execution, 'host');
    assert(String(op.result?.data.stdout).includes(userInfo().homedir)); assert(String(op.result?.data.stdout).includes('"auth":true'));
    assert(String(op.result?.data.stdout).includes('"modelSecret":false')); assert(!JSON.stringify(snapshot).includes(this.token));
    const receipt = await this.runtime.journal.read(op.sessionId!); assert.equal(receipt?.phase, 'settled');
    const log = await readFile(join(this.root, 'runtime/logs', String(op.result?.data.logId)), 'utf8');
    assert(!log.includes(this.token)); assert(!log.includes(this.token.slice(0, 9))); assert(log.includes('[redacted]'));
  }
  savedRoom(): string {
    const db = new DatabaseSync(join(this.root, 'team.sqlite'), { readOnly: true });
    try { return String(db.prepare('SELECT data FROM rooms WHERE id=?').get(this.room.id)!.data); } finally { db.close(); }
  }
  async restart(savedRoom?: string) {
    await new Promise<void>(resolve => this.server.close(() => resolve())); await this.service.close(); await this.runtime.close();
    if (savedRoom !== undefined) {
      // Restore the committed crash-window snapshot; graceful teardown must not alter fault-injection evidence.
      const db = new DatabaseSync(join(this.root, 'team.sqlite'));
      try { db.prepare('UPDATE rooms SET data=? WHERE id=?').run(savedRoom, this.room.id); } finally { db.close(); }
    }
    await this.start();
  }
  async close() {
    if (this.server?.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.service?.close(); await this.runtime?.close();
    if (this.previousToken === undefined) delete process.env.EXAMPLE_CLI_TOKEN; else process.env.EXAMPLE_CLI_TOKEN = this.previousToken;
    if (this.previousModelKey === undefined) delete process.env.FIXTURE_MODEL_KEY; else process.env.FIXTURE_MODEL_KEY = this.previousModelKey;
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
