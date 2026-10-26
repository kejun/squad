import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { RoomSnapshot, WebAgent, WebTask } from '../src/web/contracts.js';
import type { DetailTarget } from '../web/src/ResultLinks.js';
import { configuration } from './helpers.js';
import { PanelFixture } from './panel-fixture.js';

export const OLD_BODY = '# 完整结果\n\n消息正文必须完整保留，不只复制简短结论。\n\n'
  + Array.from({ length: 12 }, (_, i) => `第${i + 1}项：保留真实依据与完整执行记录。`).join('\n\n')
  + '\n\n完整正文独有尾段：你好，世界 🌏。';
export const REPORT_BODY = '# 旧报告\n\n关联报告全文与代码。\n\n```ts\nconst result = "原样保留";\n```\n';
export const HTML_BODY = '<!doctype html>\n<html><script>alert("只能作为源代码带走")</script><body>中文 🌏</body></html>\n';
export const OLD_SOURCE = 'https://example.com/old-evidence?version=1';
export const A_EVENT = '成员A折叠执行记录的完整内容。';
export const B_EVENT = '成员B执行记录不得混入成员A。';
export const TRACE_DETAIL = '原始调度详情：核对版本后提交，不能只保留事件名称。';
export const UNLINKED_BODY = '未关联报告正文不得混入消息详情。';
export const FOREIGN_BODY = '其他任务报告正文不得混入旧任务。';

export function detailSnapshot(): RoomSnapshot {
  const old: WebTask = {
    id: 'old-task', goal: '旧任务方案', owner: 'A', phase: 'ended', outcome: 'complete', reason: '已完成旧任务核查。',
    usage: { ordinary: 3, checks: 1 }, limits: { ordinary: 300, checks: 30 },
    artifacts: [
      { id: 'report', name: '旧方案.md', content: REPORT_BODY, goalVersion: 1, author: 'A', workId: 'old-work-A' },
      { id: 'unlinked', name: '未关联核查.md', content: UNLINKED_BODY, goalVersion: 1, author: 'B' },
      { id: 'html', name: '代码示例.html', content: HTML_BODY, goalVersion: 1, author: 'A' },
    ],
    board: [{ id: 'evidence', author: 'B', kind: 'evidence', text: '旧任务已核对官方资料。',
      sources: [OLD_SOURCE], verified: true, revision: 1, goalVersion: 1 }],
    trace: [{ event: 'DELIVER', detail: TRACE_DETAIL, at: 1000 }],
  };
  const newer: WebTask = {
    ...old, id: 'new-task', goal: '新任务禁止串入', owner: 'B', phase: 'running', outcome: null,
    artifacts: [{ id: 'report', name: '新任务.md', content: FOREIGN_BODY, goalVersion: 1, author: 'B' }],
    board: [], trace: [],
  };
  return {
    room: { id: 'detail-room', title: '详情复制验证', createdAt: 0 },
    agents: configuration().bots.map(bot => ({ ...bot, model: `${bot.id}-model` })),
    tasks: [old, newer], activeTaskId: newer.id,
    messages: [
      { id: 'old-message', taskId: old.id, author: 'A', kind: 'final', text: '只是一句简短结论。', detailText: OLD_BODY,
        artifactIds: ['report', 'missing'], workId: 'old-work-A', at: 1000 },
      { id: 'new-message', taskId: newer.id, author: 'B', kind: 'answer', text: '新消息独有正文。', at: 2000 },
    ],
    works: [
      { id: 'old-work-A', taskId: old.id, agentId: 'A', kind: 'owner', status: 'done', attempt: 1, requestCount: 2,
        model: 'A-model', reason: 'A的执行原因。', epoch: 1 },
      { id: 'old-work-B', taskId: old.id, agentId: 'B', kind: 'assistance', status: 'done', attempt: 1, requestCount: 1,
        model: 'B-model', reason: 'B的执行原因。', epoch: 1 },
    ],
    events: [
      { id: 1, taskId: old.id, workId: 'old-work-A', agentId: 'A', kind: 'tool-result', title: 'A读取资料', detail: A_EVENT, at: 1000 },
      { id: 2, taskId: old.id, workId: 'old-work-B', agentId: 'B', kind: 'output', title: 'B的核查', detail: B_EVENT, at: 1001 },
      { id: 3, taskId: newer.id, workId: 'new-work-B', agentId: 'B', kind: 'output', title: '其他任务执行', detail: FOREIGN_BODY, at: 2000 },
    ], modelConfigured: true, serverTime: 2000,
  };
}

