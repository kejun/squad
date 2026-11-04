import { afterEach, it } from 'vitest';
import { HostApprovalUIFixture } from './host-approval-ui-fixture.js';
let fixture: HostApprovalUIFixture;
afterEach(async () => { await fixture?.close(); });
it('[BT_L30] closes without deciding, reopens the durable request and retries a failed denial', async () => {
  fixture = new HostApprovalUIFixture(); await fixture.open(); await fixture.dismissAndReopen(); await fixture.retryDenial(); await fixture.switchRoomDoesNotDecide();
});
