import { HostApprovalUIFixture } from '../host-approval-ui-fixture.js';
// Cucumber also imports SSR components before it creates a DOM. Isolate Base UI's DOM initialization.
const fixture = new HostApprovalUIFixture();
process.on('message', (command: string) => {
  void (async () => {
    if (command === 'open') await fixture.open();
    else if (command === 'interact') { await fixture.dismissAndReopen(); await fixture.retryDenial(); await fixture.switchRoomDoesNotDecide(); }
    else if (command === 'close') await fixture.close();
    else throw new Error('Unknown UI fixture command');
    process.send?.({ ok: true, posts: fixture.posts });
    if (command === 'close') process.disconnect();
  })().catch(error => process.send?.({ ok: false, error: String(error), stack: error instanceof Error ? error.stack : '' }));
});
