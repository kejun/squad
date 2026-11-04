import assert from 'node:assert/strict';
import { connectInspector, type InspectorMessage, type InspectorPort } from '../web/src/inspector-bridge.js';
import { debugInput } from '../src/task-debug.js';
import { inspectorOrigin, type InspectorFrame } from '../src/inspector.machine.js';
import { initialTask, persistTask, stepTask, taskMachine } from '../src/task.machine.js';

interface Message {
  type: string; sessionId?: string; definition?: string;
  snapshot?: { value: string; status: string; context: unknown };
}
export class InspectorFixture {
  readonly task = initialTask(debugInput());
  readonly before = structuredClone(persistTask(this.task));
  readonly event = { type: 'STOP' as const, id: 'inspect-stop', at: 1 };
  readonly next = stepTask(this.task, this.event);
  readonly messages: Message[] = [];
  readonly source = {};
  readonly errors: unknown[] = [];
  listener: ((message: InspectorMessage) => void) | undefined;
  staleListener?: (message: InspectorMessage) => void;
  observer?: ReturnType<typeof connectInspector>;
  closedCount = 0;
  initial(): InspectorFrame { return { snapshot: this.before, event: undefined }; }
  latest(): InspectorFrame { return { snapshot: persistTask(this.next), event: this.event }; }
  handshake(origin = inspectorOrigin, source: unknown = this.source) {
    this.listener?.({ data: { type: '@statelyai.connected' }, origin, source });
  }
  open(beforeLoad = true, identity = 'fixture', initial = this.initial()) {
    const port: InspectorPort = {
      source: this.source,
      listen: receive => {
        this.listener = receive; this.staleListener = receive;
        return () => { this.listener = undefined; this.closedCount++; };
      },
      post: (message, origin) => { assert.equal(origin, inspectorOrigin); this.messages.push(structuredClone(message) as Message); },
      navigate: url => {
        assert.equal(url, inspectorOrigin + '/inspect');
        assert(this.listener, 'Listener must exist before target navigation');
        if (beforeLoad) this.handshake();
      },
    };
    this.observer = connectInspector(port, identity, initial, cause => this.errors.push(cause));
    return this.observer;
  }
  assertRegistration(message = this.messages[0]!, latest = true) {
    assert.equal(message.type, '@xstate.actor');
    const definition = JSON.parse(message.definition!);
    assert.equal(definition.id, taskMachine.id);
    assert.deepEqual(Object.keys(definition.states).sort(), Object.keys(taskMachine.config.states!).sort());
    assert.deepEqual(message.snapshot, {
      status: latest ? this.next.status : this.task.status,
      value: latest ? this.next.value : this.task.value,
      context: latest ? this.next.context : this.task.context,
    });
  }
  assertOrdered() {
    const registered = new Set<string>();
    for (const message of this.messages) {
      if (message.type === '@xstate.actor') registered.add(message.sessionId!);
      if (message.type === '@xstate.event' || message.type === '@xstate.snapshot') assert(registered.has(message.sessionId!), 'Snapshot must follow registration');
    }
    assert.equal(registered.size, 1);
    assert.deepEqual(persistTask(this.task), this.before);
    assert.deepEqual(this.task.context.usage, this.next.context.usage);
    assert.deepEqual(this.errors, []);
  }
}
