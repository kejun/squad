import { describe, expect, it } from 'vitest';
import { conversationHistory } from '../src/conversation.js';
import { initialTask } from '../src/task.machine.js';
import type { ArtifactSource } from '../src/types.js';
import { localModelInput } from './local-model-fixture.js';

function legacySource() {
  const task = initialTask(localModelInput()).context;
  const source: ArtifactSource = { sourceTaskId: task.taskId, artifactId: 'legacy-report', documentId: 'legacy-report',
    revision: 1, name: 'result.md', owner: 'A', publishedAt: 10, content: '# 原始长回答\n' + '完整原文'.repeat(200), contentHash: 'a'.repeat(64) };
  task.artifacts.push({ id: source.artifactId, name: source.name, content: source.content, goalVersion: 1 });
  task.messages.push({ id: 'final', taskId: task.taskId, author: 'A', kind: 'final', at: 10,
    text: '已完成，查看完整报告', detailText: source.content, artifactIds: [source.artifactId] });
  return { task, source };
}

describe('fixed source history material', () => {
  it('[BT_A34] passes a legacy long answer once through the fixed source while retaining the original message', () => {
    const { task, source } = legacySource(); const before = structuredClone(task);

    const history = conversationHistory([task], source);

    expect(history.artifacts).toEqual([]);
    expect(history.messages.at(-1)).toMatchObject({ id: 'final', text: '已完成，查看完整报告', artifactIds: [source.artifactId] });
    expect(history.messages.at(-1)).not.toHaveProperty('detailText');
    expect(JSON.stringify(history)).not.toContain(source.content);
    expect(task).toEqual(before);
  });

  it('[BT_A34] replaces a legacy full-text message with a data note only in the new history', () => {
    const { task, source } = legacySource(); task.messages.at(-1)!.text = source.content;

    const history = conversationHistory([task], source);

    expect(history.messages.at(-1)!.text).toBe('[来源正文已作为固定输入提供]');
    expect(history.messages.at(-1)!.artifactIds).toEqual([source.artifactId]);
    expect(task.messages.at(-1)!.text).toBe(source.content);
  });
});
