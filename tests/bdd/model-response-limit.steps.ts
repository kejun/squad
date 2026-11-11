import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { createTeamConfig } from '../../team.config.js';
import { validateConfig, type TeamConfig } from '../../src/types.js';
import { ResponseLimitFixture, assertNoProviderBodyArtifacts, privateBodyMarker, type ResponseTransfer } from '../model-response-limit-fixture.js';
import type { SpecWorld } from './steps.js';
const fixtures = new WeakMap<SpecWorld, ResponseLimitFixture>();
const active = (world: SpecWorld) => { const fixture = fixtures.get(world); assert(fixture); return fixture; };
After(async function (this: SpecWorld) { const f = fixtures.get(this); if (f) await f.closeWithEvidence(); fixtures.delete(this); });
Given('模型成功响应以{string}返回且实际正文恰好在配置字节上限内', async function (this: SpecWorld, transfer: ResponseTransfer) {
  fixtures.set(this, await new ResponseLimitFixture('owner', transfer).start());
});
Given('{string}模型成功响应以{string}超过配置的实际字节上限', async function (this: SpecWorld, role: string, transfer: ResponseTransfer) {
  fixtures.set(this, await new ResponseLimitFixture(role === '检查' ? 'check' : 'owner', transfer, true).start());
});
When('通过真实模型传输执行这次工作', async function (this: SpecWorld) { await active(this).run(); });
Then('应完整接受中文结果且只请求一次模型', function (this: SpecWorld) {
  const f = active(this); assert.equal(f.requests.length, 1); assert.equal(f.body.length, f.limit);
  assert.equal(f.h.view().phase, 'checking'); assert.equal(f.h.context().candidate?.text, '完整中文结果：字节边界安全。');
});
Then('应取消超大响应并记录明确且脱敏的字节超限原因', async function (this: SpecWorld) {
  const f = active(this); await f.waitClosed();
  assert.match(f.h.context().reason, /MODEL_RESPONSE_TOO_LARGE/);
  assert.match(f.h.context().reason, /1024/);
  if (f.transfer !== '压缩长度很小但解压超限') assert(f.evidence.sentBytes < f.body.length, 'must cancel before consuming the complete oversized response');
  assert(!JSON.stringify(f.store.read(f.h.room)).includes(privateBodyMarker));
});
Then('不得发布部分正文或按原容量重试且请求应能结算', async function (this: SpecWorld) {
  const f = active(this); await f.run();
  assert.equal(f.requests.length, 1); assert.equal(f.h.context().usage.retries, 0);
  assert.equal(f.h.context().publishedDelivery, undefined); assertNoProviderBodyArtifacts(f);
  assert.equal(f.h.view().phase, f.kind === 'check' ? 'ended' : 'waitingHuman');
  assert.equal(f.h.context().outcome, f.kind === 'check' ? 'partial' : null);
  assert.equal(f.h.context().intents.filter(work => work.status === 'inflight').length, 0);
  assert.equal(f.h.engine.pending(f.h.room, f.h.task).length, 0);
});
Given('模型成功响应正在读取但尚未完整返回', async function (this: SpecWorld) {
  fixtures.set(this, await new ResponseLimitFixture('owner', '暂停', false, 400).start());
});
When('读取期间发生{string}', async function (this: SpecWorld, interruption: string) {
  const f = active(this); f.label = interruption;
  const running = f.run();
  await f.started;
  if (interruption === '用户停止') { await f.stop(); await f.run(); }
  await running;
});
Then('应终止响应读取且不发布部分正文或重试该响应', async function (this: SpecWorld) {
  const f = active(this); await f.waitClosed(); await f.run();
  assert.equal(f.requests.length, 1); assert.equal(f.h.context().candidate, null);
  assert.equal(f.h.context().usage.retries, 0); assert.equal(f.h.context().publishedDelivery, undefined);
  assertNoProviderBodyArtifacts(f);
  assert(f.h.context().stopped || /deadline exceeded/.test(f.h.context().reason), 'deadline must remain distinct from malformed JSON');
});
const configs = new WeakMap<SpecWorld, TeamConfig>();
Given('默认模型和检查模型分别配置了成功响应字节上限', function (this: SpecWorld) {
  const config = createTeamConfig({ MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'controlled', MODEL_NO_AUTH: 'true',
    MODEL_MAX_RESPONSE_BYTES: '8192', CHECK_MODEL_MAX_RESPONSE_BYTES: '4096', A_MODEL_NAME: 'controlled-a' });
  configs.set(this, config);
});
When('解析模型环境配置并校验响应资源边界', function (this: SpecWorld) {
  const config = configs.get(this); assert(config); validateConfig(config);
});
Then('检查应使用自己的上限且其他角色继承默认上限', function (this: SpecWorld) {
  const config = configs.get(this); assert(config);
  assert.equal(config.models!.services.primary!.maxResponseBytes, 8192);
  assert.equal(config.models!.services.check!.maxResponseBytes, 4096);
  assert.equal(config.models!.services.A!.maxResponseBytes, 8192);
});
Then('零值负数小数与非有限上限都应明确拒绝', function (this: SpecWorld) {
  const config = configs.get(this); assert(config);
  for (const value of [0, -1, 0.5, NaN, Infinity]) {
    const invalid = structuredClone(config); invalid.models!.services.primary!.maxResponseBytes = value;
    assert.throws(() => validateConfig(invalid), /response byte limit/);
  }
});
