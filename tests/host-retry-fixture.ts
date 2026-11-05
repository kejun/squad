import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TaskContext } from '../src/types.js';
import { withFixtureAcceptance } from './delivery-protocol-fixture.js';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

export class HostRetryFixture extends HostApprovalFixture {
  private releaseMain?: () => void;
  private releaseSynthesis?: (response: Response | undefined) => void;
  async pauseAfterTwoFailures() {
    this.hostCommands = 2;
    const gate = new Promise<void>(resolve => { this.releaseMain = resolve; });
    this.beforeOwnerResponse = async request => {
      if (request.messages.filter(m => m.role === 'user' && m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('CLI_SANDBOX_UNAVAILABLE')).length === 2)
        await gate;
    };
    await this.open();
    assert(this.action.type === 'runCli');
    this.action = { ...this.action, execution: 'sandbox' };
    this.submit();
    return hostUntil(() => this.snapshot().failedSandboxCommands ?? [], list => list.length === 2 && this.requests.length === 3);
  }
  resumeMain() { this.releaseMain?.(); }
  async pauseAfterFirstRetryReceipt() {
    const [first, second] = await this.pauseAfterTwoFailures();
    assert(first && second);
    const before = this.beforeOwnerResponse;
    const gate = new Promise<Response | undefined>(resolve => { this.releaseSynthesis = resolve; });
    let firstSynthesis = false;
    this.beforeOwnerResponse = async request => {
      await before?.(request);
      if (!request.messages.some(m => m.role === 'user' && m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"'))) return;
      if (firstSynthesis) return modelResponse(withFixtureAcceptance({ type: 'answer', text: '已处理真实命令回执' }, request));
      firstSynthesis = true;
      return gate;
    };
    assert.equal((await this.requestRetry(this.retryData(first))).status, 200);
    this.resumeMain();
    const approval = await this.approval();
    assert.equal(approval.args.at(-1), 'command-1');
    assert.equal((await this.request(this.decisionData(approval, 'approve'))).status, 200);
    await hostUntil(() => firstSynthesis, Boolean);
    assert.equal((await this.requestRetry(this.retryData(second))).status, 200);
  }
  resumeSynthesis(response?: Response) { this.releaseSynthesis?.(response); }
  async restartWithLegacyBatch(workId: string) {
    const saved = JSON.parse(this.savedRoom()) as { tasks: Record<string, { snapshot: { context: TaskContext } }> };
    const work = saved.tasks[this.taskId]?.snapshot.context.intents.find(item => item.id === workId);
    assert(work);
    work.status = 'done'; // Simulate a snapshot committed by the old lifecycle.
    await this.restart(JSON.stringify(saved), () => this.resumeSynthesis(new Response(null, { status: 400 })));
  }
  async close() { this.resumeMain(); this.resumeSynthesis(); await super.close(); }
  async failedRound() {
    await this.open();
    assert.equal(this.action.type, 'runCli'); if (this.action.type !== 'runCli') throw new Error('fixture CLI required');
    this.action = { ...this.action, execution: 'sandbox' }; this.submit(); await this.complete();
    assert.equal(this.snapshot().hostApprovals?.length, 0);
    assert.equal(await this.runs(), '');
    assert.equal(this.snapshot().failedSandboxCommands?.length, 1);
  }
  retryData(command = this.snapshot().failedSandboxCommands![0]!, id = randomUUID()) {
    return { id, taskId: command.taskId, workId: command.workId, operationId: command.operationId, sourceRequestHash: command.sourceRequestHash };
  }
  async requestRetry(data: unknown = this.retryData(), origin: string | null = this.url) {
    const response = await fetch(this.url + this.route() + '/host-retry', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() as unknown };
  }
  async requestAndApprove() {
    assert.equal((await this.requestRetry()).status, 200);
    const approval = await this.approval(); assert.equal(await this.runs(), '');
    assert.equal((await this.request(this.decisionData(approval, 'approve'))).status, 200);
    await this.complete();
    assert.equal(await this.runs(), 'once\n');
    const context = this.service.engine.view(this.room.id, this.taskId)!.context;
    const host = context.intents.flatMap(work => work.localOperations ?? []).find(op => op.hostRetryOf)!;
    assert.equal(host.status, 'succeeded'); assert.equal(host.result?.data.execution, 'host');
    assert(this.requests.at(-1)!.messages.some(m => m.content.startsWith('{"type":"local_tool_result",') && m.content.includes('"execution":"host"')));
    assert.equal(this.operation()?.status, 'failed'); assert(this.operation()?.hostRetryIntentId);
  }
}
