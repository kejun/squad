import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { claimHandoff, submitHandoff } from './downstream-handoff-model-fixture.js';
import { artifactVerification } from '../src/resource-acquisition.js';

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
assert.equal(missing.c.outcome, 'complete');
assert.deepEqual(missing.c.publishedDelivery?.artifactIds, missing.c.candidate?.artifactIds);
assert.equal(artifactVerification(missing.c, missing.c.artifacts.at(-1)!).status, 'unverified');

const advisory = new LocalModel(input => { input.config.deliveryReport = 'summary'; });
const finding = { kind: 'material_error', reason: '第三季度收入遗漏退款，影响净收入结论' };
const result = { type: 'DELIVER', workId: advisory.work.id, fence: advisory.work, text: '季度分析与原始文件', artifactIds: [],
  artifacts: [{ name: '季度分析.md', content: '本期取得的数据与分析' }], deliveryFindings: [finding] };
assert(advisory.send(result).ok);
assert.equal(advisory.c.outcome, 'complete');
assert.deepEqual(advisory.c.candidate?.deliveryFindings, [finding]);
assert.equal(advisory.c.messages.find(message => message.kind === 'final')?.text, result.text);
assert.match(advisory.c.messages.at(-1)!.text, /严重问题.*影响净收入结论/s);
assert(!advisory.c.messages.some(message => message.text.includes('是否重试')));
assert(!advisory.c.intents.some(work => work.kind === 'check'));

const stopped = new LocalModel(input => { input.config.deliveryReport = 'summary'; });
assert(stopped.send({ type: 'STOP' }).ok);
assert.equal(stopped.send({ ...result, workId: stopped.work.id, fence: stopped.work }).ok, false);
assert.equal(stopped.c.outcome, 'stopped');
assert.equal(stopped.c.publishedDelivery, undefined);

const missingFile = new LocalModel(input => {
  input.config.deliveryReport = 'summary';
  input.goal.requiredArtifacts = 2;
});
assert(missingFile.send({ ...result, workId: missingFile.work.id, fence: missingFile.work }).ok);
assert.equal(missingFile.c.outcome, 'complete');
assert.equal(missingFile.c.messages.find(message => message.kind === 'final')?.text, result.text);
assert.deepEqual(missingFile.c.candidate?.deliveryFindings, [{ kind: 'missing_requirement', reason: '尚未提供要求的全部文件' }, finding]);
assert.match(missingFile.c.messages.at(-1)!.text, /严重问题.*尚未提供要求的全部文件/);
