import assert from 'node:assert/strict';
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

export async function* passesALegacyLongAnswerOnceThroughTheFixedSourceWhileRetainingTheOriginalMessage() {
const { task, source } = legacySource();
const before = structuredClone(task);
yield 'prepared';
const history = conversationHistory([task], source);
yield 'observed';
assert.deepEqual(history.artifacts, []);
assert.partialDeepStrictEqual(history.messages.at(-1), { id: 'final', text: '已完成，查看完整报告', artifactIds: [source.artifactId] });
assert(!Object.hasOwn(history.messages.at(-1)!, 'detailText'));
assert(!(JSON.stringify(history)).includes(source.content));
assert.deepEqual(task, before);
}

export async function* replacesALegacyFullTextMessageWithADataNoteOnlyInTheNewHistory() {
const { task, source } = legacySource();
task.messages.at(-1)!.text = source.content;
yield 'prepared';
const history = conversationHistory([task], source);
yield 'observed';
assert.equal(history.messages.at(-1)!.text, '[来源正文已作为固定输入提供]');
assert.deepEqual(history.messages.at(-1)!.artifactIds, [source.artifactId]);
assert.equal(task.messages.at(-1)!.text, source.content);
}
