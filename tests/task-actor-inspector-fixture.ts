import assert from 'node:assert/strict';
import { concurrentActors } from './task-actor-model-fixture.js';
import { persistTask } from '../src/task.machine.js';
import { InspectorFixture } from './inspector-fixture.js';

export class ActorInspector {
  readonly model = concurrentActors();
  readonly frame = { snapshot: persistTask(this.model.snapshot), event: undefined };
  readonly before = JSON.stringify(this.frame.snapshot);
  readonly fixture = new InspectorFixture();
  verify() {
    const { frame, fixture, before } = this;
    const bridge = fixture.open(false, 'actor-observer', frame);
    try {
      fixture.handshake();
      const messages = fixture.messages as unknown as { type: string; sessionId: string; parentId?: string; definition?: string; snapshot?: { value: string } }[];
      const registrations = messages.filter(message => message.type === '@xstate.actor');
      const root = registrations.find(message => JSON.parse(message.definition!).id === 'botTeamTask')!; assert(root);
      const children = registrations.filter(message => JSON.parse(message.definition!).id === 'taskExecution');
      assert(children.length >= 4); for (const child of children) assert.equal(child.parentId, root.sessionId);
      assert(children.some(child => child.snapshot?.value === 'settled'));
      bridge.update(frame); fixture.handshake();
      assert.equal(fixture.errors.length, 0); assert.equal(JSON.stringify(frame.snapshot), before);
      return { registrations: structuredClone(registrations), before, after: JSON.stringify(frame.snapshot), errors: structuredClone(fixture.errors) };
    } finally { bridge.stop(); }
  }
}
