import { createInspector } from '@squad/inspector-transport';
import { initialTransition, transition, type EventFrom } from 'xstate';
import { inspectorMachine, inspectorOrigin, inspectorUrl, type InspectorFrame } from '../../src/inspector.machine.js';
import { restoreTask } from '../../src/task.machine.js';
import { executionLifecycle, isTerminalExecutionState } from '../../src/task/execution.machine.js';
import { taskLifecycle } from '../../src/task/lifecycle.js';

export interface InspectorMessage { data: unknown; source: unknown; origin: string }
export interface InspectorPort {
  readonly source: unknown;
  listen: (receive: (message: InspectorMessage) => void) => () => void;
  post: (message: unknown, origin: string) => void;
  navigate: (url: string) => void;
}

interface InspectorActor {
  sessionId: string;
  logic: { config: object };
  _parent?: InspectorActor;
  getSnapshot(): never;
  send(): never;
}
let nextSessionId = 0;
function metadataActor(config: object, parent?: InspectorActor): InspectorActor {
  const unsupported = (): never => { throw new Error('Inspector metadata has no running actor'); };
  // The SDK reads only the ID, legacy graph and parent when we supply snapshots explicitly.
  return { sessionId: `squad-inspector:${++nextSessionId}`, logic: { config },
    ...(parent ? { _parent: parent } : {}), getSnapshot: unsupported, send: unsupported };
}

/** The SDK's default iframe adapter gates its target on load and can lose an earlier handshake. */
export function connectInspector(port: InspectorPort, identity: string, initial: InspectorFrame, onError: (cause: unknown) => void, onConnect?: () => void) {
  let [observer] = initialTransition(inspectorMachine, initial);
  let delivered = 0;
  let closed = false;
  let metadata = metadataActor(taskLifecycle);
  let currentIdentity = identity;
  const childMetadata = new Map<string, InspectorActor>();
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
        ref = metadataActor(executionLifecycle, metadata);
        childMetadata.set(id, ref);
      }
      const childSnapshot = {
        status: isTerminalExecutionState(state.value) ? 'done' as const : state.status,
        value: state.value, context: state.context,
      };
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
          metadata = metadataActor(taskLifecycle);
          currentIdentity = identity; childMetadata.clear(); registeredChildren.clear();
        }
        dispatch({ type: changed ? 'SELECT' : 'UPDATE', frame });
      } catch (cause) { onError(cause); }
    },
    stop,
  };
}
