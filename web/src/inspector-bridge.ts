import { createInspector } from '@statelyai/inspect';
import { createActor, initialTransition, transition, type EventFrom, type ActorRefFrom } from 'xstate';
import { inspectorMachine, inspectorOrigin, inspectorUrl, type InspectorFrame } from '../../src/inspector.machine.js';
import { restoreTask, taskMachine } from '../../src/task.machine.js';
import { executionMachine } from '../../src/task/execution.machine.js';
import { debugInput } from '../../src/task-debug.js';

export interface InspectorMessage { data: unknown; source: unknown; origin: string }
export interface InspectorPort {
  readonly source: unknown;
  listen: (receive: (message: InspectorMessage) => void) => () => void;
  post: (message: unknown, origin: string) => void;
  navigate: (url: string) => void;
}

/** The SDK's default iframe adapter gates its target on load and can lose an earlier handshake. */
export function connectInspector(port: InspectorPort, identity: string, initial: InspectorFrame, onError: (cause: unknown) => void, onConnect?: () => void) {
  let [observer] = initialTransition(inspectorMachine, initial);
  let delivered = 0;
  let closed = false;
  // Definition metadata only: never start this task actor or send it business events.
  let metadata = createActor(taskMachine, { id: identity, snapshot: initial.snapshot as never, input: debugInput() });
  let currentIdentity = identity;
  const childMetadata = new Map<string, ActorRefFrom<typeof executionMachine>>();
  const registeredChildren = new Set<string>();
  const inspector = createInspector({ send: message => port.post(message, inspectorOrigin) }, { autoStart: false });

  function dispatch(event: EventFrom<typeof inspectorMachine>) {
    [observer] = transition(inspectorMachine, observer, event);
    const delivery = observer.context.delivery;
    if (!delivery || delivery.sequence === delivered) return;
    delivered = delivery.sequence;
    if (delivery.kind === 'disconnect') {
      port.post({ type: '@statelyai.disconnected' }, inspectorOrigin);
      return;
    }
    const next = restoreTask(structuredClone(delivery.frame.snapshot));
    const snapshot = { status: next.status, value: next.value, context: next.context };
    // Every connection starts with the real definition, before any events or snapshots.
    if (delivery.kind === 'register') { inspector.actor(metadata, snapshot); registeredChildren.clear(); }
    const trigger = delivery.frame.event;
    if (trigger) inspector.event(metadata, trigger);
    inspector.snapshot(metadata, snapshot, trigger ? { event: trigger } : undefined);
    for (const [id, child] of Object.entries(next.children)) {
      if (!child) continue;
      const state = child.getSnapshot();
      let ref = childMetadata.get(id);
      if (!ref) {
        ref = createActor(executionMachine, { id, parent: metadata, input: state.context,
          snapshot: executionMachine.getPersistedSnapshot(state) });
        childMetadata.set(id, ref);
      }
      const childSnapshot = { status: state.status, value: state.value, context: state.context };
      if (!registeredChildren.has(id)) { inspector.actor(ref, childSnapshot); registeredChildren.add(id); }
      inspector.snapshot(ref, childSnapshot);
    }
  }

  const unlisten = port.listen(message => {
    if (closed || !message.data || typeof message.data !== 'object' || !('type' in message.data)
      || message.data.type !== '@statelyai.connected') return;
    try {
      const fromTarget = port.source != null && message.source === port.source;
      dispatch({ type: 'CONNECT', origin: message.origin, fromTarget });
      if (fromTarget && message.origin === inspectorOrigin) onConnect?.();
    } catch (cause) { onError(cause); }
  });
  function stop() {
    if (closed) return;
    closed = true;
    unlisten();
    try { dispatch({ type: 'CLOSE' }); } finally { inspector.stop(); }
  }
  try { port.navigate(inspectorUrl); } catch (cause) { stop(); throw cause; }
  return {
    update(frame: InspectorFrame, identity = currentIdentity) {
      if (closed) return;
      try {
        const changed = identity !== currentIdentity;
        if (changed) {
          metadata = createActor(taskMachine, { id: identity, snapshot: frame.snapshot as never, input: debugInput() });
          currentIdentity = identity; childMetadata.clear(); registeredChildren.clear();
        }
        dispatch({ type: changed ? 'SELECT' : 'UPDATE', frame });
      } catch (cause) { onError(cause); }
    },
    stop,
  };
}
