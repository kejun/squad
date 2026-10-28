import { describe, it } from 'vitest';
import { verifyDeniedClaimYield, verifyRoomIsolation, verifyWebDiscussion } from './background-discussion-web-fixture.js';
describe('background discussion through the real HTTP host', () => {
  it.each(['owner-first', 'discussion-first', 'stop'] as const)('[BT_T12] [BT_T08] actually runs idle members before the held owner request returns: %s', async order => { await verifyWebDiscussion(order); });
  it('[BT_T16] isolates identical work IDs and cancellation across rooms', verifyRoomIsolation);
  it('[BT_T17] yields after a denied claim and continues on the next command without duplicate requests', verifyDeniedClaimYield);
});
