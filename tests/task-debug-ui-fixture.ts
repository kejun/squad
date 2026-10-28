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
  constructor() {
    const win = this.window;
    const values: Record<string, unknown> = {
      window: win, document: win.document, navigator: win.navigator,
      HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node, Event: win.Event,
      KeyboardEvent: win.KeyboardEvent, MouseEvent: win.MouseEvent,
      MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: unknown) => { this.requests.push(String(input)); throw new Error('Unexpected external request'); },
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
    await act(async () => { this.root!.render(createElement(TaskDebug, { roomId: null, onClose: () => { this.closed++; } })); });
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
  async sendHelp() { await this.choose('HELP'); await this.click('单步执行'); }
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

