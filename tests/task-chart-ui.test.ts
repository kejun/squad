import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { DebugUIFixture } from './task-debug-ui-fixture.js';

let ui: DebugUIFixture | undefined;
afterEach(async () => { await ui?.close(); ui = undefined; });
async function openGraph() {
  ui = new DebugUIFixture(); await ui.open(); await ui.click('完整状态图'); return ui;
}
async function activateGraphControl(fixture: DebugUIFixture, label: string, key = 'Enter') {
  const control = document.querySelector('[aria-label="' + label + '"]');
  expect(control, 'Graph control: ' + label).not.toBeNull();
  await act(async () => { control!.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event); });
}

describe('statechart interactions', () => {
  it('[BT_V32] opens every aggregated branch by keyboard and selects a later automatic condition', async () => {
    const fixture = await openGraph();

    await activateGraphControl(fixture, '执行中 到 协调中 的5条规则', ' ');

    expect([...document.querySelectorAll('[aria-label="连线分支"] button[aria-label^="查看规则 "]')].map(node => node.getAttribute('aria-label'))).toEqual([
      '查看规则 running:BLOCKED:1', '查看规则 running:TICK:0', '查看规则 running:FAILURE_SIGNAL:0',
      '查看规则 running:@always:1', '查看规则 running:@always:2',
    ]);
    expect(document.querySelector('[aria-label="规则详情"]')).toBeNull();
    await fixture.click('查看规则 running:@always:2');
    expect(document.querySelector('[aria-label="规则详情"]')!.textContent).toContain('deferredReady');
    expect(fixture.phase).toBe('running');
    expect(fixture.requests).toEqual([]);
  });

  it('[BT_V34] exposes global entry conditions and internal handling outside the local overview', async () => {
    const fixture = await openGraph();

    await fixture.click('查看全局进入 interpreting');
    const rule = [...document.querySelectorAll('[aria-label="连线分支"] button')].find(button => button.textContent?.includes('analysisReady'));
    expect(rule).toBeDefined(); await fixture.click(rule!.getAttribute('aria-label')!);

    expect(document.querySelector('[aria-label="规则详情"]')!.textContent).toContain('analysisReady');
    await fixture.click('关闭规则详情');
    await activateGraphControl(fixture, '查看内部规则 ended');
    await fixture.click('查看规则 ended:STOP:0');
    expect(document.querySelector('[aria-label="规则详情"]')!.textContent).toContain('空处理');
    expect(fixture.phase).toBe('running');
    expect(fixture.requests).toEqual([]);
  });

  it('[BT_V33] draws captured stop microsteps and keeps the latest execution head while viewing history', async () => {
    ui = new DebugUIFixture(); await ui.open();
    await ui.choose('STOP'); await ui.click('单步执行');

    await ui.click('完整状态图'); await ui.click('所选步骤路径');

    expect([...document.querySelectorAll('[aria-label="所选步骤路径"] ol li')].map(node => node.textContent)).toEqual([
      expect.stringMatching(/执行中.*停止中/), expect.stringMatching(/停止中.*本轮已结束.*自动处理|自动处理.*停止中.*本轮已结束/),
    ]);
    expect(document.querySelectorAll('.debug-edge.is-recorded')).toHaveLength(2);
    await ui.click('当前运行'); await ui.click('查看步骤 0');
    await ui.click('完整状态图'); await ui.click('所选步骤路径');
    expect(document.querySelector('[aria-label="所选步骤路径"]')!.textContent).not.toContain('停止任务');
    expect(ui.phase).toBe('ended');
    await ui.click('当前运行');
    expect(document.querySelectorAll('.debug-history li')).toHaveLength(2);
    expect(ui.requests).toEqual([]);
  });

  it('[BT_V33] clears captured-rule selection when the selected step advances', async () => {
    ui = new DebugUIFixture(); await ui.open();
    await ui.choose('STOP'); await ui.click('单步执行');
    await ui.click('完整状态图'); await ui.click('所选步骤路径');
    await ui.click('查看所选步骤命中的规则 · 2条');
    expect(document.querySelector('[aria-label="连线分支"]')!.textContent).toContain('停止任务');

    await ui.choose('CONTINUE'); await ui.click('单步执行');

    expect(document.querySelector('[aria-label="连线分支"]')).toBeNull();
    expect(document.querySelector('[aria-label="所选步骤路径"]')!.textContent).toContain('继续执行');
    expect(ui.phase).toBe('running');
    expect(ui.requests).toEqual([]);
  });


});
