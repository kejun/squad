import { describe, expect, it } from 'vitest';
import { Harness } from './helpers.js';

describe('model output capacity state boundary', () => {
  it('[BT_M32] preserves an unchecked candidate without retry on permanent check capacity failure', () => {
    const h = new Harness();
    h.event({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
    const check = h.claim('check');
    h.event({ type: 'CONSUME', intentId: check.id, fence: check });

    const result = h.event({ type: 'WORK_FAILED', intentId: check.id, reason: 'CHECK_OUTPUT_LIMIT', transient: false, fence: check });

    expect(result.ok).toBe(true);
    expect(h.view().phase).toBe('ended');
    expect(h.context().outcome).toBe('partial');
    expect(h.context().reason).toContain('CHECK_OUTPUT_LIMIT');
    expect(h.context().usage.retries).toBe(0);
    expect(h.engine.pending(h.room, h.task)).toEqual([]);
    h.store.close();
  });
});
