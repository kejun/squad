import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import type { RoomData } from '../src/store.js';
import type { TaskContext } from '../src/types.js';

export class HostRetryFixture extends HostApprovalFixture {
  private releaseMain?: () => void;
  private releaseSynthesis?: (output: 'delivery' | 'invalidHelp') => void;
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
  resumeSynthesis(output: 'delivery' | 'invalidHelp' = 'delivery') { this.releaseSynthesis?.(output); }
  async close() { this.resumeMain(); this.resumeSynthesis(); await super.close(); }
  context() { return this.service.engine.view(this.room.id, this.taskId)!.context; }
  async pauseAfterFirstRetry() {
    const [first, second] = await this.pauseAfterTwoFailures();
    assert.equal((await this.requestRetry(this.retryData(first))).status, 200);
    this.resumeMain();
    const approval = await this.approval();
    const owner = this.context().owner;
    const gate = new Promise<'delivery' | 'invalidHelp'>(resolve => { this.releaseSynthesis = resolve; });
    const hasFirstReceipt = (request: HostApprovalFixture['requests'][number]) => request.messages.some(message =>
      message.content.startsWith('{"type":"local_tool_result",') && message.content.includes(JSON.stringify(approval.operationId)));
    this.beforeOwnerResponse = async request => {
      this.hostCommands = 1;
      if (hasFirstReceipt(request) && await gate === 'invalidHelp')
        return modelResponse({ type: 'help', requestId: 'self-help', target: owner, question: '核对续办回执', expected: '证据' });
    };
    assert.equal((await this.request(this.decisionData(approval, 'approve'))).status, 200);
    await hostUntil(() => this.requests.at(-1), request => !!request && hasFirstReceipt(request));
    assert.equal((await this.requestRetry(this.retryData(second))).status, 200);
    assert.deepEqual(this.context().hostRetryRequests?.map(request => request.status), ['settled', 'pending']);
    return approval;
  }
  legacyRetiredBatch(): RoomData {
    const room = JSON.parse(this.savedRoom()) as RoomData;
    const { snapshot: { context } } = room.tasks[this.taskId] as { snapshot: { context: TaskContext } };
    const work = context.intents.find(item => item.id === context.hostRetryBatch?.workId);
    assert(work && work.status === 'inflight');
    // Restore the old persisted mismatch: terminal work alongside the batch's live pointer.
    work.status = 'done';
    return room;
  }
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
