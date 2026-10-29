import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

/** React DOM interactions; real browser geometry is verified separately. */
export class DebugUIFixture {
  readonly window = new Window({ url: 'http://localhost/' });
  readonly requests: string[] = [];
  closed = 0;
  private root?: Root;
  private readonly previous = new Map<string, PropertyDescriptor | undefined>();
  constructor(private readonly host?: { url: string; room: { id: string } }) {
    const win = this.window;
    const realFetch = globalThis.fetch;
    const values: Record<string, unknown> = {
      window: win, document: win.document, navigator: win.navigator,
      HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, Event: win.Event,
      KeyboardEvent: win.KeyboardEvent, MouseEvent: win.MouseEvent,
      MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: unknown, init?: RequestInit) => {
        this.requests.push(String(input));
        if (host) return realFetch(new URL(String(input), host.url), init);
        throw new Error('Unexpected external request');
      },
    };
    for (const [key, value] of Object.entries(values)) {
      this.previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  }
  async open() {
    const { createRoot } = await import('react-dom/client');
    const { TaskDebug } = await import('../web/src/TaskDebug.js');
    const container = document.createElement('div'); document.body.append(container);
    this.root = createRoot(container);
    await act(async () => { this.root!.render(createElement(TaskDebug, { roomId: this.host?.room.id ?? null, onClose: () => { this.closed++; } })); });
  }
  get phase() { return document.querySelector('[data-testid="debug-phase"]')?.textContent; }
  button(text: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text || node.getAttribute('aria-label') === text);
    assert(button, 'Missing button: ' + text); return button;
  }
  async click(text: string) { await act(async () => { this.button(text).click(); }); }
  async choose(type: string) {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="事件类型"]'); assert(select);
    await act(async () => { select.value = type; select.dispatchEvent(new this.window.Event('change', { bubbles: true }) as unknown as Event); });
  }
  async selectSandbox(id: string) {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="选择沙箱"]'); assert(select);
    await act(async () => { select.value = id; select.dispatchEvent(new this.window.Event('change', { bubbles: true }) as unknown as Event); });
  }
  async filterRules(id: string) {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="规则状态筛选"]'); assert(select);
    await act(async () => { select.value = id; select.dispatchEvent(new this.window.Event('change', { bubbles: true }) as unknown as Event); });
  }
  async sendHelp() { await this.choose('HELP'); await this.click('单步执行'); }
  async disclose(text: string) {
    const summary = [...document.querySelectorAll('summary')].find(node => node.textContent === text); assert(summary, 'Missing disclosure: ' + text);
    await act(async () => { summary.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  async fill(label: string, value: string) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="' + label + '"]'); assert(input);
    await act(async () => {
      const prototype = input.tagName === 'TEXTAREA' ? this.window.HTMLTextAreaElement.prototype : this.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new this.window.Event('input', { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new this.window.Event('change', { bubbles: true }) as unknown as Event);
    });
  }
  get text() { return document.querySelector('[role="dialog"]')?.textContent ?? ''; }
  async waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    assert(predicate(), 'Timed out waiting for real debug feed');
  }
  async escape() {
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new this.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event); });
  }
  async shiftTab() {
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new this.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }) as unknown as Event); });
  }
  async close() {
    await act(async () => { this.root?.unmount(); });
    for (const [key, value] of this.previous) {
      if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key);
    }
    await this.window.happyDOM.close();
  }
}

