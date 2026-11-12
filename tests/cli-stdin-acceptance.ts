import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fstatSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { identityAlive } from '../src/local-cli.js';
import type { Intent } from '../src/types.js';
import type { LocalAction } from '../src/local-operation.js';
import { LocalFixture } from './local-tools-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import type { WebHostApproval } from '../src/web/contracts.js';

const binary = Buffer.from([0, 255, 128, 65, 10, 0, 32]);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const inputPath = '.tmp/input.bin';
function image(): Buffer {
  const letters: Record<string, string[]> = { H: ['10001','10001','10001','11111','10001','10001','10001'],
    E: ['11111','10000','10000','11110','10000','10000','11111'], L: ['10000','10000','10000','10000','10000','10000','11111'],
    O: ['01110','10001','10001','10001','10001','10001','01110'] };
  const scale = 14, pad = 40, word = 'HELLO', width = 29 * scale + pad * 2, height = 7 * scale + pad * 2;
  const bytes = Buffer.alloc(width * height, 255);
  [...word].forEach((letter, at) => letters[letter]!.forEach((row, y) => [...row].forEach((bit, x) => {
    if (bit === '1') for (let dy = 0; dy < scale; dy++) bytes.fill(0,
      (pad + y * scale + dy) * width + pad + (at * 6 + x) * scale,
      (pad + y * scale + dy) * width + pad + (at * 6 + x + 1) * scale);
  })));
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), bytes]);
}
export class CliStdinAcceptance {
  local?: LocalFixture;
  host?: HostApprovalFixture;
  work?: Intent;
  approval?: WebHostApproval;
  kind = '';
  rejected = false;
  original?: Buffer;
  async prepareOcr() {
    this.local = await LocalFixture.create();
    this.original = image();
    await mkdir(join(this.local.source, '.tmp'), { recursive: true });
    await writeFile(join(this.local.source, '.tmp/input.pgm'), this.original);
  }
  async recognize() {
    const f = this.local!;
    f.replies.push({ type: 'runCli', executable: 'tesseract', args: ['stdin', 'stdout', '--psm', '7', '-l', 'eng'],
      stdin: { path: '.tmp/input.pgm' }, execution: 'sandbox' }, { type: 'answer', text: '已识别 HELLO' });
    const work = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    await f.runner().runOne(f.h.room, f.h.task, work.id);
    this.work = f.h.context().intents.find(saved => saved.id === work.id)!;
  }
  assertOcr() {
    const f = this.local!, op = this.work!.localOperations?.[0];
    assert.equal(op?.status, 'succeeded'); assert.equal(String(op.result?.data.stdout).trim(), 'HELLO');
    assert.equal(f.backend.calls.length, 1);
    assert.equal(f.requests[0]!.messages[0]!.role, 'system');
    assert(f.requests[0]!.messages[0]!.content.includes('stdin'), 'the model must receive the stdin contract before choosing');
    const inventory = f.requests[0]!.messages.map(message => { try { return JSON.parse(message.content); } catch { return null; } })
      .find(value => value?.type === 'tool_inventory');
    assert(inventory.interfaces.find((item: { type: string; input: string }) => item.type === 'runCli').input.includes('stdin'));
    assert.throws(() => fstatSync(f.backend.calls[0]!.stdinFd!), { code: 'EBADF' }, 'the temporary input descriptor must close after settlement');
  }
  async assertImageRetained() { assert.deepEqual(await readFile(join(this.local!.source, '.tmp/input.pgm')), this.original); }
  async prepareInvalid(kind: string) {
    this.kind = kind;
    if (['绝对路径', '父目录穿越'].includes(kind)) return;
    this.local = await LocalFixture.create();
    if (kind === '指向工作区外的符号链接') {
      await writeFile(join(this.local.root, 'outside.txt'), 'outside-private-content');
      await symlink(join(this.local.root, 'outside.txt'), join(this.local.source, 'input'));
    }
  }
  async rejectInvalid() {
    const path = this.kind === '绝对路径' ? '/outside' : this.kind === '父目录穿越' ? '../outside'
      : this.kind === '私有配置文件' ? '.env' : this.kind === '目录' ? '.' : 'input';
    const action: LocalAction = { type: 'runCli', executable: 'node', args: ['-e', "console.log(require('node:fs').readFileSync(0).toString())"], stdin: { path }, execution: 'sandbox' };
    if (!this.local) {
      const m = new LocalModel(); assert.equal(m.request(action).code, 'INVALID_LOCAL_REQUEST'); assert.equal(m.op, undefined); this.rejected = true; return;
    }
    const f = this.local; f.replies.push(action, { type: 'answer', text: '标准输入被拒绝' });
    const work = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    await f.runner().runOne(f.h.room, f.h.task, work.id);
    const op = f.h.context().intents.find(saved => saved.id === work.id)?.localOperations?.[0];
    assert.equal(op?.status, 'failed');
    assert(['CLI_STDIN_INVALID', 'CLI_STDIN_PATH_ESCAPE', 'WORKSPACE_PATH_ESCAPE'].includes(op.result!.code), op.result!.code);
    assert.equal(f.backend.calls.length, 0); assert(!JSON.stringify(op.result).includes('outside-private-content'));
    this.rejected = true;
  }
  async prepareHost(long = false) {
    const f = this.host = new HostApprovalFixture(); await f.open();
    await mkdir(join(f.source, '.tmp'), { recursive: true }); await writeFile(join(f.source, inputPath), binary);
    await writeFile(f.executable, `#!/usr/bin/env node
const fs = require('node:fs'); const crypto = require('node:crypto');
fs.appendFileSync('runs.txt', 'once\\n'); const input = fs.readFileSync(0);
console.log(JSON.stringify({bytes: input.length, sha256: crypto.createHash('sha256').update(input).digest('hex')}));
${long ? 'setInterval(() => {}, 1000);' : ''}
`, { mode: 0o755 });
    f.action = { type: 'runCli', executable: f.executable, args: [], execution: 'host', reason: '读取工作区输入', stdin: { path: inputPath } };
    f.submit(); this.approval = await f.approval();
  }
  async decideHost(decision: string, change: string) {
    const f = this.host!;
    if (change === '输入替换为外部链接') { await writeFile(join(f.root, 'outside-input'), 'outside-private-input'); await unlink(join(f.source, inputPath)); await symlink(join(f.root, 'outside-input'), join(f.source, inputPath)); }
    if (change === '内容改变') await writeFile(join(f.source, inputPath), Buffer.from([1, 254, 127, 66, 11, 1, 33]));
    if (decision === '明确批准') { assert.equal((await f.request(f.decisionData(this.approval!, 'approve'))).status, 200); await f.complete(); }
  }
  async assertHost(result: string) {
    const f = this.host!, plan = f.operation()!.approval!.plan;
    assert.deepEqual(plan.stdin, { path: inputPath, bytes: binary.length, sha256: sha(binary) });
    assert.deepEqual(this.approval!.stdin, plan.stdin, 'the current approval API must expose the exact input fingerprint');
    if (result === '零次启动') { assert.equal(await f.runs(), ''); assert.equal(f.operation()!.status, 'awaitingApproval'); return; }
    if (result === '拒绝越界替换且零次启动') { assert.equal(await f.runs(), ''); assert.equal(f.operation()!.result?.code, 'CLI_STDIN_PATH_ESCAPE'); return; }
    if (result === '拒绝旧批准且零次启动') { assert.equal(await f.runs(), ''); assert.equal(f.operation()!.result?.code, 'HOST_APPROVAL_STALE'); return; }
    assert.equal(await f.runs(), 'once\n'); assert.equal(f.operation()!.status, 'succeeded');
    assert.deepEqual(JSON.parse(String(f.operation()!.result!.data.stdout)), { bytes: binary.length, sha256: sha(binary) });
  }
  async startLong() {
    await this.prepareHost(true); const f = this.host!;
    assert.equal((await f.request(f.decisionData(this.approval!, 'approve'))).status, 200);
    await hostUntil(() => f.runs(), runs => runs === 'once\n');
  }
  async cancel() {
    const f = this.host!; f.service.stop(f.room.id, f.taskId, 'cancel-stdin');
    await hostUntil(() => f.operation(), op => op?.result?.code === 'cancelled');
  }
  async assertCancelled() {
    const f = this.host!, op = f.operation()!, journal = await f.runtime.journal.read(op.sessionId!);
    assert.equal(op.result?.code, 'cancelled'); assert.equal(op.status, 'uncertain', 'process exit must not claim arbitrary host effects are known'); assert.equal(journal?.phase, 'settled'); assert(journal.identity);
    assert.equal(await identityAlive(journal.identity), false);
    assert.deepEqual(await readdir(join(f.root, 'runtime/stdin')), []);
  }
  async assertNoInputEof() {
    const f = this.local = await LocalFixture.create();
    f.replies.push({ type: 'runCli', executable: 'node', args: ['-e', "console.log(require('node:fs').readFileSync(0).length)"] }, { type: 'answer', text: '输入已结束' });
    const work = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    await f.runner().runOne(f.h.room, f.h.task, work.id);
    const op = f.h.context().intents.find(saved => saved.id === work.id)!.localOperations![0]!;
    assert.equal(op.status, 'succeeded'); assert.equal(String(op.result!.data.stdout).trim(), '0');
  }
  async close() { await this.local?.close(); await this.host?.close(); }
}
