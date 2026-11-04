import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Real hosted page, isolated production app, anonymous browser and synthetic data only.
export async function verifyInspector({ page, context, dialog, evidence, capture, until, run }) {
  const errors = [], graphResponses = [], responseTasks = [], opened = [];
  const graphResponse = response => {
    if (response.url().includes('machines.getDigraphConfigs')) responseTasks.push((async () => {
      graphResponses.push({ url: response.url(), status: response.status(), body: await response.text() });
    })());
  };
  const observe = tab => {
    opened.push(tab);
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => {
      if (message.type() === 'error' && /TypeError|reading ['"]config|Something went wrong/.test(message.text())) errors.push(message.text());
    });
  };
  context.on('page', observe); context.on('response', graphResponse);
  await context.addInitScript(() => {
    window.__squadInspection = []; window.__squadLifecycle = [];
    window.addEventListener('message', message => {
      if (message.data?.type?.startsWith('@xstate.')) window.__squadInspection.push(message.data);
      if (message.data?.type?.startsWith('@statelyai.')) window.__squadLifecycle.push(message.data.type);
    });
  });
  let popup;
  const messages = async () => {
    try { return await popup.evaluate(() => window.__squadInspection ?? []); } catch { return []; }
  };
  async function open() {
    const created = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: '官方 Inspector', exact: true }).click();
    popup = await created;
    await popup.waitForURL('https://stately.ai/registry/inspect', { timeout: 45000 });
    assert.equal(await popup.opener(), page);
    assert(await popup.evaluate(() => window.self === window.top && window.opener !== null));
    assert.equal(await page.locator('iframe').count(), 0);
    await dialog.getByRole('region', { name: '本次运行轨迹', exact: true }).waitFor();
  }
  async function registered(label) {
    const received = await until(messages, events => events.some(event => event.type === '@xstate.snapshot'), label, 45000);
    assert.equal(received[0].type, '@xstate.actor');
    const definition = JSON.parse(received[0].definition);
    assert.deepEqual(Object.keys(definition.states).sort(), ['checking', 'coordinating', 'ended', 'interpreting', 'running', 'stopping', 'waitingAssistance', 'waitingHuman']);
    const registered = new Set();
    for (const event of received) {
      if (event.type === '@xstate.actor') registered.add(event.sessionId);
      else assert(registered.has(event.sessionId), 'Official page received snapshot/event before registration');
    }
    await popup.getByText('Actors', { exact: true }).waitFor({ timeout: 30000 });
    assert(!/Something went wrong/.test(await popup.locator('body').innerText()));
    return received;
  }
  async function captureTab(name) {
    await popup.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
    writeFileSync(join(evidence, name + '.aria.txt'), await popup.locator('body').ariaSnapshot());
  }
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const details = dialog.locator('.debug-advanced');
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    await open();
    const first = await registered('initial official tab registration');
    const rendering = await until(async () => ({
      rendered: await popup.getByText('waitingAssistance', { exact: true }).count() > 0,
      refused: graphResponses.some(response => response.status === 401 && response.body.includes('Sign in')),
    }), result => result.rendered || result.refused, 'official graph render or explicit authentication refusal', 45000);
    run.hostedGraph = rendering.rendered ? { status: 'verified' }
      : { status: 'not_verified', reason: 'Top-level anonymous Inspector still returns HTTP 401: Sign in to view hosted work. User login remains required.' };
    assert.match(await details.innerText(), /401.*Stately.*登录/);
    await capture('official-inspector-local'); await captureTab('official-inspector-tab');
    let navigations = 0;
    popup.on('framenavigated', frame => { if (frame === popup.mainFrame()) navigations++; });
    await dialog.getByRole('button', { name: '官方 Inspector', exact: true }).click();
    assert.equal(opened.length, 1); assert.equal(navigations, 0);
    const count = (await messages()).length;
    await dialog.getByRole('button', { name: '重置', exact: true }).click();
    await until(messages, events => events.length > count, 'official snapshot after reset');
    const afterReset = await registered('official reset');
    assert.equal(afterReset.at(-1).snapshot.value, 'running');
    assert.equal(afterReset.at(-1).sessionId, first[0].sessionId);
    writeFileSync(join(evidence, 'inspector-messages.json'), JSON.stringify(afterReset, null, 2));

    await popup.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    const reconnected = await registered('official tab reload');
    assert.equal(reconnected[0].sessionId, first[0].sessionId);
    const beforeSwitch = navigations;
    const choices = dialog.getByLabel('选择沙箱'), current = await choices.inputValue();
    const another = await choices.locator('option').evaluateAll((options, current) => options.find(option => option.value !== current)?.value, current);
    assert(another); await choices.selectOption(another);
    await until(messages, events => events.some(event => event.type === '@xstate.actor' && event.sessionId !== first[0].sessionId), 'new sandbox actor identity');
    const switched = await registered('official identity switch');
    assert.equal(navigations, beforeSwitch); assert.equal(opened.length, 1);
    writeFileSync(join(evidence, 'inspector-reconnected.json'), JSON.stringify({ reconnected, switched }, null, 2));
    await captureTab('official-inspector-reconnected');
    await popup.close(); await open();
    const reopened = await registered('closed tab replacement');
    assert.notEqual(reopened[0].sessionId, first[0].sessionId); assert.equal(opened.length, 2);
    await dialog.getByRole('button', { name: '关闭状态机调试', exact: true }).click();
    await until(() => popup.evaluate(() => window.__squadLifecycle), events => events.includes('@statelyai.disconnected'), 'panel close disconnects official tab');
    assert.equal(popup.isClosed(), false);
    writeFileSync(join(evidence, 'inspector-tabs.json'), JSON.stringify({ tabsOpened: opened.length, topLevel: true, opener: true, identitySwitchNavigations: 0, reopened }, null, 2));
    run.hostedConsoleErrors = errors;
    // Preserve hosted fetch diagnostics; reject the missing-machine crash specifically.
    assert.deepEqual(errors.filter(error => /reading ['"]config|Something went wrong/.test(error)), []);
    if (rendering.rendered) run.checks.push('official hosted state graph renders task states');
    run.checks.push('BT_V27-BT_V31 real top-level Inspector tab: opener, reuse, reset, reload registration, identity switch without navigation, close/reopen and panel disconnect');
  } finally {
    context.off('page', observe); context.off('response', graphResponse);
    await Promise.allSettled(responseTasks);
    writeFileSync(join(evidence, 'inspector-errors.json'), JSON.stringify(errors, null, 2));
    writeFileSync(join(evidence, 'inspector-graph-responses.json'), JSON.stringify(graphResponses, null, 2));
  }
}
