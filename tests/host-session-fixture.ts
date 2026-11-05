import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import type { WebHostApproval } from '../src/web/contracts.js';

/** Actual HTTP, SQLite and host processes; only model responses are scripted. */
export class HostSessionFixture extends HostApprovalFixture {
  async pending() { this.hostCommands = 2; await this.open(); this.submit(); return this.approval(); }
  async allowSession(a?: WebHostApproval) {
    return this.request(this.decisionData(a ?? await this.approval(), 'approveSession'));
  }
  async revoke(grantId: string, origin: string | null = this.url, extra: Record<string, unknown> = {}) {
    const response = await fetch(this.url + this.route() + '/host-session-revoke', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ id: randomUUID(), taskId: this.taskId, grantId, ...extra }) });
    return { status: response.status, data: await response.json() as unknown };
  }
  async refresh() { return (await (await fetch(this.url + this.route())).json()) as ReturnType<HostApprovalFixture['snapshot']>; }
  grantWithoutNotify(a: WebHostApproval, id = randomUUID()) {
    const reply = this.service.engine.decideHostApproval(this.room.id, this.taskId, a.workId, a.operationId, a.approvalId, 'approveSession', id);
    assert(reply.ok); return this.snapshot().hostSessions![0]!;
  }
  operations() { return this.service.engine.view(this.room.id, this.taskId)!.context.intents.flatMap(w => w.localOperations ?? []); }
  async assertTwoRuns() {
    await this.complete();
    assert.equal(await this.runs(), 'once\nonce\n'); assert.equal(this.operations().length, 2);
    assert(this.operations().every(op => op.status === 'succeeded' && op.result?.data.execution === 'host'));
    assert.notDeepEqual(this.operations()[0]!.action, this.operations()[1]!.action);
    assert.equal(this.operations()[0]!.approval?.sessionGrantId, this.operations()[1]!.approval?.sessionGrantId);
    assert(this.operations()[0]!.approval?.sessionGrantId); assert.deepEqual(this.snapshot().hostApprovals, []);
    assert.deepEqual(this.snapshot().hostSessions, []);
  }
  async secondApproval() { return hostUntil(() => this.snapshot().hostApprovals ?? [], list => list.length === 1 && list[0]!.operationId !== this.operations()[0]!.id).then(list => list[0]!); }
}
