import { afterEach, describe, it } from 'vitest';
import { DebugUIFixture } from './task-debug-ui-fixture.js';
import assert from 'node:assert/strict';
import { debugHost } from './task-debug-fixture.js';
import { assertDefaultUI, assertDraftHistory, assertForkUI, finishDiscussionWithoutOwner, prepareDraftHistory, prepareForkUI,
  verifyDiagnosticPaths, verifyDiscussionWait, verifyExpiredAndBudget, verifyLegacyGap, verifyPreviewAndHead, verifyRetryAndEmpty, verifyStableGraph } from './task-debug-behavior.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const open = async () => { const ui = new DebugUIFixture(); cleanup.push(() => ui.close()); await ui.open(); return ui; };
describe('debugging a current run', () => {
  it('[BT_V16] records actual same-computation paths and fallback', verifyDiagnosticPaths);
  it('[BT_V17] distinguishes short-circuit and no-op from rejection', verifyRetryAndEmpty);
  it('[BT_V18] previews without advancing and appends from the execution head', verifyPreviewAndHead);
  it('[BT_V19] starts with waiting work, trace and step evidence', async () => { const ui = await open(); await ui.sendHelp(); assertDefaultUI(ui); });
  it('[BT_V20] preserves a draft while viewing historical rules', async () => { const ui = await open(); await prepareDraftHistory(ui); assertDraftHistory(ui); });
  it('[BT_V21] forks without deleting the source run', async () => { const ui = await open(); const source = await prepareForkUI(ui); await assertForkUI(ui, source); });
  it('[BT_V22] keeps positions stable and every rule reachable', async () => { await verifyStableGraph(await open()); });
  it('[BT_V23] exposes missing evidence and bounded history gaps', verifyLegacyGap);
  it('[BT_V24] distinguishes a ready discussion from unfinished owner work', () => verifyDiscussionWait(finishDiscussionWithoutOwner()));
  it('[BT_V25] invalidates stale previews and preserves budget rejection', verifyExpiredAndBudget);
  it('[BT_V26] keeps a historical selection while the real committed feed advances', async () => {
    const host = await debugHost(); const ui = new DebugUIFixture(host);
    cleanup.push(async () => { await ui.close(); await host.close(); });
    await ui.open(); await ui.waitFor(() => ui.phase === 'running'); await ui.click('查看步骤 0');
    host.service.engine.send(host.room.id, host.taskId, { type: 'HELP', id: 'live-help', at: 1, requestId: 'live-H', caller: 'A', target: 'B', question: '核对', expected: '依据' });
    await ui.waitFor(() => ui.phase === 'waitingAssistance');
    assert(document.querySelector('[aria-label="步骤详情"]')!.textContent!.includes('@init'));
    assert(ui.text.includes('正在查看历史步骤'));
    await ui.click('返回最新');
    assert(document.querySelector('[aria-label="步骤详情"]')!.textContent!.includes('HELP'));
    assert(document.querySelector('[aria-label="步骤详情"]')!.textContent!.includes('当次转换采集'));
  });
});
