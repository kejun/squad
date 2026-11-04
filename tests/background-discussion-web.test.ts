import { describe, it } from 'vitest';
import { verifyWebDiscussion } from './background-discussion-web-fixture.js';
describe('background discussion through the real HTTP host', () => {
  // discussion-first, room isolation and denied claims run directly in Gherkin.
  it.each(['owner-first', 'stop'] as const)('[BT_T12] [BT_T08] actually runs idle members before the held owner request returns: %s', async order => { await verifyWebDiscussion(order); });
});
