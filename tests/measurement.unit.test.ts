import { describe, expect, it } from 'vitest';
import { coveredDuration, providerUsage } from '../src/measurement.js';

describe('execution measurement', () => {
  it('[BT_Z02] measures the union of overlapping and separate complete intervals', () => {
    const intervals = [[14, 20], [6, 13], [0, 8], [4, 6]] as const;

    const duration = coveredDuration(intervals);

    expect(duration).toBe(19);
  });

  it('[BT_Z01] retains real zero usage and reports missing counters as unknown', () => {
    const response = { usage: { prompt_tokens: 0, completion_tokens: 42, total_tokens: 'unknown' } };

    const usage = providerUsage(response);

    expect(usage).toEqual({ input: 0, output: 42, total: null });
  });
});
