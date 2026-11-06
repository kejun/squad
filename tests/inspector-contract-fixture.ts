import assert from 'node:assert/strict';

export async function disposedImportContract() {
  const { createInspectorWindow } = await import('../web/src/inspector-window.js');
  const { InspectorFixture } = await import('./inspector-fixture.js');
  const fixture = new InspectorFixture();
  let resolve!: (module: typeof import('../web/src/inspector-bridge.js')) => void;
  let watched = 0, listeners = 0;
  const target = { closed: false, location: { href: 'about:blank' }, focus() {}, postMessage() { throw new Error('No data after disposal'); } };
  const session = createInspectorWindow({
    open: () => target,
    listen: () => { listeners++; return () => { listeners--; }; },
    watchClosed: () => { watched++; return () => { watched--; }; },
  }, () => {}, () => new Promise(ready => { resolve = ready; }));
  session.open({ identity: 'late', frame: fixture.initial() }); session.dispose();
  resolve(await import('../web/src/inspector-bridge.js')); await Promise.resolve();
  assert.equal(target.location.href, 'about:blank'); assert.equal(watched, 0); assert.equal(listeners, 0);
}
