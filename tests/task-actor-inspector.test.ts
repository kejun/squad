import { it, expect, vi } from 'vitest';
import { Actor } from 'xstate';
import { ActorInspector } from './task-actor-inspector-fixture.js';
it('[BT_N13] observes true parent and child machine identities without starting or sending business work', () => {
  const test = new ActorInspector();
  const start = vi.spyOn(Actor.prototype, 'start'), send = vi.spyOn(Actor.prototype, 'send');
  try { test.verify(); expect(start).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); }
  finally { start.mockRestore(); send.mockRestore(); }
});
