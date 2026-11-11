import assert from 'node:assert/strict';

/** The target has a real exited child whose effects remain unknown. The UI
 * deletes it from another selected room, through the normal confirmation. */
export async function prepareArchiveDeleteFeedback(fixture) {
  await fixture.unknownOperation();
  fixture.event({ type: 'STOP' });
  fixture.event({ type: 'SUPERVISE', trigger: 'timer' });
  fixture.other = fixture.host.service.createRoom('删除期间保留的当前会话');
  await fixture.page.reload();
  await fixture.page.getByRole('heading', { name: fixture.room.title, exact: true, includeHidden: true }).waitFor();
  await fixture.dismissFresh();
  await fixture.page.getByRole('button', { name: `归档群聊 ${fixture.room.title}`, exact: true }).click();
  await fixture.host.until(() => fixture.page.evaluate(() => localStorage.getItem('squad-room')),
    roomId => roomId === fixture.other.id, 'archive selects the independent current room');
  await fixture.page.getByRole('heading', { name: fixture.other.title, exact: true }).waitFor();
  fixture.otherDraft = '删除目标不能清除当前会话的草稿';
  await fixture.page.getByRole('textbox', { name: '群聊消息输入框' }).fill(fixture.otherDraft);
  await fixture.page.getByRole('button', { name: /^已归档/ }).click();
  await fixture.page.getByRole('navigation', { name: '归档群聊列表', exact: true })
    .getByRole('button', { name: fixture.room.title, exact: true }).waitFor();
  await fixture.host.capture('given');
}

export async function actArchiveDeleteFeedback(fixture) {
  const { page, host } = fixture;
  await page.getByRole('button', { name: `删除归档群聊 ${fixture.room.title}`, exact: true }).click();
  await page.getByRole('dialog', { name: '删除归档群聊', exact: true })
    .getByRole('button', { name: '确认永久删除', exact: true }).click();
  const progress = page.getByRole('dialog', { name: /正在准备删除|删除等待核对|删除已暂停/ });
  try { await progress.waitFor({ state: 'visible' }); }
  catch (error) { await host.capture('accepted-without-progress'); throw error; }
  await host.until(() => fixture.snapshot().room.deletion?.status, status => status === 'waiting', 'real deletion waits for unknown effects');
  await progress.getByRole('status').waitFor();
  fixture.facts.progress = await progress.textContent();
  assert(fixture.facts.progress.includes('核对'));
  fixture.facts.immediateProgress = true;
  await host.capture('accepted-progress');
  await progress.getByRole('button', { name: '关闭删除提示', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '群聊消息输入框' }).inputValue(), fixture.otherDraft);
  await page.reload();
  await page.getByRole('heading', { name: fixture.other.title, exact: true }).waitFor();
  await page.getByRole('button', { name: /^已归档/ }).click();
  await page.getByRole('button', { name: `查看删除状态 ${fixture.room.title}`, exact: true }).click();
  await page.getByRole('dialog', { name: '删除等待核对', exact: true }).waitFor();
  fixture.facts.reopenedAfterRefresh = true;
  await host.capture('when');
}

export async function verifyArchiveDeleteFeedback(fixture) {
  const { page, host } = fixture;
  assert(fixture.facts.immediateProgress && fixture.facts.reopenedAfterRefresh);
  assert.equal(await page.evaluate(() => localStorage.getItem('squad-room')), fixture.other.id);
  assert.equal((await host.get('/rooms/' + fixture.room.id)).status, 200);
  assert.equal((await host.get('/rooms/' + fixture.other.id)).status, 200);
  assert.equal(fixture.snapshot().room.deletion.status, 'waiting');
  const operation = fixture.context().intents.find(work => work.id === fixture.operation.workId)
    .localOperations.find(op => op.id === fixture.operation.operationId);
  assert.equal(operation.status, 'uncertain');
  assert.equal(host.posts.filter(post => post.path.endsWith('/delete')).length, 1);
  assert.equal(host.posts.filter(post => post.path.endsWith('/operation-reconcile')).length, 0);
  assert.equal(host.posts.filter(post => post.path.endsWith('/delete-retry')).length, 0);
  await page.getByRole('dialog', { name: '删除等待核对', exact: true })
    .getByText('全部清理核对完成后才会移除此会话。需要核对的执行可从该会话的待处理请求进入。', { exact: true }).waitFor();
  await host.capture('then');
  if (!host.completed.includes(fixture.id)) host.completed.push(fixture.id);
}
