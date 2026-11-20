import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { claimHandoff, submitHandoff } from './downstream-handoff-model-fixture.js';

const model = new LocalModel(input => {
  input.config.deliveryReport = 'summary';
  input.config.limits.checks = 0;
});
const owner = model.work;
submitHandoff(model, owner);
assert.equal(model.snapshot.value, 'ended');
assert.equal(model.c.outcome, 'complete');
assert.equal(model.c.usage.checks, 0);
assert(!model.c.intents.some(work => work.kind === 'check'));
assert.deepEqual(model.c.publishedDelivery?.artifactIds, model.c.candidate?.artifactIds);
assert.deepEqual(model.c.messages.slice(-2).map(message => message.kind), ['final', 'notice']);
assert.match(model.c.messages.at(-1)!.text, /执行摘要.*result\.md/s);
assert.equal(model.send({ type: 'CONTINUE', retryCheck: true }).code, 'CHECK_RETRY_NOT_AVAILABLE');
assert.equal(model.c.outcome, 'complete');

const legacy = new LocalModel();
submitHandoff(legacy);
assert.equal(legacy.snapshot.value, 'checking');
assert(claimHandoff(legacy, 'check'));

const missing = new LocalModel(input => {
  input.config.deliveryReport = 'summary';
  input.goal.resourceRequirements = [{ resource: { kind: 'url', url: 'https://example.invalid/required' }, freshness: 'current' }];
});
submitHandoff(missing);
assert.equal(missing.snapshot.value, 'ended');
assert.equal(missing.c.candidate?.deliveryIssue?.code, 'RESOURCE_ACQUISITION_UNVERIFIED');
assert.match(missing.c.messages.at(-1)!.text, /缺少必需资源的获取凭证/);
assert(!missing.c.intents.some(work => work.kind === 'check'));
