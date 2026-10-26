import type { RoomSnapshot, WebTask } from '../src/web/contracts.js';
import type { Intent, TaskEvent } from '../src/index.js';
import { configuration, type Harness } from './helpers.js';

export const RESULT_SUMMARY = '建议保留版本围栏和共享黑板，完整方案已生成。';
export const FULL_REPORT = '# 恢复方案\n\n保留版本围栏、原子保存和结果去重。\n\n'
  + Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 项：核对原任务的目标版本和执行身份，记录完整结果后再交接负责人。`).join('\n\n')
  + '\n\n来源：[官方依据](https://example.com/evidence)。\n\n独特尾段：报告全文必须保留。';
export const HELPER_SUMMARY = '核查通过，需保留事务与版本校验。';
export const HELPER_REPORT = FULL_REPORT.replace('恢复方案', '核查报告');

export function delivery(h: Harness, work: Intent, id = 'artifact-delivery'): Extract<TaskEvent, { type: 'DELIVER' }> {
  return { type: 'DELIVER', id, at: h.now, workId: work.id,
    fence: { epoch: work.epoch, goalVersion: work.goalVersion }, text: FULL_REPORT,
    summary: RESULT_SUMMARY, artifactIds: [], artifacts: [{ name: '恢复方案.md', content: FULL_REPORT }] };
}

export function helperDelivery(h: Harness, work: Intent): Extract<TaskEvent, { type: 'RECORD_RESULT' }> {
  return { type: 'RECORD_RESULT', id: 'helper-artifact-result', at: h.now, workId: work.id,
    fence: { epoch: work.epoch, goalVersion: work.goalVersion }, requestId: 'H1', resultId: 'helper-result',
    status: 'success', answer: HELPER_REPORT, summary: HELPER_SUMMARY,
    artifacts: [{ name: '核查报告.md', content: HELPER_REPORT }] };
}

export function artifactSnapshot(): RoomSnapshot {
  const task: WebTask = { id: 'old-task', goal: '恢复方案', owner: 'A', phase: 'ended', outcome: 'complete', reason: '',
    usage: { ordinary: 3, checks: 1 }, limits: { ordinary: 300, checks: 30 },
    artifacts: [{ id: 'old-report', name: '恢复方案.md', content: FULL_REPORT, goalVersion: 1, author: 'A', workId: 'old-work' }],
    board: [{ id: 'evidence1', author: 'B', text: '已经核对官方资料。', kind: 'evidence', sources: ['https://example.com/evidence'], verified: true, revision: 1, goalVersion: 1 }],
    trace: [{ event: 'DELIVER', detail: 'old-work', at: 1 }] };
  const newer: WebTask = { ...task, id: 'new-task', goal: '新任务', phase: 'running', outcome: null,
    artifacts: [{ id: 'new-report', name: '新任务.md', content: '不应展示的新任务报告正文。', goalVersion: 1 }], board: [], trace: [] };
  return { room: { id: 'room1', title: '恢复讨论', createdAt: 0 },
    agents: configuration().bots.map(bot => ({ ...bot, model: 'test-model' })),
    messages: [{ id: 'old-result', taskId: task.id, author: 'A', kind: 'final', text: RESULT_SUMMARY,
      detailText: FULL_REPORT, artifactIds: ['old-report'], workId: 'old-work', at: 1 }],
    tasks: [task, newer], activeTaskId: newer.id,
    works: [{ id: 'old-work', taskId: task.id, agentId: 'A', kind: 'owner', status: 'done', attempt: 1, requestCount: 2, model: 'test-model', reason: '准备恢复方案', epoch: 1 }],
    events: [{ id: 1, taskId: task.id, workId: 'old-work', agentId: 'A', at: 1, kind: 'tool-result', title: '读取官方资料', detail: '工具依据：版本围栏必须保留。https://example.com/evidence' }],
    modelConfigured: true, serverTime: 2 };
}
