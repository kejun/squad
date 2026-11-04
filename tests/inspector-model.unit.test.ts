import { describe, expect, it } from 'vitest';
import { initialTransition, transition } from 'xstate';
import { inspectorMachine, inspectorWindowMachine, inspectorOrigin, type InspectorFrame } from '../src/inspector.machine.js';

const frame = (value = 'running'): InspectorFrame => ({ snapshot: { value }, event: undefined });
const connect = { type: 'CONNECT' as const, origin: inspectorOrigin, fromTarget: true };
function connectedObserver() {
  const [waiting] = initialTransition(inspectorMachine, frame());
  return transition(inspectorMachine, waiting, connect)[0];
}
function openedWindow() {
  const [initial] = initialTransition(inspectorWindowMachine);
  const [opening] = transition(inspectorWindowMachine, initial, { type: 'OPEN' });
  return transition(inspectorWindowMachine, opening, { type: 'OPENED' })[0];
}

describe('Inspector observation model', () => {
  it('[BT_V27] registers the latest selection when a trusted handshake arrives', () => {
    const [initial] = initialTransition(inspectorMachine, frame());
    const latest = frame('ended');
    const [waiting] = transition(inspectorMachine, initial, { type: 'UPDATE', frame: latest });
    expect(waiting.context.delivery).toBeNull();

    const [connected] = transition(inspectorMachine, waiting, connect);

    expect(connected.value).toBe('connected');
    expect(connected.context.delivery).toEqual({ sequence: 1, kind: 'register', frame: latest });
  });

  it('[BT_V27] delivers an update after registration with the next sequence', () => {
    const connected = connectedObserver();
    const latest = frame('ended');

    const [updated] = transition(inspectorMachine, connected, { type: 'UPDATE', frame: latest });

    expect(updated.context.delivery).toEqual({ sequence: 2, kind: 'update', frame: latest });
  });

  it.each([
    { name: 'wrong source', origin: inspectorOrigin, fromTarget: false },
    { name: 'foreign origin', origin: 'https://example.org', fromTarget: true },
    { name: 'opaque origin', origin: 'null', fromTarget: true },
  ])('[BT_V28] refuses a handshake from $name', ({ origin, fromTarget }) => {
    const [waiting] = initialTransition(inspectorMachine, frame());

    const [rejected] = transition(inspectorMachine, waiting, { type: 'CONNECT', origin, fromTarget });

    expect(rejected.value).toBe('waiting');
    expect(rejected.context.delivery).toBeNull();
  });

  it('[BT_V28] re-registers on a repeated trusted handshake', () => {
    const connected = connectedObserver();

    const [registered] = transition(inspectorMachine, connected, connect);

    expect(registered.context.delivery).toEqual({ sequence: 2, kind: 'register', frame: frame() });
  });

  it.each([
    connect,
    { type: 'UPDATE' as const, frame: frame('ended') },
    { type: 'SELECT' as const, frame: frame('ended') },
  ])('[BT_V28] ignores a late $type event after closing', event => {
    const [closed] = transition(inspectorMachine, connectedObserver(), { type: 'CLOSE' });

    const [after] = transition(inspectorMachine, closed, event);

    expect(after.value).toBe('closed');
    expect(after.context.delivery).toEqual({ sequence: 2, kind: 'disconnect', frame: frame() });
  });

  it('[BT_V28] closes an unconnected channel without a delivery', () => {
    const [waiting] = initialTransition(inspectorMachine, frame());

    const [closed] = transition(inspectorMachine, waiting, { type: 'CLOSE' });

    expect(closed.value).toBe('closed');
    expect(closed.context.delivery).toBeNull();
  });

  it('[BT_V31] registers a changed selection before delivering its updates', () => {
    const selected = frame('ended');

    const [state] = transition(inspectorMachine, connectedObserver(), { type: 'SELECT', frame: selected });

    expect(state.value).toBe('connected');
    expect(state.context.delivery).toEqual({ sequence: 2, kind: 'register', frame: selected });
  });
});

describe('Inspector tab lifecycle model', () => {
  it('[BT_V29] requests opening when no tab exists', () => {
    const [closed] = initialTransition(inspectorWindowMachine);

    const [opening] = transition(inspectorWindowMachine, closed, { type: 'OPEN' });

    expect(opening.value).toBe('opening');
    expect(opening.context.effect).toEqual({ kind: 'open', sequence: 1 });
  });

  it('[BT_V29] requests focus when the tab is already open', () => {
    const [state] = transition(inspectorWindowMachine, openedWindow(), { type: 'OPEN' });

    expect(state.value).toBe('open');
    expect(state.context.effect).toEqual({ kind: 'focus', sequence: 2 });
  });

  it('[BT_V30] retries a blocked opening with a new open intent', () => {
    const [initial] = initialTransition(inspectorWindowMachine);
    const [opening] = transition(inspectorWindowMachine, initial, { type: 'OPEN' });
    const [blocked] = transition(inspectorWindowMachine, opening, { type: 'BLOCKED' });

    const [retried] = transition(inspectorWindowMachine, blocked, { type: 'OPEN' });

    expect(retried.value).toBe('opening');
    expect(retried.context.effect).toEqual({ kind: 'open', sequence: 2 });
  });

  it('[BT_V31] opens a replacement after the previous tab closes', () => {
    const [closed] = transition(inspectorWindowMachine, openedWindow(), { type: 'WINDOW_CLOSED' });
    expect(closed.context.effect?.kind).toBe('disconnect');

    const [replacement] = transition(inspectorWindowMachine, closed, { type: 'OPEN' });

    expect(replacement.context.effect).toEqual({ kind: 'open', sequence: 3 });
  });

  it.each(['OPENED', 'OPEN', 'WINDOW_CLOSED'] as const)('[BT_V31] ignores late %s after disposal', type => {
    const [disposed] = transition(inspectorWindowMachine, openedWindow(), { type: 'DISPOSE' });

    const [after] = transition(inspectorWindowMachine, disposed, { type });

    expect(after.value).toBe('disposed');
    expect(after.context.effect).toEqual({ kind: 'disconnect', sequence: 2 });
  });
});
