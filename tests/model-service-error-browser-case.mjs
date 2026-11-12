import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ModelErrorProvider } from './model-service-error-case.ts';
import { WorkRunner } from '../src/runner.ts';
import { ResilientWorkspaceBrowserFixture } from './resilient-workspace-browser-fixture.mjs';

export class ModelServiceErrorBrowserCase {
  async open(status) {
    this.provider = await new ModelErrorProvider(status).open();
    const config = this.provider.config(), adapter = this.provider.adapter(config);
    this.host = await new ResilientWorkspaceBrowserFixture(`BT_Y171-${status}`, { config, adapter }).open();
    this.page = this.host.page; this.room = await this.host.createRoom();
    this.task = this.host.service.engine.submit(this.room.id, { id: randomUUID(), text: '继续整理已保存的资料' }).taskId;
    assert(this.host.service.engine.send(this.room.id, this.task, { type: 'ARTIFACT', id: randomUUID(), at: Date.now(),
      artifact: { id: 'saved-before-error', name: 'saved.md', content: '模型错误前已保存的内容' } }).ok);
    this.runner = new WorkRunner(this.host.service.engine, adapter);
    assert(await this.runner.runOne(this.room.id, this.task));
    await this.page.reload(); return this;
  }
  async act(choice) {
    this.choice = choice;
    const dialog = this.page.getByRole('dialog', { name: '模型服务调用失败', exact: true });
    await dialog.waitFor();
    const text = await dialog.textContent();
    assert(text.includes(`HTTP ${this.provider.status}`));
    assert(text.includes(this.provider.status === 403 ? 'permission_error' : 'invalid_request_error'));
    assert.equal(await dialog.getByRole('textbox').count(), 0);
    assert.equal(await dialog.getByRole('spinbutton').count(), 0);
    assert.equal(await dialog.getByRole('button', { name: '回复', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: '授权新窗口', exact: true }).count(), 0);
    await this.host.capture('model-error-popup');
    await dialog.getByRole('button', { name: '暂时关闭处理提示', exact: true }).click();
    assert.equal(this.c().resilience.gates.filter(g => g.status === 'open').length, 1);
    assert.equal(this.provider.requests, 1);
    await this.page.reload(); await dialog.waitFor();
    await dialog.getByRole('button', { name: choice, exact: true }).focus(); await this.page.keyboard.press('Enter');
    await this.host.until(() => this.c().outcome, value => value === (choice === '停止任务' ? 'stopped' : 'partial'), 'explicit model-error decision committed');
  }
  c() { return this.host.service.engine.view(this.room.id, this.task).context; }
  async verify() {
    const posts = this.host.posts.filter(p => p.path.endsWith('/blocker-decision'));
    assert.equal(posts.length, 1); assert.equal(posts[0].body.actionId, this.choice === '停止任务' ? 'stop' : 'skip');
    assert.equal(posts[0].body.text, undefined); assert.equal(posts[0].body.newWindowMs, undefined);
    assert(this.c().artifacts.some(a => a.id === 'saved-before-error' && a.content === '模型错误前已保存的内容'));
    assert.equal(this.provider.requests, 1);
    assert.equal(this.c().resilience.gates.filter(g => g.status === 'open').length, 0);
    await this.host.capture('decided');
    if (!this.host.completed.includes(this.host.scenario)) this.host.completed.push(this.host.scenario);
  }
  markFailed(message) { if (this.host) { this.host.failed = true; this.host.failureReason = message; } }
  async close() { await this.host?.close(); await this.provider?.close(); }
}
