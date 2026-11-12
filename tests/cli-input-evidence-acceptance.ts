import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';
import type { Intent } from '../src/types.js';
import type { LocalAction } from '../src/local-operation.js';
import { assertFixedCheckRejectsAddedStdin } from './cli-input-evidence-model-fixture.js';
import { LocalFixture } from './local-tools-fixture.js';
import { hostUntil } from './host-approval-fixture.js';
import { candidateJudgments } from './helpers.js';

const input = Buffer.from([0, 255, 128, 65, 10]);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export class CliInputEvidenceAcceptance {
  f?: LocalFixture;
  environment: 'sandbox' | 'host' = 'sandbox';
  source?: Intent;
  check?: Intent;
  checkRequest?: { messages: { role: string; content: string }[] };
  repeatChanged = false;
  private ownerPaused = false;
  private repeatPaused = false;
  private releaseOwner?: () => void;
  private releaseRepeat?: () => void;
  private ownerExecution?: Promise<boolean>;
  private repeatExecution?: Promise<boolean>;
  async prepareEvidence(environment: string) {
    assert(environment === 'sandbox' || environment === 'host'); this.environment = environment;
    const f = this.f = await LocalFixture.create();
    await mkdir(join(f.source, '.tmp'), { recursive: true }); await writeFile(join(f.source, '.tmp/input.bin'), input);
    await writeFile(join(f.source, 'read-input.mjs'), "import fs from 'node:fs'; const input = fs.readFileSync(0); if (!input.length) process.exit(2); console.log('HELLO');");
    const action: LocalAction = { type: 'runCli', executable: 'node', args: ['@workspace/read-input.mjs', 'host-model-secret'], execution: environment,
      stdin: { path: '.tmp/input.bin' }, ...(environment === 'host' ? { reason: '核对实际标准输入证据' } : {}) };
    f.replies.push(action, { type: 'answer', text: 'HELLO；候选自报 stdin.sha256=forged-owner-hash' });
    f.beforeModelResponse = async (_request, index) => {
      if (index === 1) { this.ownerPaused = true; await new Promise<void>(resolve => { this.releaseOwner = resolve; }); }
    };
    const owner = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    this.ownerExecution = f.runner().runOne(f.h.room, f.h.task, owner.id);
    if (environment === 'host') {
      const op = await hostUntil(() => f.h.context().intents.find(work => work.id === owner.id)?.localOperations?.[0], op => !!op?.approval);
      assert.equal(f.h.engine.decideHostApproval(f.h.room, f.h.task, owner.id, op!.id, op!.approval!.id, 'approve', 'evidence-approve').code, 'OK');
      f.runtime.notifyWorkspace(`approval:${op!.id}`);
    }
    await hostUntil(() => this.ownerPaused, value => value);
    this.source = f.h.context().intents.find(work => work.id === owner.id)!;
    assert.equal(this.source.localOperations?.[0]?.status, 'succeeded');
  }
  async runFixedCheck() {
    const f = this.f!;
    this.releaseOwner!(); await this.ownerExecution;
    const check = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'check')!;
    assert(check); this.check = check;
    f.replies.push({ type: 'check', criteriaResults: candidateJudgments(f.h.context().candidate) });
    await f.runner().runOne(f.h.room, f.h.task, check.id);
    this.checkRequest = f.requests.at(-1)!;
  }
  async assertFixedEvidence() {
    const f = this.f!, op = this.source!.localOperations![0]!;
    const invocation = op.result!.data.invocation as Record<string, unknown>;
    assert(invocation && typeof invocation === 'object', 'the runtime must persist the actual invocation before fixed checking');
    assert.deepEqual(invocation.stdin, { path: '.tmp/input.bin', bytes: input.length, sha256: hash(input) });
    assert.equal(invocation.executable, await realpath(process.execPath));
    assert.deepEqual(invocation.args, [join(await realpath(f.source), 'read-input.mjs'), '[redacted]']);
    assert.equal(invocation.cwd, await realpath(f.source)); assert.equal(invocation.execution, this.environment);
    assert.equal(op.result!.data.validationInputsChanged, null, 'an owner invocation did not run the fixed-check source revision comparison');
    const material = deliveryCheckMaterials(f.h.context(), this.check!)!;
    assert.deepEqual(material.evidence[0]!.metadata.command.invocation, invocation);
    assert.equal(material.evidence[0]!.metadata.validationInputsChanged, null);
    const envelope = this.checkRequest!.messages.map(message => { try { return JSON.parse(message.content); } catch { return null; } })
      .find(value => value?.workId === this.check!.id);
    assert(envelope?.context?.evidence, 'the final model request must receive the fixed evidence');
    assert.deepEqual(envelope.context.evidence[0].metadata.command.invocation, invocation);
    assert.equal(envelope.context.evidence[0].metadata.validationInputsChanged, null);
    assert.equal(f.h.context().outcome, 'complete');
  }
  assertNoOwnerProofOrSecrets() {
    const serialized = JSON.stringify(this.checkRequest);
    assert(!serialized.includes('host-model-secret'), 'private original argv must stay outside check model input');
    assert(!serialized.includes('cliSnapshot'), 'compare-only raw identities must not escape into check model input');
    const f = this.f!, material = deliveryCheckMaterials(f.h.context(), this.check!)!;
    assert(!JSON.stringify(material.evidence).includes('forged-owner-hash'));
  }
  assertBoundedCheck() { assertFixedCheckRejectsAddedStdin(); }
  async prepareRepeat() {
    const f = this.f = await LocalFixture.create();
    await mkdir(join(f.source, '.tmp'), { recursive: true }); await writeFile(join(f.source, '.tmp/input.txt'), 'bad');
    await writeFile(join(f.source, 'read-input.mjs'), `import fs from 'node:fs'; const value = fs.readFileSync(0, 'utf8');
if (value !== 'good') { console.error('unknown option in supplied input'); process.exit(2); } console.log('repaired-input-ok');`);
    const action: LocalAction = { type: 'runCli', executable: 'node', args: ['@workspace/read-input.mjs'], execution: 'sandbox', stdin: { path: '.tmp/input.txt' } };
    f.beforeModelResponse = async (_request, index) => {
      if (index === 2) { this.repeatPaused = true; await new Promise<void>(resolve => { this.releaseRepeat = resolve; }); }
    };
    f.replies.push(action, action, action, { type: 'answer', text: '已核对输入和失败边界' });
    const owner = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    this.source = owner; this.repeatExecution = f.runner().runOne(f.h.room, f.h.task, owner.id);
    await hostUntil(() => this.repeatPaused, value => value);
    assert.equal(f.h.context().intents.find(work => work.id === owner.id)!.localOperations!.filter(op => op.status === 'failed').length, 2);
  }
  async repeat(change: string) {
    const f = this.f!; this.repeatChanged = change === '字节已修正';
    if (this.repeatChanged) await writeFile(join(f.source, '.tmp/input.txt'), 'good');
    this.releaseRepeat!(); await this.repeatExecution;
    this.source = f.h.context().intents.find(work => work.id === this.source!.id)!;
  }
  async assertRepeat(result: string) {
    const f = this.f!, ops = this.source!.localOperations!;
    assert.equal(ops.length, 3); assert.equal(ops[0]!.result!.code, 'failed'); assert.equal(ops[1]!.result!.code, 'failed');
    if (result === '在启动前阻止第三次重复失败') {
      assert.equal(f.backend.calls.length, 2); assert.equal(ops[2]!.result!.code, 'CLI_REPEAT_FAILURE_LIMIT'); assert.equal(ops[2]!.startedAt, undefined);
    } else {
      assert.equal(f.backend.calls.length, 3); assert.equal(ops[2]!.status, 'succeeded'); assert.equal(String(ops[2]!.result!.data.stdout).trim(), 'repaired-input-ok');
      const fingerprints = ops.map(op => (op.result!.data.invocation as { stdin: { sha256: string } }).stdin.sha256);
      assert.equal(fingerprints[0], fingerprints[1]); assert.notEqual(fingerprints[2], fingerprints[0]);
      assert.equal(await readFile(join(f.source, '.tmp/input.txt'), 'utf8'), 'good');
    }
  }
  async close() { this.releaseOwner?.(); this.releaseRepeat?.(); await this.ownerExecution; await this.repeatExecution; await this.f?.close(); }
}
