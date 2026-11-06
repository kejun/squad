import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoomSnapshot, WebTask } from '../src/web/contracts.js';
import { Details } from '../web/src/Details.js';
import { configuration } from './helpers.js';

export function reportUiSnapshot(): RoomSnapshot {
  const task: WebTask = { id: 'old', goal: '旧方案', owner: 'A', phase: 'ended', outcome: 'complete', reason: '',
    usage: { ordinary: 3, checks: 1 }, limits: { ordinary: 300, checks: 30 }, board: [], trace: [],
    artifacts: [{ id: 'report', name: '核查报告.md', content: '# 完整核查\n\n旧报告独有正文。', goalVersion: 1, author: 'B' }] };
  return { room: { id: 'room', title: '方案', createdAt: 0 }, agents: configuration().bots.map(bot => ({ ...bot, model: 'test' })),
    tasks: [task, { ...task, id: 'new', goal: '新任务不得串入', owner: 'builder-1', artifacts: [{ id: 'foreign', name: '其他报告.md', content: '新任务不得串入', goalVersion: 1 }] }],
    messages: [{ id: 'result', taskId: 'old', kind: 'answer', author: 'B', text: '核查通过。', detailText: '完整核查结果。', artifactIds: ['report', 'foreign', 'missing'], at: 1 }],
    works: [], events: [], activeTaskId: 'new', modelConfigured: true, serverTime: 1 };
}
export function renderReportDetails(snapshot: RoomSnapshot, target: { taskId: string; messageId?: string; artifactId?: string }) {
  return renderToStaticMarkup(createElement(Details, { snapshot, target, agent: null, connected: true, onClose() {} }));
}

