import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Message } from '../src/types.js';
import type { RoomSnapshot, WebTask } from '../src/web/contracts.js';
import { Details } from '../web/src/Details.js';
import { artifactsForAgent, hasMessageDetails, messageArtifacts, ResultLinks } from '../web/src/ResultLinks.js';
import { Workspace } from '../web/src/App.js';
import type { useWorkspace } from '../web/src/api.js';
import { configuration } from './helpers.js';

function fixture(): RoomSnapshot {
  const task: WebTask = { id: 'old', goal: '旧方案', owner: 'A', phase: 'ended', outcome: 'complete', reason: '',
    usage: { ordinary: 3, checks: 1 }, limits: { ordinary: 300, checks: 30 }, board: [], trace: [],
    artifacts: [{ id: 'report', name: '核查报告.md', content: '# 完整核查\n\n旧报告独有正文。', goalVersion: 1, author: 'B' }] };
  return { room: { id: 'room', title: '方案', createdAt: 0 }, agents: configuration().bots.map(bot => ({ ...bot, model: 'test' })),
    tasks: [task, { ...task, id: 'new', goal: '新任务不得串入', owner: 'builder-1', artifacts: [{ id: 'foreign', name: '其他报告.md', content: '新任务不得串入', goalVersion: 1 }] }],
    messages: [{ id: 'result', taskId: 'old', kind: 'answer', author: 'B', text: '核查通过。', detailText: '完整核查结果。', artifactIds: ['report', 'foreign', 'missing'], at: 1 }],
    works: [], events: [], activeTaskId: 'new', modelConfigured: true, serverTime: 1 };
}
function render(snapshot: RoomSnapshot, target: { taskId: string; messageId?: string; artifactId?: string }) {
  return renderToStaticMarkup(createElement(Details, { snapshot, target, agent: null, connected: true, onClose() {} }));
}

describe('artifact and message details', () => {
  it('[BT_A09] exposes only report references that exist inside the same task', () => {
    const s = fixture(); const message = s.messages[0]!;
    expect(messageArtifacts(s, message).map(item => item.id)).toEqual(['report']);
    const html = renderToStaticMarkup(createElement(ResultLinks, { snapshot: s, message, onOpen() {} }));
    expect(html).toContain('核查报告.md'); expect(html).not.toContain('其他报告.md'); expect(html).not.toContain('missing');
  });
  it('[BT_A09] never falls back to the latest task for unavailable historical content', () => {
    const s = fixture();
    for (const target of [{ taskId: 'gone' }, { taskId: 'old', artifactId: 'foreign' }, { taskId: 'old', messageId: 'gone' }]) {
      const html = render(s, target); expect(html).toContain('内容已不可用'); expect(html).not.toContain('新任务不得串入');
    }
  });
  it('[BT_A08] keeps legacy long replies reachable while short replies need no empty details', () => {
    const s = fixture(); s.tasks[0]!.artifacts = [];
    const short: Message = { id: 'short', taskId: 'old', kind: 'answer', author: 'A', text: '可以。', at: 0 };
    expect(hasMessageDetails(s, short)).toBe(false);
    expect(renderToStaticMarkup(createElement(ResultLinks, { snapshot: s, message: short, onOpen() {} }))).toBe('');
    const long = { ...short, id: 'long', text: '这是旧消息的完整内容。'.repeat(90) };
    s.messages.push(long);
    expect(hasMessageDetails(s, long)).toBe(true);
    expect(render(s, { taskId: 'old', messageId: 'long' })).toContain(long.text);
  });
  it('[BT_A02] attributes a helper report to its author instead of the task owner', () => {
    const s = fixture();
    expect(artifactsForAgent(s, 'B').map(item => item.id)).toEqual(['report']);
    expect(artifactsForAgent(s, 'A')).toEqual([]);
  });
  it('[BT_A10] renders report Markdown and links safely without executing embedded HTML', () => {
    const s = fixture(); s.tasks[0]!.artifacts[0]!.content = '# 完整报告\n\n[依据](https://example.com/evidence)\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))';
    const html = render(s, { taskId: 'old', artifactId: 'report' });
    expect(html).toContain('<h1>完整报告</h1>'); expect(html).toContain('href="https://example.com/evidence"');
    expect(html).toContain('aria-label="下载 核查报告.md"'); expect(html).not.toContain('<script>'); expect(html).not.toContain('href="javascript:');
  });
  it('[BT_A10] preserves HTML and other code artifacts as literal source text', () => {
    const s = fixture(); const report = s.tasks[0]!.artifacts[0]!;
    report.name = 'demo.html'; report.content = '<!doctype html><html><script>alert(1)</script><body>完整代码</body></html>';
    const html = render(s, { taskId: 'old', artifactId: 'report' });
    expect(html).toContain('class="report-plain"');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;body&gt;完整代码&lt;/body&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('aria-label="下载 demo.html"');
  });
  it('[BT_A01] keeps partial delivery visible without marking it as a completed success', () => {
    const s = fixture(); s.tasks[0]!.outcome = 'partial'; s.messages[0]!.kind = 'final';
    const workspace: ReturnType<typeof useWorkspace> = { rooms: [s.room], roomId: s.room.id, snapshot: s, connected: true, error: '',
      setError() {}, chooseRoom() {}, createRoom: async () => s.room.id, refreshRooms: async () => [s.room] };
    const html = renderToStaticMarkup(createElement(Workspace, { workspace }));
    expect(html).toContain('部分交付');
    const label = html.match(/class="delivery-label"[^>]*>([\s\S]*?)<\/span>/)?.[1];
    expect(label).not.toContain('lucide-check');
    expect(html).not.toContain('完整核查结果。'); expect(html).not.toContain('旧报告独有正文。');
  });
});
