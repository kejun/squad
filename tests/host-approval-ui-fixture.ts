import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { HostApprovalFixture } from './host-approval-fixture.js';
import { DebugUIFixture } from './task-debug-ui-fixture.js';

export class HostApprovalUIFixture {
  host = new HostApprovalFixture(); ui!: DebugUIFixture; root?: Root;
  posts: { approvalId: string; decision: string }[] = []; failNext = false;
  async open() {
    await this.host.open(); this.host.submit(); const approval = await this.host.approval();
    this.ui = new DebugUIFixture({ url: this.host.url, room: this.host.room });
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers); headers.set('origin', this.host.url);
      if (init?.method === 'POST') {
        this.posts.push(JSON.parse(String(init.body)) as { approvalId: string; decision: string });
        if (this.failNext) { this.failNext = false; throw new Error('授权提交暂时失败'); }
      }
      return fetch(input, { ...init, headers });
    };
    const [{ createRoot }, { HostApprovals }] = await Promise.all([import('react-dom/client'), import('../web/src/HostApprovals.js')]);
    const container = document.createElement('div'); document.body.append(container); this.root = createRoot(container);
    await act(async () => this.root!.render(createElement(HostApprovals, { roomId: this.host.room.id, requests: [approval], connected: true })));
    await this.ui.waitFor(() => !!document.querySelector('[role="dialog"]'));
    assert(document.querySelector('[role="dialog"]')?.textContent?.includes(approval.cwd));
    assert(document.querySelector('[aria-label="请求执行的完整命令"]')?.textContent?.includes('$(not-a-shell)'));
  }
  async dismissAndReopen() {
    await this.ui.click('暂时关闭授权提示');
    assert.equal(this.posts.length, 0); assert.equal(await this.host.runs(), '');
    await act(async () => { document.querySelector<HTMLButtonElement>('.host-approval-card')!.click(); });
    await this.ui.waitFor(() => !!document.querySelector('[role="dialog"]'));
  }
  async retryDenial() {
    this.failNext = true; await this.ui.click('拒绝');
    await this.ui.waitFor(() => !!document.querySelector('[role="alert"]'));
    assert(document.querySelector('[role="alert"]')?.textContent?.includes('提交暂时失败'));
    assert.equal(this.host.operation()?.status, 'awaitingApproval');
    await this.ui.click('拒绝'); await this.ui.waitFor(() => !document.querySelector('[role="dialog"]'));
    assert.equal(this.posts.length, 2); assert.equal(this.posts[0]!.approvalId, this.posts[1]!.approvalId);
    assert.equal(this.posts[1]!.decision, 'deny'); assert.equal(await this.host.runs(), '');
  }
  async switchRoomDoesNotDecide() {
    const room = this.host.service.createRoom('另一个群');
    this.host.service.submit(room.id, { id: 'second-task', text: '另一个命令' });
    const { hostUntil } = await import('./host-approval-fixture.js');
    const requests = await hostUntil(() => this.host.service.snapshot(room.id).hostApprovals ?? [], list => list.length === 1);
    const { HostApprovals } = await import('../web/src/HostApprovals.js');
    await act(async () => this.root!.render(createElement(HostApprovals, { key: room.id, roomId: room.id, requests, connected: true })));
    await this.ui.waitFor(() => !!document.querySelector('[role="dialog"]'));
    await this.ui.click('暂时关闭授权提示');
    assert.equal(this.posts.length, 2); assert.equal(this.host.service.snapshot(room.id).hostApprovals?.length, 1);
    assert.equal(await this.host.runs(), '');
  }
  async close() {
    await act(async () => { this.root?.unmount(); }); await this.ui?.close(); await this.host.close();
  }
}