export interface DetailView {
  snapshot: RoomSnapshot | null;
  target?: DetailTarget | undefined;
  agent?: WebAgent | null | undefined;
  connected?: boolean | undefined;
}
export interface CapturedDownload { name: string; url: string; blob: Blob }
interface ClipboardCall { text: string; resolve: () => void; reject: (reason?: unknown) => void }
let fixtureSequence = 0;

/** Uses a simulated DOM for user events; native clipboard and download are separately browser-verified. */
export class DetailActionsFixture {
  readonly dom = new PanelFixture();
  readonly copies: ClipboardCall[] = [];
  readonly downloads: CapturedDownload[] = [];
  readonly revoked: string[] = [];
  readonly urls = new Map<string, Blob>();
  clipboardMode: 'resolved' | 'pending' | 'rejected' | 'unavailable' = 'resolved';
  failDownload = false;
  failAnchorClick = false;
  private readonly sequence = ++fixtureSequence;
  private root: Root | undefined;
  private component: typeof import('../web/src/Details.js').Details | undefined;
  private readonly originalURL = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  private view: DetailView;
  private visible = true;

  constructor(view: DetailView = { snapshot: detailSnapshot(), target: { taskId: 'old-task', messageId: 'old-message' } }) {
    this.view = view;
    const fixture = this;
    const clipboard = { writeText(text: string) {
      return new Promise<void>((resolve, reject) => {
        fixture.copies.push({ text, resolve, reject });
        if (fixture.clipboardMode === 'resolved') resolve();
        else if (fixture.clipboardMode === 'rejected') reject(new Error('clipboard denied'));
      });
    } };
    Object.defineProperty(this.dom.window.navigator, 'clipboard', { configurable: true,
      get: () => fixture.clipboardMode === 'unavailable' ? undefined : clipboard });
    const url = this.dom.window.URL;
    url.createObjectURL = (blob) => {
      if (fixture.failDownload) throw new Error('download unavailable');
      const id = `blob:detail-test-${fixture.sequence}-${fixture.urls.size + 1}`;
      fixture.urls.set(id, blob as unknown as Blob); return id;
    };
    // A previous fixture's delayed timer may run after this DOM became global.
    url.revokeObjectURL = (id: string) => { if (fixture.urls.has(id)) fixture.revoked.push(id); };
    Object.defineProperty(globalThis, 'URL', { configurable: true, writable: true, value: url });
    this.dom.window.HTMLAnchorElement.prototype.click = function () {
      if (fixture.failAnchorClick) throw new Error('download click failed');
      const blob = fixture.urls.get(this.href); assert(blob, 'The download must refer to a created Blob URL');
      fixture.downloads.push({ name: this.download, url: this.href, blob });
    };
  }
  get window() { return this.dom.window; }
  get container() { return this.dom.container; }
  get requests() { return this.dom.requests; }
  private render() {
    this.root!.render(this.visible ? createElement(this.component!, {
      snapshot: this.view.snapshot, agent: this.view.agent ?? null, target: this.view.target,
      connected: this.view.connected ?? true,
      onClose: () => { this.visible = false; this.render(); },
    }) : null);
  }
  async mount() {
    const [{ createRoot }, { Details }] = await Promise.all([import('react-dom/client'), import('../web/src/Details.js')]);
    this.component = Details; this.root = createRoot(this.container);
    await act(async () => { this.render(); }); return this;
  }
  async update(view: DetailView) { this.view = view; await act(async () => { this.render(); }); }
  button(label: string) { return this.dom.label(label) as HTMLButtonElement; }
  async click(label: string) { await act(async () => { this.button(label).click(); }); }
  async tab(label: string) {
    await act(async () => {
      const tab = [...this.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el => el.textContent?.includes(label));
      assert(tab, `Tab ${label}`); tab.click();
    });
  }
  async settleCopy(success = true, index = this.copies.length - 1) {
    await act(async () => { const call = this.copies[index]; assert(call); success ? call.resolve() : call.reject(new Error('late clipboard refusal')); });
  }
  get feedback() { return [...this.container.querySelectorAll('[role="status"],[role="alert"]')].map(el => el.textContent ?? '').join('\n'); }
  async downloadText(index = this.downloads.length - 1) { const item = this.downloads[index]; assert(item); return item.blob.text(); }
  async waitForRevoke() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  }
  async close() {
    if (this.root) { await act(async () => { this.root!.unmount(); }); this.root = undefined; }
    if (this.originalURL) Object.defineProperty(globalThis, 'URL', this.originalURL); else Reflect.deleteProperty(globalThis, 'URL');
    await this.dom.close();
  }
}
