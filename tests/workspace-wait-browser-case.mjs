import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureCheck } from './delivery-protocol-fixture.ts';

/** The adapter is the controlled provider boundary. CLI requests still pass
 * through WorkRunner, durable resource claims, real authorization and spawn. */
export function workspaceWaitAdapter(fixture) {
  const marker = join(fixture.outer, 'new-host-started.txt');
  fixture.workspaceWait = { marker, oldStarts: 0 };
  const action = { type: 'runCli', executable: process.execPath,
    args: ['-e', 'require("node:fs").appendFileSync(process.argv[1], "new-host-once\\n"); console.log("new-host-receipt")', marker],
    execution: 'host', reason: '读取已有宿主登录态；先核对旧执行并明确批准本次命令' };
  return { execute: async (work, signal, scope) => {
    if (work.kind === 'check') return fixtureCheck(work.payload.candidate);
    assert(scope.localTools, 'The real runner must expose its authorized local tools');
    const result = await scope.localTools.invoke(action, [{ role: 'assistant', content: JSON.stringify(action) }], signal);
    assert(result.ok, JSON.stringify(result));
    return { type: 'deliver', text: '新宿主命令已完成并保留真实回执', artifactIds: [],
      artifacts: [{ name: 'host-receipt.md', content: String(result.data.stdout) }] };
  } };
}

const currentSnapshot = fixture => fixture.host.service.snapshot(fixture.workspaceWait.currentRoom.id);
const currentContext = fixture => fixture.engine.view(fixture.workspaceWait.currentRoom.id, fixture.workspaceWait.currentTask).context;
const currentOperation = fixture => currentContext(fixture).intents.flatMap(work => work.localOperations ?? [])[0];
const reviewDialog = fixture => fixture.page.getByRole('dialog', { name: '执行资源等待核对', exact: true });

export async function prepareWorkspaceWait(fixture) {
  const state = fixture.workspaceWait;
  const backend = fixture.runtime.backend;
  const execute = backend.execute.bind(backend);
  backend.execute = (...args) => { state.oldStarts++; return execute(...args); };
  await fixture.unknownOperation();
  state.source = { roomId: fixture.room.id, roomTitle: fixture.room.title, taskId: fixture.taskId, ...fixture.operation };
  fixture.event({ type: 'STOP' });
  assert(fixture.context().stopped);
  const sourceOperation = fixture.context().intents.find(work => work.id === state.source.workId).localOperations.find(op => op.id === state.source.operationId);
  assert.equal(sourceOperation.status, 'uncertain');
  assert.equal(state.oldStarts, 1, 'The source operation must be one actual process');
  await fixture.page.reload();
  await fixture.dismissFresh();
  state.currentRoom = await fixture.host.createRoom();
  await fixture.host.send('运行新的宿主命令，完成后保存真实执行回执');
  await fixture.host.until(() => currentSnapshot(fixture).tasks.at(-1)?.id, Boolean, 'new task saved through the UI');
  state.currentTask = currentSnapshot(fixture).tasks.at(-1).id;
  await fixture.host.until(() => currentOperation(fixture), op => op?.status === 'queued', 'new command blocked before claim');
  assert.equal(currentSnapshot(fixture).hostApprovals.length, 0, 'Queued command has no authorization token');
  assert(!existsSync(state.marker), 'Queued command must not have started');
  state.window = structuredClone(currentContext(fixture).resilience.window);
  state.initial = currentSnapshot(fixture);
  await writeFile(join(fixture.host.evidence, 'current-wait.snapshot.json'), JSON.stringify(state.initial, null, 2));
  await fixture.host.capture('given-resource-wait');
}

