import assert from 'node:assert/strict';
import { claimHandoff, reportHandoff, submitHandoff } from './downstream-handoff-model-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { CapacityModel } from './map-capacity-model-fixture.js';

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

const map = new CapacityModel(input => { input.config.limits.retries = 1; });
map.claim(); map.consume(); assert(map.interpret().ok);
const partition = map.pending('assistance')[0]!;
assert(map.send({ type: 'CLAIM', intentId: partition.id }).ok);
const claimed = map.context.intents.find(work => work.id === partition.id)!;
const consume = () => map.send({ type: 'CONSUME', intentId: claimed.id, fence: claimed, attempt: claimed.attempt });
assert(consume().ok);
assert(map.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: claimed.id, fence: claimed, issue: 'invalid_tool_request' }).ok);
assert(consume().ok);
assert(consume().ok);
assert.equal(map.context.usage.retries, 1);
const partial = { type: 'DISCUSSION_RESULT', discussionId: claimed.discussionId!, workId: claimed.id, fence: claimed,
  text: '保留已取得的一条证据，补充资料待确认', status: 'partial', artifacts: [{ name: '已获取.md', content: '已获取证据' }] } as const;
assert(map.send({ ...partial, artifacts: [...partial.artifacts] }).ok);
const result = map.context.discussion!.results.find(item => item.target === claimed.target)!;
assert.equal(result.status, 'partial');
assert.equal(result.answer, partial.text);
assert.equal(result.artifactIds.length, 1);
assert.equal(map.context.artifacts.find(item => item.id === result.artifactIds[0])?.content, '已获取证据');
assert(!map.send({ ...partial, artifacts: [...partial.artifacts] }).ok);
