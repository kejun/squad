import assert from 'node:assert/strict';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { detailSnapshot } from './detail-actions-fixture.js';
import { SourceUIFixture } from './artifact-source-ui-fixture.js';
import { canReferenceArtifact } from '../web/src/ResultLinks.js';

const opened: SourceUIFixture[] = [];
async function fixture(snapshot = detailSnapshot()) { const f = new SourceUIFixture(snapshot); opened.push(f); return f.mount(); }
const metadata = { sourceTaskId: 'old-task', artifactId: 'report', documentId: 'doc:report', revision: 1,
  name: '旧方案.md', owner: 'A', publishedAt: 1000, contentHash: '1'.repeat(64) };

afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.close(); });

describe('source artifact composer and details', () => {
  it('[BT_A38] copies only a removable exact reference from the published preview into a new request', async () => {
    const f = await fixture();
    await f.reference(); await f.text('补充部署说明，输出为 b.md'); await f.click('发送消息');
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.sourceArtifact).toEqual({ sourceTaskId: 'old-task', artifactId: 'report' });
    expect(JSON.stringify(f.posts[0])).not.toContain('旧报告');
    expect(f.posts[0]).not.toHaveProperty('replyToTaskId');
    expect(f.dom.draft).toBe(''); expect(f.body).not.toContain('移除产物引用');
  });

  it('[BT_A38] preserves input and the selected reference on busy rejection, then sends a new request ID', async () => {
    const f = await fixture(); await f.reference(); await f.text('补充部署说明');
    f.response = { status: 409, value: { error: '群内已有活动任务，请结束后重发。', code: 'ROOM_BUSY' } };
    await f.click('发送消息'); expect(f.dom.draft).toBe('补充部署说明');
    assert(f.dom.container.querySelector('[aria-label="移除产物引用"]'));
    f.response = { status: 200, value: { ok: true } }; await f.click('发送消息');
    expect(f.posts[0]!.id).not.toBe(f.posts[1]!.id);
    expect(f.posts[1]!.sourceArtifact).toEqual(f.posts[0]!.sourceArtifact);
  });

  it('[BT_A38] reuses the full request after an uncertain network failure and changes ID after removing the source', async () => {
    const f = await fixture(); await f.reference(); await f.text('补充部署说明');
    f.networkFailure = true; await f.click('发送消息'); await f.click('发送消息');
    expect(f.posts[0]).toEqual(f.posts[1]);
    await f.click('移除产物引用'); await f.click('发送消息');
    expect(f.posts[2]!.id).not.toBe(f.posts[1]!.id); expect(f.posts[2]).not.toHaveProperty('sourceArtifact');
  });

  it('[BT_A33] never attaches an automatic human decision to a selected artifact revision', async () => {
    const f = await fixture(); await f.reference();
    const snapshot = structuredClone(f.snapshot); snapshot.activeTaskId = 'new-task'; snapshot.tasks[1]!.phase = 'waitingHuman';
    await f.update(snapshot); await f.text('补充部署说明'); await f.click('发送消息');
    expect(f.posts[0]).not.toHaveProperty('intent'); expect(f.posts[0]).not.toHaveProperty('replyToTaskId');
  });

  it('[BT_A33] keeps a direct artifact command separate from an automatic waiting-human decision', async () => {
    const f = await fixture();
    const snapshot = structuredClone(f.snapshot); snapshot.activeTaskId = 'new-task'; snapshot.tasks[1]!.phase = 'waitingHuman';
    await f.update(snapshot); await f.text('修改 旧方案.md，补充部署说明'); await f.click('发送消息');
    expect(f.posts[0]).not.toHaveProperty('intent'); expect(f.posts[0]).not.toHaveProperty('replyToTaskId');
  });

  it('[BT_A31] requires a confirmed publication list for a legacy successful artifact', () => {
    const snapshot = detailSnapshot(), task = snapshot.tasks[0]!;
    expect(canReferenceArtifact(task, task.artifacts[0]!)).toBe(false);
    task.currentArtifactIds = ['report'];
    expect(canReferenceArtifact(task, task.artifacts[0]!)).toBe(true);
  });

  it('[BT_A31] offers no reference action for failed or unpublished artifacts', async () => {
    const snapshot = detailSnapshot(); snapshot.tasks[0]!.outcome = 'partial';
    const f = await fixture(snapshot); await f.click('查看 旧方案.md');
    expect(f.dom.container.querySelector('[aria-label="引用到新任务"]')).toBeNull();
  });

  it('[BT_A30] shows metadata-only ambiguous choices and uses a fresh exact reference after selection', async () => {
    const f = await fixture(); await f.text('修改 旧方案.md，补充部署说明');
    f.response = { status: 409, value: { error: '请选择来源产物', code: 'SOURCE_AMBIGUOUS', sourceCandidates: [metadata] } };
    await f.click('发送消息'); expect(f.dom.draft).toBe('修改 旧方案.md，补充部署说明');
    const candidate = f.dom.container.querySelector<HTMLButtonElement>('[aria-label="选择来源 旧方案.md old-task"]');
    assert(candidate, 'a source choice must identify its name and task'); await act(async () => { candidate.click(); });
    f.response = { status: 200, value: { ok: true } }; await f.click('发送消息');
    expect(f.posts[1]!.sourceArtifact).toEqual({ sourceTaskId: 'old-task', artifactId: 'report' });
    expect(f.posts[1]!.id).not.toBe(f.posts[0]!.id);
  });

  it('[BT_A29] opens the exact source from both task details and the revised artifact preview', async () => {
    const snapshot = detailSnapshot(); snapshot.tasks[1]!.sourceArtifact = metadata;
    const f = await fixture(snapshot);
    await f.click('查看 新任务.md'); await f.click('来源 旧方案.md');
    expect(f.dom.container.querySelector('[aria-label="报告预览"]')?.textContent).toContain('旧报告');
    expect(f.dom.container.querySelector('[aria-label="报告预览"]')?.textContent).not.toContain('其他任务报告正文');
  });
});
