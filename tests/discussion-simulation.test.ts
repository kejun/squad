import { describe, expect, it } from 'vitest';
import { runDiscussionSimulations } from '../scripts/simulate-discussion.js';
describe('bounded XState discussion simulation', () => {
  it('[BT_V13] [BT_T06] checks every legal completion order and lifecycle boundaries using the production state machine', () => {
    const report = runDiscussionSimulations();
    expect(report.cases.filter(item => !item.passed).map(item => ({ name: item.name, error: item.error }))).toEqual([]);
    expect(report.responseOrders).toBe(144); expect(report.total).toBeGreaterThan(180);
    expect(report.states).toHaveLength(report.totalStates);
  });
});
