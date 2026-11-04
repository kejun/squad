import { describe, expect, it, vi } from 'vitest';
import { Actor } from 'xstate';
import { inspectorOrigin } from '../src/inspector.machine.js';
import { InspectorFixture } from './inspector-fixture.js';

describe('official Inspector transport', () => {
  it('[BT_V27] registers a handshake during navigation without starting business work', () => {
    const test = new InspectorFixture();
    const start = vi.spyOn(Actor.prototype, 'start');
    const send = vi.spyOn(Actor.prototype, 'send');
    try {
      const bridge = test.open(true);
      test.assertRegistration(test.messages[0], false);
      bridge.update(test.latest()); test.assertOrdered();
      expect(start).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
      bridge.stop();
    } finally { test.observer?.stop(); start.mockRestore(); send.mockRestore(); }
  });

  it('[BT_V27] registers the latest frame when the handshake follows navigation', () => {
    const test = new InspectorFixture(), bridge = test.open(false);
    try {
      bridge.update(test.latest());
      expect(test.messages).toHaveLength(0);

      test.handshake();

      test.assertRegistration(test.messages[0], true);
      test.assertOrdered();
    } finally { bridge.stop(); }
  });

  it('[BT_V28] validates source and origin, re-registers latest and detaches on close', () => {
    const test = new InspectorFixture(), bridge = test.open(false);
    test.handshake(inspectorOrigin, {}); test.handshake('https://example.org');
    expect(test.messages).toHaveLength(0);
    test.handshake(); bridge.update(test.latest());
    let count = test.messages.length;
    test.handshake(inspectorOrigin, {}); test.handshake('null');
    expect(test.messages).toHaveLength(count);
    test.handshake(); test.assertRegistration(test.messages[count], true); test.assertOrdered();
    bridge.stop(); expect(test.messages.at(-1)?.type).toBe('@statelyai.disconnected');
    count = test.messages.length;
    bridge.update(test.initial()); test.handshake();
    test.staleListener?.({ data: { type: '@statelyai.connected' }, source: test.source, origin: inspectorOrigin });
    bridge.stop();
    expect(test.messages).toHaveLength(count); expect(test.closedCount).toBe(1);
    const replacement = new InspectorFixture(); replacement.open(true, 'another-task');
    expect(replacement.messages[0]!.sessionId).not.toBe(test.messages[0]!.sessionId);
    replacement.assertOrdered(); replacement.observer!.stop();
  });
});
