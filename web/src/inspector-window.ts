import { initialTransition, transition, type EventFrom } from 'xstate';
import { inspectorWindowMachine, type InspectorFrame } from '../../src/inspector.machine.js';
import type { InspectorMessage } from './inspector-bridge.js';

export interface InspectorTarget {
  readonly closed: boolean;
  readonly location: { href: string };
  focus(): void;
  postMessage(message: unknown, origin: string): void;
}
export interface InspectorWindowHost {
  open(): InspectorTarget | null;
  listen(receive: (event: InspectorMessage) => void): () => void;
  watchClosed(check: () => void): () => void;
}
export interface InspectorSelection { identity: string; frame: InspectorFrame }
export interface InspectorWindowStatus { phase: 'opening' | 'waiting' | 'connected' | 'blocked' | 'closed' | 'error'; error?: string }
type LoadBridge = () => Promise<Pick<typeof import('./inspector-bridge.js'), 'connectInspector'>>;

/** Execute only the window model's intents; open() stays inside the original click stack. */
export function createInspectorWindow(host: InspectorWindowHost, notify: (state: InspectorWindowStatus) => void,
  load: LoadBridge = () => import('./inspector-bridge.js')) {
  let [state] = initialTransition(inspectorWindowMachine);
  let performed = 0, generation = 0;
  let target: InspectorTarget | null = null;
  let latest: InspectorSelection;
  let bridge: ReturnType<typeof import('./inspector-bridge.js')['connectInspector']> | undefined;
  let unwatch: (() => void) | undefined;
  const failed = (cause: unknown) => notify({ phase: 'error', error: cause instanceof Error ? cause.message : 'Inspector 连接失败' });

  function disconnect() {
    generation++;
    unwatch?.(); unwatch = undefined;
    bridge?.stop(); bridge = undefined;
    target = null;
  }
  function checkClosed() {
    if (target?.closed) { dispatch({ type: 'WINDOW_CLOSED' }); notify({ phase: 'closed' }); }
  }
  function dispatch(event: EventFrom<typeof inspectorWindowMachine>) {
    [state] = transition(inspectorWindowMachine, state, event);
    const effect = state.context.effect;
    if (!effect || effect.sequence === performed) return;
    performed = effect.sequence;
    if (effect.kind === 'disconnect') { disconnect(); return; }
    if (effect.kind === 'focus') { target?.focus(); return; }
    let opened: InspectorTarget | null;
    try { opened = host.open(); } catch { opened = null; }
    if (!opened) { dispatch({ type: 'BLOCKED' }); notify({ phase: 'blocked' }); return; }
    target = opened;
    dispatch({ type: 'OPENED' });
    notify({ phase: 'opening' });
    const token = ++generation;
    unwatch = host.watchClosed(checkClosed);
    void load().then(({ connectInspector }) => {
      if (token !== generation || opened.closed) return;
      notify({ phase: 'waiting' });
      bridge = connectInspector({
        source: opened,
        listen: receive => host.listen(receive),
        post: (message, origin) => { if (!opened.closed) opened.postMessage(message, origin); },
        navigate: url => { opened.location.href = url; },
      }, latest.identity, latest.frame, failed, () => notify({ phase: 'connected' }));
    }).catch(cause => { if (token === generation) failed(cause); });
  }
  return {
    open(selection: InspectorSelection) {
      if (state.status === 'done') return;
      latest = selection; checkClosed(); dispatch({ type: 'OPEN' });
    },
    update(selection: InspectorSelection) {
      if (state.status === 'done') return;
      latest = selection; checkClosed(); bridge?.update(selection.frame, selection.identity);
    },
    dispose() { dispatch({ type: 'DISPOSE' }); },
  };
}
