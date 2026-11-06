import { describe, expect, it } from 'vitest';
import { InspectorTabFixture } from './inspector-tab-fixture.js';

describe('official Inspector tab', () => {
  it('[BT_V29] opens on the click stack, preserves local UI and only focuses a repeated click', async () => {
    const test = new InspectorTabFixture();
    try {
      await test.open(); await test.click(); await test.navigated(); test.assertOpened();
      await test.handshake(); test.assertRegistration();
      await test.click(); test.assertOpened(); expect(test.tab.focused).toBe(1);
      expect(test.ui.text).toContain('如出现401，请在Stately页面登录');
      expect(document.querySelector('[aria-label="本次运行轨迹"]')).not.toBeNull();
    } finally { await test.close(); }
  });
  it('[BT_V30] displays popup blocking and retries with the latest selection', async () => {
    const test = new InspectorTabFixture();
    try {
      await test.open(true); await test.click(); expect(test.tabs).toHaveLength(0);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('允许弹窗');
      await test.ui.sendHelp(); test.blocked = false; await test.click(); await test.navigated();
      await test.handshake(); test.assertRegistration();
      expect(test.tab.messages[0]?.snapshot?.value).toBe('waitingAssistance');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally { await test.close(); }
  });
  it('[BT_V31] changes identities without navigation and ignores the replaced tab and unmounted updates', async () => {
    const test = new InspectorTabFixture();
    try {
      await test.open(); await test.click(); await test.navigated(); await test.handshake();
      const first = test.tab, session = first.messages[0]?.sessionId;
      await test.ui.click('新建沙箱');
      expect(test.tab).toBe(first); expect(first.navigations).toHaveLength(1);
      const registration = first.messages.filter(message => message.type === '@xstate.actor').at(-1)!;
      expect(registration.sessionId).not.toBe(session); test.assertRegistration();
      first.closed = true; await test.click(); await test.navigated();
      const second = test.tab; expect(second).not.toBe(first);
      await test.handshake(first); expect(second.messages).toHaveLength(0);
      await test.handshake(); test.assertRegistration();
      await test.close(); const count = second.messages.length;
      expect(second.closed).toBe(false);
      await test.handshake(second); expect(second.messages).toHaveLength(count);
    } finally { await test.close(); }
  });

});