export async function actWorkspaceWait(fixture) {
  const state = fixture.workspaceWait;
  const dialog = reviewDialog(fixture);
  await dialog.waitFor();
  await dialog.getByText(`来源会话：${state.source.roomTitle}`, { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '允许本次', exact: true }).count(), 0);
  await fixture.page.getByText('等待执行资源', { exact: true }).waitFor();
  await fixture.page.getByTitle('等待资源', { exact: true }).waitFor();
  await fixture.host.capture('source-review-visible');
  await dialog.getByRole('button', { name: '暂时关闭处理提示', exact: true }).click();
  assert.equal(fixture.host.posts.filter(post => /operation-reconcile|host-approval/.test(post.path)).length, 0);
  assert.equal(currentOperation(fixture).status, 'queued');
  assert(!existsSync(state.marker));
  await fixture.page.reload();
  await dialog.waitFor();
  assert.equal(currentSnapshot(fixture).hostApprovals.length, 0);
  const response = fixture.page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/operation-review'));
  await dialog.getByRole('button', { name: '核对执行', exact: true }).click();
  const reviewResponse = await response;
  state.reviewUrl = new URL(reviewResponse.url());
  state.review = await reviewResponse.json();
  assert.equal(state.reviewUrl.pathname, `/api/rooms/${state.source.roomId}/operation-review`);
  for (const name of ['taskId', 'workId', 'operationId']) assert.equal(state.reviewUrl.searchParams.get(name), state.source[name]);
  assert.equal(state.review.processState, 'exited');
  const receipt = dialog.getByLabel('原执行回执和文件清单');
  await receipt.waitFor();
  assert((await receipt.textContent()).includes('原操作已退出，外部效果仍需核对'));
  assert.equal(currentOperation(fixture).status, 'queued');
  assert(!existsSync(state.marker));
  await dialog.getByRole('button', { name: '确认已核对执行效果', exact: true }).click();
  const approvalDialog = fixture.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true });
  await approvalDialog.waitFor();
  assert.equal(await reviewDialog(fixture).count(), 0, 'Resolved source prompt must close on polling');
  assert((await approvalDialog.getByLabel('请求执行的完整命令').textContent()).includes(state.marker));
  state.approval = currentSnapshot(fixture).hostApprovals[0];
  assert.equal(currentOperation(fixture).status, 'awaitingApproval');
  assert(!existsSync(state.marker), 'Resource release must not grant host execution');
  assert.equal(fixture.host.posts.filter(post => post.path.endsWith('/host-approval')).length, 0);
  await fixture.host.capture('new-command-awaiting-approval');
  await approvalDialog.getByRole('button', { name: '允许本次', exact: true }).click();
}

export async function verifyWorkspaceWait(fixture) {
  const state = fixture.workspaceWait;
  await fixture.host.until(() => currentOperation(fixture), op => op?.status === 'succeeded', 'new host process settles');
  assert.equal(await readFile(state.marker, 'utf8'), 'new-host-once\n');
  assert.equal(state.oldStarts, 1, 'Reconciliation must not replay the old process');
  const reviews = fixture.host.posts.filter(post => post.path.endsWith('/operation-reconcile'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].path, `/api/rooms/${state.source.roomId}/operation-reconcile`);
  for (const name of ['taskId', 'workId', 'operationId']) assert.equal(reviews[0].body[name], state.source[name]);
  assert.equal(reviews[0].body.reviewDigest, state.review.reviewDigest);
  const approvals = fixture.host.posts.filter(post => post.path.endsWith('/host-approval'));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].path, `/api/rooms/${state.currentRoom.id}/host-approval`);
  assert.equal(approvals[0].body.taskId, state.currentTask);
  assert.equal(approvals[0].body.operationId, state.approval.operationId);
  assert.equal(approvals[0].body.approvalId, state.approval.approvalId);
  assert.equal(approvals[0].body.decision, 'approve');
  assert.equal(currentOperation(fixture).result.data.execution, 'host');
  assert.equal(currentSnapshot(fixture).blockers.filter(blocker => blocker.source?.roomId === state.source.roomId).length, 0);
  assert.deepEqual(currentContext(fixture).resilience.window, state.window, 'Release and approval cannot extend the processing window');
  assert(fixture.context().stopped, 'Reviewing effects must preserve the old task stop');
  await fixture.host.capture('then');
  await writeFile(join(fixture.host.evidence, 'current-settled.snapshot.json'), JSON.stringify(currentSnapshot(fixture), null, 2));
  await writeFile(join(fixture.host.evidence, 'sqlite-readback.json'), JSON.stringify(fixture.host.readDatabase(), null, 2));
  if (!fixture.host.completed.includes(fixture.id)) fixture.host.completed.push(fixture.id);
}
