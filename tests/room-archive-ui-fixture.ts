import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { DebugUIFixture } from './task-debug-ui-fixture.js';
import { RoomArchiveFixture } from './room-archive-fixture.js';

export class RoomArchiveUIFixture {
  readonly host = new RoomArchiveFixture();
  ui!: DebugUIFixture;
  failNextArchive = true;
  readonly posts: string[] = [];
  private root?: Root;
  private storage: PropertyDescriptor | undefined;
  private closed = false;
  async open() {
    await this.host.start(); await this.host.seed();
    this.ui = new DebugUIFixture({ url: this.host.url, room: this.host.first });
    this.storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => this.ui.window.localStorage });
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST') {
        this.posts.push(String(input));
        if (String(input).endsWith('/archive') && this.failNextArchive) {
          this.failNextArchive = false; throw new Error('模拟网络断开，请重试');
        }
      }
      return fetch(input, init);
    };
    const [{ createRoot }, { App }] = await Promise.all([import('react-dom/client'), import('../web/src/App.js')]);
    const container = document.createElement('div'); document.body.append(container); this.root = createRoot(container);
    await act(async () => { this.root!.render(createElement(App)); });
    await this.ui.waitFor(() => document.querySelector('.room-button[aria-current="page"]')?.textContent === this.host.first.title);
    await this.ui.fill('群聊消息输入框', '尚未发送的草稿');
  }
  async archive() { await this.ui.click('归档群聊 ' + this.host.first.title); }
  async failed() { await this.ui.waitFor(() => !!document.querySelector('[role="alert"]')); }
  assertFailed() {
    assert(document.querySelector('[role="alert"]')?.textContent?.includes('模拟网络断开'));
    assert.equal(document.querySelectorAll('nav[aria-label="群聊列表"] .room-button').length, 2);
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="群聊消息输入框"]')?.value, '尚未发送的草稿');
    assert.equal(document.querySelector('.room-button[aria-current="page"]')?.textContent, this.host.first.title);
  }
  async openArchived() {
    await this.ui.waitFor(() => document.querySelectorAll('nav[aria-label="群聊列表"] .room-button').length === 1);
    await this.ui.click('已归档 1'); await this.ui.click(this.host.first.title);
    await this.ui.waitFor(() => document.querySelector('h1')?.textContent === this.host.first.title);
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="群聊消息输入框"]')?.value, '尚未发送的草稿');
    assert.equal(document.querySelectorAll('nav[aria-label="归档群聊列表"] .room-button').length, 1);
    this.host.assertHistory();
  }
  async restore() {
    await this.ui.click('恢复群聊 ' + this.host.first.title);
    await this.ui.waitFor(() => document.querySelectorAll('nav[aria-label="群聊列表"] .room-button').length === 2);
    assert.equal(document.querySelector('.room-button[aria-current="page"]')?.textContent, this.host.first.title);
    this.host.assertHistory(); assert(!this.posts.some(path => path.endsWith('/messages')));
  }
  async close() {
    if (this.closed) return; this.closed = true;
    await act(async () => { this.root?.unmount(); });
    if (this.storage) Object.defineProperty(globalThis, 'localStorage', this.storage); else Reflect.deleteProperty(globalThis, 'localStorage');
    await this.ui?.close(); await this.host.close();
  }
}
