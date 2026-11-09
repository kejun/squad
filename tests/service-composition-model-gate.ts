import assert from 'node:assert/strict';
import { initialTask, stepTask } from '../src/task.machine.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';
import { verifyWebCompositionModels } from './web-composition-model-gate.js';

export function verifyServiceCompositionModel() {
  verifyWebCompositionModels();
  const local = new LocalModel();
  assert(local.request().ok); assert(local.claim().ok); assert(local.started().ok);
  assert(local.send({ type: 'RECOVER', config: local.c.config }).ok);
  assert.equal(local.op?.status, 'uncertain');
  const initial = initialTask(localModelInput());
  const owner = initial.context.intents[0]!;
  const stopped = stepTask(initial, { type: 'STOP', id: 'close-stop', at: 1 });
  const denied = stepTask(stopped, { type: 'CLAIM', id: 'late-owner-claim', at: 2, intentId: owner.id });
  assert(!denied.context.reply.ok); assert.equal(denied.context.usage.ordinary, 0);
  return { recovery: 'running local operation remains uncertain', stopped: 'old owner cannot claim or consume budget' };
}
