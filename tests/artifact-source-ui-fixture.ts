import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { RoomSnapshot } from '../src/web/contracts.js';
import type { useWorkspace } from '../web/src/api.js';
import { detailSnapshot } from './detail-actions-fixture.js';
import { PanelFixture } from './panel-fixture.js';

export class SourceUIFixture {
  readonly dom = new PanelFixture();
  readonly posts: Record<string, unknown>[] = [];
  response: { status: number; value: unknown } = { status: 200, value: { ok: true } };
  networkFailure = false;
  private root?: Root;
  private component?: typeof import('../web/src/App.js').Workspace;
  private state: ReturnType<typeof useWorkspace>;
  constructor(readonly snapshot = detailSnapshot()) {
    snapshot.activeTaskId = null;
    snapshot.tasks[0]!.currentArtifactIds = ['report'];
    snapshot.tasks[1]!.phase = 'ended'; snapshot.tasks[1]!.outcome = 'complete';
    snapshot.messages[1]!.artifactIds = ['report'];
    this.state = { rooms: [snapshot.room], roomId: snapshot.room.id, snapshot, connected: true, error: '',
      setError: (value) => { const error = typeof value === 'function' ? value(this.state.error) : value; this.state = { ...this.state, error }; this.render(); },
      chooseRoom() {}, createRoom: async () => snapshot.room.id, refreshRooms: async () => [snapshot.room],
      setRoomArchived: async () => { throw new Error('Unexpected archive action'); } };
    globalThis.fetch = async (_input, init) => {
      this.posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (this.networkFailure) throw new Error('连接断开');
      return new Response(JSON.stringify(this.response.value), { status: this.response.status,
        headers: { 'content-type': 'application/json' } });
    };
  }
  private render() { this.root!.render(createElement(this.component!, { workspace: this.state })); }
  async mount() {
    const [{ createRoot }, { Workspace }] = await Promise.all([import('react-dom/client'), import('../web/src/App.js'), import('../web/src/Details.js'), import('../web/src/MessageText.js')]);
    this.component = Workspace; this.root = createRoot(this.dom.container);
    await act(async () => { this.render(); }); return this;
  }
  async click(label: string) { await act(async () => { this.dom.label(label).click(); }); }
  async text(value: string) { await this.dom.enterDraft(value); }
  async reference() { await this.click('查看 旧方案.md'); await this.click('引用到新任务'); }
  async update(snapshot: RoomSnapshot) { this.state = { ...this.state, snapshot }; await act(async () => { this.render(); }); }
  get body() { return this.dom.container.textContent ?? ''; }
  async close() { await act(async () => { this.root?.unmount(); }); await this.dom.close(); }
}

/** Drives public controls with React and a DOM; provider/browser integration has a separate entry. */
export async function verifyArtifactSourceComposer() {
  const f = await new SourceUIFixture().mount();
  try {
    await f.reference(); await f.text('补充部署说明，输出为 b.md');
    assert(f.dom.container.querySelector('[aria-label="移除产物引用"]'));
    await f.click('移除产物引用');
    assert.equal(f.dom.container.querySelector('[aria-label="移除产物引用"]'), null);
    assert.equal(f.dom.draft, '补充部署说明，输出为 b.md');
    await f.reference();
    f.response = { status: 409, value: { error: '群内已有活动任务，请结束后重发。', code: 'ROOM_BUSY' } };
    await f.click('发送消息');
    assert.equal(f.dom.draft, '补充部署说明，输出为 b.md');
    assert(f.dom.container.querySelector('[aria-label="移除产物引用"]'));
    assert.deepEqual(f.posts[0]?.sourceArtifact, { sourceTaskId: 'old-task', artifactId: 'report' });
    assert(!JSON.stringify(f.posts[0]).includes('旧报告'));
    f.response = { status: 200, value: { ok: true } }; await f.click('发送消息');
    assert.notEqual(f.posts[0]?.id, f.posts[1]?.id);
    assert.deepEqual(f.posts[1]?.sourceArtifact, { sourceTaskId: 'old-task', artifactId: 'report' });
    assert.equal(f.dom.draft, '');
    assert.equal(f.dom.container.querySelector('[aria-label="移除产物引用"]'), null);
  } finally { await f.close(); }
}
