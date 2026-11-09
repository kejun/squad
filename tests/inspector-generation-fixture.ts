import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createInspectorWindow, type InspectorTarget, type InspectorWindowStatus } from '../web/src/inspector-window.js';
import { connectInspector, type InspectorMessage } from '../web/src/inspector-bridge.js';
import { inspectorOrigin } from '../src/inspector.machine.js';
import { InspectorFixture } from './inspector-fixture.js';

interface Observation { type: string; sessionId?: string; snapshot?: { value: string } }
interface Target extends InspectorTarget { closed: boolean; navigations: string[]; messages: Observation[]; focused: number }
type LoadedBridge = { connectInspector: typeof connectInspector };
function deferred() {
  let resolve!: (value: LoadedBridge) => void, reject!: (cause: Error) => void;
  const promise = new Promise<LoadedBridge>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Finite two-generation schedules drive the production controller and real SDK bridge. */
export class InspectorGenerationFixture {
  private readonly model = new InspectorFixture();
  readonly targets: Target[] = [];
  readonly notifications: InspectorWindowStatus[] = [];
  readonly loads: ReturnType<typeof deferred>[] = [];
  private readonly listeners = new Set<(event: InspectorMessage) => void>();
  private readonly watches = new Set<() => void>();
  private readonly controller = createInspectorWindow({
    open: () => {
      const navigations: string[] = [], messages: Observation[] = [];
      const target: Target = { closed: false, navigations, messages, focused: 0,
        location: { get href() { return navigations.at(-1) ?? 'about:blank'; }, set href(url: string) { navigations.push(url); } },
        focus() { this.focused++; },
        postMessage(message, origin) { assert.equal(origin, inspectorOrigin); messages.push(structuredClone(message) as Observation); },
      };
      this.targets.push(target); return target;
    },
    listen: receive => { this.listeners.add(receive); return () => { this.listeners.delete(receive); }; },
    watchClosed: check => { this.watches.add(check); return () => { this.watches.delete(check); }; },
  }, status => this.notifications.push(status), () => { const load = deferred(); this.loads.push(load); return load.promise; });

  prepare() {
    this.controller.open({ identity: 'old-generation', frame: this.model.initial() });
    assert.equal(this.targets.length, 1); assert.equal(this.loads.length, 1);
    this.targets[0]!.closed = true;
    for (const check of [...this.watches]) check();
    this.controller.open({ identity: 'new-generation', frame: this.model.initial() });
    this.controller.update({ identity: 'latest-selection', frame: this.model.latest() });
    assert.equal(this.targets.length, 2); assert.equal(this.loads.length, 2);
    assert.equal(this.watches.size, 1);
  }
  private handshake(source: Target, origin = inspectorOrigin) {
    for (const receive of [...this.listeners]) receive({ data: { type: '@statelyai.connected' }, source, origin });
  }
  async complete(order: string, oldResult: string) {
    assert(['旧代先完成', '新代先完成'].includes(order)); assert(['成功', '失败'].includes(oldResult));
    const settleOld = async () => {
      const count = this.notifications.length;
      if (oldResult === '成功') this.loads[0]!.resolve({ connectInspector });
      else this.loads[0]!.reject(new Error('obsolete generation failed'));
      await Promise.resolve(); await Promise.resolve();
      assert.equal(this.notifications.length, count, 'StaleGenerationFeedback: obsolete loading must not change current status');
    };
    const settleNew = async () => {
      this.loads[1]!.resolve({ connectInspector }); await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(this.targets[1]!.navigations, [inspectorOrigin + '/inspect']);
    };
    if (order === '旧代先完成') { await settleOld(); await settleNew(); }
    else { await settleNew(); await settleOld(); }
    this.handshake(this.targets[0]!); this.handshake(this.targets[1]!, 'https://example.invalid');
    assert.equal(this.targets[1]!.messages.length, 0, 'Untrusted handshakes cannot register any actor');
    this.handshake(this.targets[1]!);
  }
  assertCurrent() {
    const [old, current] = this.targets;
    assert(old && current);
    assert.deepEqual(old.navigations, [], 'StaleGenerationNavigation: replaced window cannot navigate');
    assert.deepEqual(old.messages, [], 'StaleGenerationDelivery: replaced window cannot receive data');
    assert.equal(current.messages[0]?.type, '@xstate.actor');
    assert.equal(current.messages[0]?.snapshot?.value, 'ended', 'LatestSelection: load completion uses the latest selected snapshot');
    const registered = new Set<string>();
    for (const message of current.messages) {
      if (message.type === '@xstate.actor') registered.add(message.sessionId!);
      if (['@xstate.event', '@xstate.snapshot'].includes(message.type)) assert(registered.has(message.sessionId!), 'RegisterBeforeSnapshot');
    }
    assert.equal(this.notifications.at(-1)?.phase, 'connected');
    assert(!this.notifications.some(status => status.phase === 'error'));
    this.controller.open({ identity: 'latest-selection', frame: this.model.latest() });
    assert.equal(this.targets.length, 2); assert.equal(current.focused, 1); assert.equal(current.navigations.length, 1);
  }
  close() {
    const staleListeners = [...this.listeners];
    this.controller.dispose();
    assert.equal(this.listeners.size, 0); assert.equal(this.watches.size, 0);
    const count = this.targets[1]?.messages.length ?? 0;
    for (const receive of staleListeners) receive({ data: { type: '@statelyai.connected' }, source: this.targets[1], origin: inspectorOrigin });
    this.controller.update({ identity: 'after-dispose', frame: this.model.initial() });
    assert.equal(this.targets[1]?.messages.length ?? 0, count, 'DisposedDelivery: late callbacks cannot send more snapshots');
  }
  report() { return { windows: this.targets.map(({ navigations, messages, focused }) => ({ navigations, messages: messages.map(message => message.type), focused })), notifications: this.notifications }; }
}

export async function verifyInspectorGenerations() {
  const reports = [];
  for (const order of ['旧代先完成', '新代先完成']) for (const result of ['成功', '失败']) {
    const fixture = new InspectorGenerationFixture();
    try { fixture.prepare(); await fixture.complete(order, result); fixture.assertCurrent(); }
    finally { fixture.close(); }
    reports.push({ order, result, ...fixture.report() });
  }
  return reports;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await verifyInspectorGenerations()));
