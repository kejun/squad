import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';

export class HostRetryFixture extends HostApprovalFixture {
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
