import assert from 'node:assert/strict';
import { act } from 'react';
import { DebugUIFixture } from './task-debug-ui-fixture.js';
import { inspectorOrigin } from '../src/inspector.machine.js';

export interface TabMessage { type: string; sessionId?: string; definition?: string; snapshot?: { value: string } }
export class InspectorTabFixture {
  readonly ui = new DebugUIFixture();
  readonly tabs: { closed: boolean; location: { href: string }; focused: number; messages: TabMessage[]; navigations: string[]; focus(): void; postMessage(message: TabMessage, origin: string): void }[] = [];
  readonly openCalls: { url: unknown; name: unknown; features: unknown }[] = [];
  blocked = false;
  private clicking = false;
  private disposed = false;
  async open(blocked = false) {
    this.blocked = blocked;
    this.ui.window.open = ((url?: unknown, name?: unknown, features?: unknown) => {
      assert(this.clicking, 'window.open must run inside the original synchronous click');
      this.openCalls.push({ url, name, features });
      if (this.blocked) return null;
      const navigations: string[] = [];
      const target = {
        closed: false, focused: 0, messages: [] as TabMessage[], navigations,
        location: { get href() { return navigations.at(-1) ?? 'about:blank'; }, set href(url: string) { navigations.push(url); } },
        focus() { this.focused++; },
        postMessage(message: TabMessage, origin: string) { assert.equal(origin, inspectorOrigin); this.messages.push(structuredClone(message)); },
      };
      this.tabs.push(target);
      return target;
    }) as unknown as typeof this.ui.window.open;
    await this.ui.open(); await this.ui.disclose('高级');
  }
  get tab() { const tab = this.tabs.at(-1); assert(tab); return tab; }
  async click() {
    await act(async () => {
      this.clicking = true;
      try {
        const button = document.querySelector<HTMLButtonElement>('button[title="在新标签页打开官方 Inspector"]');
        assert(button); button.click();
      } finally { this.clicking = false; }
    });
  }
  async navigated() { await this.ui.waitFor(() => !!this.tabs.at(-1)?.navigations.length); }
  async handshake(source: unknown = this.tab, origin = inspectorOrigin) {
    await act(async () => {
      this.ui.window.dispatchEvent(new this.ui.window.MessageEvent('message', { source: source as never, origin, data: { type: '@statelyai.connected' } }));
    });
  }
  assertOpened() {
    assert.equal(this.openCalls.length, 1); assert.equal(this.tabs.length, 1);
    assert.deepEqual(this.openCalls[0], { url: 'about:blank', name: '_blank', features: undefined });
    assert.deepEqual(this.tab.navigations, [inspectorOrigin + '/inspect']);
    assert.equal(document.querySelector('iframe'), null);
  }
  assertRegistration(tab = this.tab) {
    assert.equal(tab.messages[0]?.type, '@xstate.actor');
    assert(JSON.parse(tab.messages[0].definition!).states.running);
    const sessions = new Set<string>();
    for (const message of tab.messages) {
      if (message.type === '@xstate.actor') sessions.add(message.sessionId!);
      if (message.type === '@xstate.snapshot' || message.type === '@xstate.event') assert(sessions.has(message.sessionId!));
    }
    assert.equal(this.ui.requests.length, 0);
  }
  async close() { if (this.disposed) return; this.disposed = true; await this.ui.close(); }
}
