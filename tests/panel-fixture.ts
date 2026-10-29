import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { RoomSnapshot } from '../src/web/contracts.js';
import type { useWorkspace } from '../web/src/api.js';
import { PANEL_LAYOUT_STORAGE_KEY, type PanelSide } from '../web/src/panel-layout.js';
import { configuration } from './helpers.js';

/** DOM event verification, not a browser layout engine. Geometry is supplied explicitly. */
export class PanelFixture {
  readonly window: Window;
  readonly container: HTMLElement;
  readonly requests: string[] = [];
  readonly storage: Storage;
  private readonly previous = new Map<string, PropertyDescriptor | undefined>();
  private root: Root | undefined;
  private component: typeof import('../web/src/App.js').Workspace | undefined;
  private width: number;
  private contentWidth: number;
  private workspace: ReturnType<typeof useWorkspace>;
  private dragHandle: HTMLElement | undefined;

  constructor(width = 1440, rawPreferences?: string, deniedStorage = false, availableWidth = width) {
    this.width = width;
    this.contentWidth = availableWidth;
    this.window = new Window({ url: 'http://localhost/' });
    this.window.happyDOM.setWindowSize({ width, height: 900 });
    const win = this.window;
    for (const name of ['styles.css', 'panels.css']) {
      const path = new URL(`../web/src/${name}`, import.meta.url);
      if (!existsSync(path)) continue;
      const style = win.document.createElement('style');
      style.textContent = readFileSync(path, 'utf8').replace(/@import[^;]+;/g, '');
      win.document.head.appendChild(style);
    }
    this.storage = win.localStorage as unknown as Storage;
    if (rawPreferences !== undefined) this.storage.setItem(PANEL_LAYOUT_STORAGE_KEY, rawPreferences);
    if (deniedStorage) Object.defineProperty(win, 'localStorage', { configurable: true, get() { throw new Error('Storage disabled'); } });
    const fixture = this;
    class ResizeObserverMock {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) { this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    }
    const values: Record<string, unknown> = {
      window: win, document: win.document, navigator: win.navigator,
      HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
      Event: win.Event, CustomEvent: win.CustomEvent, MouseEvent: win.MouseEvent,
      PointerEvent: win.PointerEvent, KeyboardEvent: win.KeyboardEvent,
      MutationObserver: win.MutationObserver,
      ResizeObserver: ResizeObserverMock,
      getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: unknown) => { fixture.requests.push(String(input)); throw new Error('Unexpected business request'); },
    };
    for (const [key, value] of Object.entries(values)) {
      this.previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    this.previous.set('localStorage', Object.getOwnPropertyDescriptor(globalThis, 'localStorage'));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => win.localStorage });
    win.HTMLElement.prototype.getBoundingClientRect = function () {
      const width = this.classList.contains('workspace') ? fixture.contentWidth : 0;
      return new win.DOMRect(0, 0, width, 900);
    };
    // happy-dom does not perform pointer retargeting; dispatch below targets the captured element.
    const captures = new WeakMap<object, Set<number>>();
    win.HTMLElement.prototype.setPointerCapture = function (id: number) { captures.set(this, new Set([id])); };
    win.HTMLElement.prototype.releasePointerCapture = function (id: number) { captures.get(this)?.delete(id); };
    win.HTMLElement.prototype.hasPointerCapture = function (id: number) { return captures.get(this)?.has(id) ?? false; };
    this.container = win.document.createElement('div') as unknown as HTMLElement;
    win.document.body.appendChild(this.container as never);
    const first = { id: 'first', title: '当前群聊', createdAt: 1 };
    const second = { id: 'second', title: '另一个群聊', createdAt: 2 };
    const snapshot: RoomSnapshot = {
      room: first, agents: configuration().bots.map(bot => ({ ...bot, model: 'test-model' })),
      messages: [], tasks: [], activeTaskId: null, works: [], events: [], modelConfigured: true, serverTime: 0,
    };
    this.workspace = {
      rooms: [first, second], roomId: first.id, snapshot, connected: true, error: '', setError() {},
      chooseRoom: (id: string) => {
        const room = this.workspace.rooms.find(room => room.id === id)!;
        this.workspace = { ...this.workspace, roomId: id, snapshot: { ...snapshot, room } };
        this.render();
      },
      createRoom: async () => { this.requests.push('createRoom'); return first.id; },
      refreshRooms: async () => this.workspace.rooms,
    };
  }

  private render() { this.root!.render(createElement(this.component!, { workspace: this.workspace })); }
  async mount() {
    const [{ createRoot }, { Workspace }] = await Promise.all([import('react-dom/client'), import('../web/src/App.js')]);
    this.component = Workspace; this.root = createRoot(this.container);
    await act(async () => { this.render(); }); return this;
  }
  query(selector: string) { const element = this.container.querySelector<HTMLElement>(selector); assert(element, selector); return element; }
  label(label: string) {
    const candidates = [...this.container.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)];
    const element = candidates.find(element => {
      const style = this.window.getComputedStyle(element as never);
      return style.display !== 'none' && style.visibility !== 'hidden' && !element.closest('[hidden]');
    });
    assert(element, `Visible control: ${label}`); return element;
  }
  separator(side: PanelSide) { return this.label(side === 'left' ? '调整导航宽度' : '调整详情宽度'); }
  widthOf(side: PanelSide) { return Number(this.separator(side).getAttribute('aria-valuenow')); }
  preferences() { const raw = this.storage.getItem(PANEL_LAYOUT_STORAGE_KEY); return raw ? JSON.parse(raw) as Record<string, unknown> : null; }
  async click(label: string) { await act(async () => { this.label(label).click(); }); }
  async openDetails() { if (!this.container.querySelector('#workspace-details')) await this.click('查看任务详情'); }
  async openNavigation() {
    if (this.width <= 720) await this.click('展开导航');
    else if (this.container.querySelector('[aria-label="展开导航"]')) await this.click('展开导航');
  }
  async viewport(width: number, availableWidth = width) {
    this.width = width;
    this.contentWidth = availableWidth;
    await act(async () => {
      this.window.happyDOM.setWindowSize({ width, height: 900 });
      this.window.dispatchEvent(new this.window.Event('resize'));
    });
  }
  private pointer(type: string, x: number) {
    assert(this.dragHandle);
    this.dragHandle.dispatchEvent(new this.window.PointerEvent(type, { bubbles: true, clientX: x, pointerId: 1, button: 0, isPrimary: true }) as unknown as Event);
  }
  async startDrag(side: PanelSide) {
    this.dragHandle = this.separator(side);
    await act(async () => { this.pointer('pointerdown', 500); });
  }
  async moveDrag(dx: number) { await act(async () => { this.pointer('pointermove', 500 + dx); }); }
  async endDrag(dx: number) { await act(async () => { this.pointer('pointerup', 500 + dx); }); }
  async drag(side: PanelSide, dx: number) { await this.startDrag(side); await this.moveDrag(dx); await this.endDrag(dx); }
  async resizeInOneFrame(side: PanelSide, widths: readonly number[]) {
    assert(widths.length > 0);
    const start = this.widthOf(side), direction = side === 'left' ? 1 : -1;
    this.dragHandle = this.separator(side);
    await act(async () => {
      this.pointer('pointerdown', 500);
      for (const width of widths) this.pointer('pointermove', 500 + (width - start) * direction);
      this.pointer('pointerup', 500 + (widths.at(-1)! - start) * direction);
    });
  }
  async requestWidth(side: PanelSide, width: number) { const current = this.widthOf(side); await this.drag(side, side === 'left' ? width - current : current - width); }
  async key(side: PanelSide, key: string, shiftKey = false) {
    await act(async () => { const separator = this.separator(side); separator.focus(); separator.dispatchEvent(new this.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }) as unknown as Event); });
  }
  async cancel(mode: string) {
    if (mode === '组件卸载') { await act(async () => { this.root!.unmount(); }); this.root = undefined; }
    else await act(async () => {
      if (mode === '取消指针') this.pointer('pointercancel', 580);
      else if (mode === '窗口失焦') this.window.dispatchEvent(new this.window.Event('blur'));
      else this.window.dispatchEvent(new this.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  }
  async enterDraft(text: string) {
    await act(async () => {
      const element = this.label('群聊消息输入框');
      const setter = Object.getOwnPropertyDescriptor(this.window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(element, text);
      element.dispatchEvent(new this.window.Event('input', { bubbles: true }) as unknown as Event);
      element.dispatchEvent(new this.window.Event('change', { bubbles: true }) as unknown as Event);
    });
  }
  async chooseRoom(title: string) {
    await act(async () => {
      const button = [...this.container.querySelectorAll<HTMLButtonElement>('.room-button')].find(element => element.textContent?.includes(title));
      assert(button, title); button.click();
    });
  }
  get roomId() { return this.workspace.roomId; }
  get draft() { return (this.label('群聊消息输入框') as HTMLTextAreaElement).value; }
  get viewportWidth() { return this.width; }
  get availableWidth() { return this.contentWidth; }
  async close() {
    if (this.root) { await act(async () => { this.root!.unmount(); }); this.root = undefined; }
    await this.window.happyDOM.abort();
    for (const [key, descriptor] of [...this.previous.entries()].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
