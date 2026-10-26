import { afterEach, describe, expect, it } from 'vitest';
import { buildDetailDocument } from '../web/src/detail-document.js';
import { DetailActionsFixture, detailSnapshot, OLD_BODY, type DetailView } from './detail-actions-fixture.js';

const opened: DetailActionsFixture[] = [];
async function fixture(view?: DetailView, pending = false) {
  const f = new DetailActionsFixture(view); opened.push(f); if (pending) f.clipboardMode = 'pending'; return f.mount();
}
afterEach(async () => { for (const f of opened.splice(0).reverse()) await f.close(); });

describe('detail transfer edge cases', () => {
  it('[BT_A19] keeps a pending copy when polling replaces the snapshot object with identical content', async () => {
    const snapshot = detailSnapshot(), target = { taskId: 'old-task', messageId: 'old-message' };
    const f = await fixture({ snapshot, target }, true);
    await f.click('复制详情'); await f.update({ snapshot: structuredClone(snapshot), target });
    expect(f.button('复制详情').disabled).toBe(true); expect(f.copies).toHaveLength(1);
    await f.settleCopy(); expect(f.feedback).toContain('已复制');
  });

  it('[BT_A19] does not revive an old receipt after leaving a document and returning to it', async () => {
    const snapshot = detailSnapshot(), target = { taskId: 'old-task', messageId: 'old-message' };
    const f = await fixture({ snapshot, target }, true); await f.click('复制详情');
    await f.update({ snapshot, target: { taskId: 'new-task', messageId: 'new-message' } });
    await f.update({ snapshot, target });
    expect(f.button('复制详情').disabled).toBe(false);
    await f.settleCopy(); expect(f.feedback).not.toContain('已复制'); expect(f.feedback).not.toContain('复制失败');
  });

  it('[BT_A17] exports the same complete document while clipboard confirmation is pending', async () => {
    const f = await fixture(undefined, true); await f.click('复制详情'); await f.click('导出详情');
    expect(f.copies).toHaveLength(1); expect(f.downloads).toHaveLength(1);
    expect(await f.downloadText()).toBe(f.copies[0]!.text); expect(f.copies[0]!.text).toContain(OLD_BODY);
    expect(f.requests).toEqual([]);
  });

  it('[BT_A15] exports member information even when that member has not run yet', async () => {
    const snapshot = detailSnapshot(); snapshot.works = []; snapshot.events = []; snapshot.tasks.forEach(task => { task.artifacts = []; });
    const agent = snapshot.agents.find(agent => agent.id === 'A')!;
    expect(buildDetailDocument(snapshot, { agent })?.content).toContain(agent.instructions);
    const f = await fixture({ snapshot, agent }); await f.click('复制详情');
    expect(f.copies[0]!.text).toContain(agent.instructions); expect(f.copies[0]!.text).toContain('暂无执行记录');
  });

  it('[BT_A13] [BT_A20] requests a valid dotfile name and preserves its source bytes', async () => {
    const snapshot = detailSnapshot(), artifact = snapshot.tasks[0]!.artifacts[0]!;
    artifact.name = '.env'; artifact.content = 'MODEL_URL=https://example.com/mock\n';
    const f = await fixture({ snapshot, target: { taskId: 'old-task', artifactId: artifact.id } });
    await f.click('导出详情'); expect(f.downloads[0]!.name).toBe('.env'); expect(await f.downloadText()).toBe(artifact.content);
  });

  it('[BT_A20] [BT_A21] releases the Blob URL and removes the temporary node even when the download click fails', async () => {
    const f = await fixture(); f.failAnchorClick = true; await f.click('导出详情');
    expect(f.feedback).toContain('导出失败'); expect(f.downloads).toHaveLength(0);
    expect(f.window.document.querySelector('a[download]')).toBeNull();
    await f.waitForRevoke(); expect(f.revoked).toEqual([...f.urls.keys()]);
  });
});
