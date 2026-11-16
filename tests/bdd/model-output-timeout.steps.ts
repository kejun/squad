import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { modelTransportTimeouts } from '../../src/model-adapter.js';
import { createTeamConfig } from '../../team.config.js';
import { ModelTimeoutFixture, type ModelTimeoutReport } from '../model-output-timeout-fixture.js';
import type { SpecWorld } from './steps.js';

const slow = { timeout: 20_000 };
const reports = new WeakMap<SpecWorld, ModelTimeoutReport>();
const fixtures = new WeakMap<SpecWorld, ModelTimeoutFixture>();
const base = { MODEL_BASE_URL: 'https://provider.example/v1', MODEL_NAME: 'qwen4-max-preview', MODEL_NO_AUTH: 'true' };

After(async function (this: SpecWorld) {
  const fixture = fixtures.get(this);
  if (fixture) await fixture.close();
  fixtures.delete(this);
});

async function waitUntilClosed(fixture: ModelTimeoutFixture) {
  const until = Date.now() + 1_000;
  while (!fixture.report().closedBeforeResponse && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
}

Given('环境没有设置输出额度且成员可以使用不同模型', function () { /* 配置在下一步从显式环境生成。 */ });
When('从环境生成模型配置并解析传输时限', function (this: SpecWorld) {
  const config = createTeamConfig({ ...base, BUILDER_2_MODEL_NAME: 'other-model' });
  const role = createTeamConfig({ ...base, A_MODEL_NAME: 'planner', A_MODEL_MAX_TOKENS: '1024' });
  const explicit = createTeamConfig({ ...base, MODEL_MAX_TOKENS: '8192' });
  const completion = createTeamConfig({ ...base, MODEL_EXTRA_BODY: '{"max_completion_tokens":8192}' });
  reports.set(this, {
    requests: [], phase: '', retries: 0, candidate: null, reason: '', stopped: false, closedBeforeResponse: false, pendingOwner: false,
    ...{
      primary: config.models!.services.primary!.maxTokens,
      other: config.models!.services['builder-2']!.maxTokens,
      planner: role.models!.services.A!.maxTokens,
      explicit: explicit.models!.services.primary!.maxTokens,
      completion: completion.models!.services.primary!.maxTokens,
      completionBody: completion.models!.services.primary!.extraBody!.max_completion_tokens,
      timeouts: modelTransportTimeouts({}),
      headersOverride: modelTransportTimeouts({ MODEL_HEADERS_TIMEOUT_MS: '5000' }),
      bodyOverride: modelTransportTimeouts({ MODEL_BODY_TIMEOUT_MS: '8000' }),
    },
  } as ModelTimeoutReport);
});
Then('未指定的模型输出额度应为384000且传输时限应为2147483647毫秒', function (this: SpecWorld) {
  const report = reports.get(this) as ModelTimeoutReport & {
    primary: number; other: number; timeouts: { headersTimeout: number; bodyTimeout: number };
    headersOverride: { headersTimeout: number; bodyTimeout: number }; bodyOverride: { headersTimeout: number; bodyTimeout: number };
  };
  assert.equal(report.primary, 384_000);
  assert.equal(report.other, 384_000);
  assert.deepEqual(report.timeouts, { headersTimeout: 2_147_483_647, bodyTimeout: 2_147_483_647 });
  assert.ok(report.timeouts.headersTimeout > 300_000);
  assert.ok(report.timeouts.headersTimeout >= 384_000_000);
  assert.deepEqual(report.headersOverride, { headersTimeout: 5000, bodyTimeout: 2_147_483_647 });
  assert.deepEqual(report.bodyOverride, { headersTimeout: 2_147_483_647, bodyTimeout: 8000 });
});
Then('显式输出额度和附加完成额度仍优先', function (this: SpecWorld) {
  const report = reports.get(this) as ModelTimeoutReport & { planner: number; explicit: number; completion: number | undefined; completionBody: number };
  assert.equal(report.planner, 1024);
  assert.equal(report.explicit, 8192);
  assert.equal(report.completion, undefined);
  assert.equal(report.completionBody, 8192);
});

function waitOf(label: string): { headerDelayMs: number; bodyDelayMs: number } {
  if (label === '响应头延迟四百毫秒') return { headerDelayMs: 400, bodyDelayMs: 0 };
  if (label === '响应头延迟三秒') return { headerDelayMs: 3_000, bodyDelayMs: 0 };
  if (label === '正文延迟三秒') return { headerDelayMs: 0, bodyDelayMs: 3_000 };
  throw new Error(`未知等待：${label}`);
}
function timeoutOf(label: string): { headersTimeout?: string; bodyTimeout?: string } {
  if (label === '未设置') return {};
  if (label === '响应头1毫秒') return { headersTimeout: '1' };
  if (label === '响应体1毫秒') return { bodyTimeout: '1' };
  throw new Error(`未知时限：${label}`);
}

Given('模型{string}且客户端时限为{string}', slow, async function (this: SpecWorld, wait: string, limit: string) {
  fixtures.set(this, await new ModelTimeoutFixture({ ...waitOf(wait), ...timeoutOf(limit) }).start());
});
When('成员通过真实传输请求模型', slow, async function (this: SpecWorld) {
  const fixture = fixtures.get(this);
  assert(fixture);
  await fixture.run();
  reports.set(this, fixture.report());
});
Then('传输结果应为{string}', async function (this: SpecWorld, expected: string) {
  if (expected === '接受完整协议结果且请求包含384000输出额度') return acceptComplete(this);
  if (expected === '可重试网络失败且不发布部分结果') {
    const fixture = fixtures.get(this);
    assert(fixture);
    await waitUntilClosed(fixture);
    reports.set(this, fixture.report());
    return rejectPartial(this);
  }
  throw new Error(`未知传输结果：${expected}`);
});
function acceptComplete(world: SpecWorld): void {
  const report = reports.get(world);
  assert(report);
  assert.equal(report.requests.length, 1);
  assert.equal(report.requests[0]?.model, 'qwen4-max-preview');
  assert.equal(report.requests[0]?.stream, false);
  assert.equal(report.requests[0]?.max_tokens, 384_000);
  assert.equal(report.candidate, '完整方案已给出');
  assert.equal(report.phase, 'checking');
  assert.equal(report.retries, 0);
  assert.equal(report.closedBeforeResponse, false);
}
function rejectPartial(world: SpecWorld): void {
  const report = reports.get(world);
  assert(report);
  assert.equal(report.requests.length, 1);
  assert.equal(report.candidate, null);
  assert.equal(report.retries, 1);
  assert.equal(report.pendingOwner, true);
  assert.equal(report.phase, 'running');
  assert.equal(report.closedBeforeResponse, true);
  assert.equal(report.stopped, false);
}

Given('模型迟迟不发送响应头且客户端时限长于工作期限', slow, async function (this: SpecWorld) {
  fixtures.set(this, await new ModelTimeoutFixture({ headerDelayMs: 8_000 }).start());
});
When('等待响应头期间发生{string}', slow, async function (this: SpecWorld, interruption: string) {
  const fixture = fixtures.get(this);
  assert(fixture);
  if (interruption === '工作期限到达') {
    await fixture.close();
    const replacement = await new ModelTimeoutFixture({ headerDelayMs: 8_000, workTimeoutMs: 800 }).start();
    fixtures.set(this, replacement);
    await replacement.run();
    await waitUntilClosed(replacement);
    reports.set(this, { ...replacement.report(), reason: `${interruption}:${replacement.report().reason}` });
    return;
  }
  const running = fixture.run();
  await fixture.received;
  await fixture.stop();
  await running;
  await waitUntilClosed(fixture);
  reports.set(this, { ...fixture.report(), reason: `${interruption}:${fixture.report().reason}` });
});
Then('请求应中止且不发布部分结果也不按网络错误重试', function (this: SpecWorld) {
  const report = reports.get(this);
  assert(report);
  assert.equal(report.requests.length, 1);
  assert.equal(report.candidate, null);
  assert.equal(report.retries, 0);
  assert.equal(report.closedBeforeResponse, true);
  assert.equal(report.pendingOwner, false);
  if (report.reason.startsWith('工作期限到达:')) assert.match(report.reason, /deadline exceeded/);
  else {
    assert.match(report.reason, /^用户停止:/);
    assert.equal(report.stopped, true);
  }
});

Given('{string}为{string}', slow, async function (this: SpecWorld, key: string, value: string) {
  fixtures.set(this, await new ModelTimeoutFixture({ invalid: { key, value }, headerDelayMs: 5_000 }).start());
});
When('成员请求模型', slow, async function (this: SpecWorld) {
  const fixture = fixtures.get(this);
  assert(fixture);
  await fixture.run();
  reports.set(this, fixture.report());
});
Then('系统应拒绝该配置且不向提供方发出请求', function (this: SpecWorld) {
  const report = reports.get(this);
  assert(report);
  assert.equal(report.requests.length, 0);
  assert.equal(report.candidate, null);
  assert.match(report.reason, /MODEL_(HEADERS|BODY)_TIMEOUT_MS/);
  assert.equal(report.retries, 0);
});
