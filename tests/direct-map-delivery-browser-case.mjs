import assert from 'node:assert/strict';
import { DirectMapProvider } from './direct-map-delivery-acceptance.ts';
import { OpenAICompatibleAdapter } from '../src/model-adapter.ts';
import { ResilientWorkspaceBrowserFixture } from './resilient-workspace-browser-fixture.mjs';

export class DirectMapDeliveryBrowserCase {
  async open() {
    this.provider = await new DirectMapProvider(true).open();
    const config = this.provider.config();
    this.host = await new ResilientWorkspaceBrowserFixture('BT_Q49', { config, adapter: new OpenAICompatibleAdapter(config) }).open();
    // This scenario exercises actual interpretation; the generic fixture defaults it off for unrelated UI cases.
    config.inputAnalysis = { enabled: true };
    this.page = this.host.page; this.room = await this.host.createRoom();
    await this.host.capture('ready');
  }
  async act() {
    await this.host.send('分别读取八份资料，汇总可用内容并列出失败项。');
    const result = await this.host.until(() => this.host.get('/rooms/' + this.room.id),
      r => r.data.tasks?.some(t => t.outcome !== null), 'map completes through ordinary delivery');
    this.snapshot = result.data; this.provider.verify(this.snapshot);
    await this.page.getByRole('log', { name: '群聊消息', exact: true })
      .getByText('doc-7 已汇总，其余七份资料未取得并列入失败项。', { exact: true }).waitFor();
  }
  async verify() {
    this.provider.verify(this.snapshot);
    const task = this.snapshot.tasks.at(-1), c = this.host.service.engine.view(this.room.id, task.id).context;
    const failed = c.discussion.results.filter(r => r.status === 'failed');
    assert.equal(failed.length, 7); assert(failed.every(r => r.answer === '' && r.artifactIds.length === 0));
    assert.equal(this.provider.children.filter(id => id === 'doc-7').length, 1);
    assert(!c.artifacts.some(a => a.content.includes('FAILED_FILE_')));
    assert(!c.intents.some(w => w.outputRepair || w.payload.deliveryRevision));
    assert(!(await this.page.locator('body').innerText()).includes('MAP_RECOVERY_'));
    const stored = this.host.readDatabase().rooms.find(r => r.id === this.room.id);
    assert(stored); assert(!stored.data.includes('FAILED_FILE_'));
    await this.host.capture('completed');
    if (!this.host.completed.includes('BT_Q49')) this.host.completed.push('BT_Q49');
  }
  markFailed(message) { if (this.host) { this.host.failed = true; this.host.failureReason = message; } }
  async close() { await this.host?.close(); await this.provider?.close(); }
}
