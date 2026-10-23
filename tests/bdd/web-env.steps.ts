import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { runWebEnvScenario, oldWebEnv, newWebEnv, explicitWebEnv, type EnvProbe } from '../web-env-fixture.js';
import type { SpecWorld } from './steps.js';

const states = new WeakMap<SpecWorld, { mode: string; result?: EnvProbe }>();
function state(world: SpecWorld) { const value = states.get(world); assert(value); return value; }
function result(world: SpecWorld) { const value = state(world).result; assert(value); return value; }
function credentials(call: EnvProbe['calls'][number], expected: typeof oldWebEnv) {
  assert(call.url.includes(`/accounts/${expected.CLOUDFLARE_ACCOUNT_ID}/`));
  assert.equal(call.headers.authorization, `Bearer ${expected.CLOUDFLARE_API_TOKEN}`);
}

Given('同一个网页工具实例已使用环境文件完成{string}', function (this: SpecWorld, mode: string) { states.set(this, { mode }); });
When('更新文件中的账号、令牌和搜索选项后再次请求', function (this: SpecWorld) { state(this).result = runWebEnvScenario('rotation', state(this).mode); });
Then('新请求应采用更新后的文件配置且无需重启', function (this: SpecWorld) {
  const calls = result(this).calls; assert.equal(calls.length, 2);
  credentials(calls[0]!, oldWebEnv); credentials(calls[1]!, newWebEnv);
  if (state(this).mode === 'web_search') {
    assert.equal(calls[1]!.body.provider, newWebEnv.CLOUDFLARE_WEB_SEARCH_PROVIDER);
    assert.deepEqual(calls[1]!.body.options, { gateway: { id: newWebEnv.CLOUDFLARE_AI_GATEWAY_ID } });
    assert.equal(calls[1]!.body.byokAlias, newWebEnv.CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS);
  } else assert(calls[1]!.url.endsWith('/ai/tomarkdown'));
});
Given('网页凭据来自{string}且文件中存在同名配置', function (this: SpecWorld, mode: string) { states.set(this, { mode }); });
When('修改环境文件并再次搜索', function (this: SpecWorld) { state(this).result = runWebEnvScenario('priority', state(this).mode); });
Then('请求应继续使用显式配置', function (this: SpecWorld) {
  const calls = result(this).calls; assert.equal(calls.length, 2);
  for (const call of calls) credentials(call, explicitWebEnv);
});
Given('网页搜索已使用文件中的令牌成功执行', function (this: SpecWorld) { states.set(this, { mode: '' }); });
When('环境文件发生{string}后再次搜索', function (this: SpecWorld, mode: string) { state(this).mode = mode; state(this).result = runWebEnvScenario('revocation', mode); });
Then('应明确报错且不发送新的 Cloudflare 请求', function (this: SpecWorld) {
  const value = result(this); assert.equal(value.callsAfterFailure, 1);
  const code = state(this).mode === '读取失败' ? 'WEB_TOOLS_ENV_UNAVAILABLE' : 'WEB_TOOLS_NOT_CONFIGURED';
  assert(value.error.includes(code), value.error);
  assert(!value.error.includes(oldWebEnv.CLOUDFLARE_API_TOKEN));
});
Then('修复文件后同一个实例应能继续搜索', function (this: SpecWorld) {
  const calls = result(this).calls; assert.equal(calls.length, 2); credentials(calls[1]!, newWebEnv);
});
Given('文档抓取正在等待网页响应', function (this: SpecWorld) { states.set(this, { mode: '' }); });
When('环境文件被更新且另一次搜索已读取新配置', function (this: SpecWorld) { state(this).result = runWebEnvScenario('inflight'); });
Then('原抓取的 Markdown 转换仍应使用原账号和令牌', function (this: SpecWorld) {
  const calls = result(this).calls; assert.equal(calls.length, 3);
  credentials(calls[0]!, newWebEnv); assert(calls[0]!.url.endsWith('/ai/websearch/'));
  credentials(calls[1]!, oldWebEnv); assert(calls[1]!.url.endsWith('/ai/tomarkdown'));
});
Then('下一次抓取应使用新账号和令牌', function (this: SpecWorld) { credentials(result(this).calls[2]!, newWebEnv); });
