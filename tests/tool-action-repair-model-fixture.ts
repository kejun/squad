import assert from 'node:assert/strict';
import { claimHandoff, reportHandoff, submitHandoff } from './downstream-handoff-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';

const setup = (checks: number) => {
  const model = new LocalModel(input => { input.config.limits.checks = checks; });
  submitHandoff(model);
  const work = claimHandoff(model, 'check');
  const repair = (issue = 'invalid_tool_request') => model.send({
    type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, fence: work, issue,
  });
  return { model, work, repair };
};

const allowed = setup(3);
assert.equal(allowed.repair('invalid_json').code, 'OUTPUT_REPAIR_NOT_ALLOWED');
assert(allowed.repair().ok);
assert(allowed.model.send({ type: 'CONSUME', intentId: allowed.work.id, fence: allowed.work }).ok);
assert.equal(allowed.repair().code, 'OUTPUT_REPAIR_EXHAUSTED');
assert(reportHandoff(allowed.model, allowed.work).ok);
assert.equal(allowed.model.c.outcome, 'complete');
assert.equal(allowed.model.c.usage.checks, 2);
assert.equal(allowed.model.c.usage.retries, 1);
assert.equal(allowed.model.c.deliveryCycle?.retry, undefined);

const exhausted = setup(1);
assert.equal(exhausted.repair().code, 'CHECK_BUDGET_EXHAUSTED');
assert.equal(exhausted.model.c.usage.retries, 0);

const stopped = setup(3);
assert(stopped.model.send({ type: 'STOP' }).ok);
assert(!stopped.repair().ok);
assert.equal(stopped.model.c.usage.checks, 1);
assert.equal(stopped.model.c.usage.retries, 0);

console.log('Tool repair: same check, one repair per work, two charged requests, exhaustion and stop guarded.');
