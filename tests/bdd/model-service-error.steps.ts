import { After, Before, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { ModelServiceErrorCase } from '../model-service-error-case.js';
import { ModelServiceErrorBrowserCase } from '../model-service-error-browser-case.mjs';

const cases = new WeakMap<SpecWorld, ModelServiceErrorCase>();
const timeout = { timeout: 20_000 };
Before(function (this: SpecWorld, { pickle }) {
  const id = pickle.tags.find(t => /^@BT_Y(?:168|169|170|172)$/.test(t.name))?.name.slice(1);
  if (id) cases.set(this, new ModelServiceErrorCase(id));
});
After(timeout, async function (this: SpecWorld) { await cases.get(this)?.close(); });
Given('模型服务为当前工作返回HTTP{string}错误', timeout, async function (this: SpecWorld, status: string) { await cases.get(this)!.given(Number(status)); });
Given('一个分片因模型HTTP400失败而等待用户处理', timeout, async function (this: SpecWorld) { await cases.get(this)!.given(400); });
Given('模型服务HTTP403错误正在等待用户处理', timeout, async function (this: SpecWorld) { await cases.get(this)!.given(403); });
Given('模型HTTP429属于可重试网络错误', timeout, async function (this: SpecWorld) { await cases.get(this)!.given(429); });
When('系统接收该模型失败响应', timeout, async function (this: SpecWorld) { await cases.get(this)!.receive(); });
When('用户明确跳过该模型错误', timeout, async function (this: SpecWorld) { await cases.get(this)!.decide('skip'); });
When('用户明确停止该错误任务', timeout, async function (this: SpecWorld) { await cases.get(this)!.decide('stop'); });
When('系统接收这个瞬态失败', timeout, async function (this: SpecWorld) { await cases.get(this)!.receive(); });
Then('应保存对应错误消息和仅允许跳过或停止的处理请求', function (this: SpecWorld) { cases.get(this)!.verifyError(); });
Then('刷新恢复不得自动重试或代替用户选择', function (this: SpecWorld) { cases.get(this)!.verifyRestore(); });
Then('只应跳过原分片且保留其他分片结果并继续剩余工作', function (this: SpecWorld) { cases.get(this)!.verifySkip(); });
Then('整个任务应停止并保留已有成果且不重发错误请求', function (this: SpecWorld) { cases.get(this)!.verifyStop(); });
Then('不应冒充模型配置错误且仍可按原预算重试', function (this: SpecWorld) { cases.get(this)!.verifyTransient(); });

const browsers = new WeakMap<SpecWorld, ModelServiceErrorBrowserCase>();
After(timeout, async function (this: SpecWorld, { result }) {
  const fixture = browsers.get(this);
  if (result?.status !== 'PASSED') fixture?.markFailed(result?.message);
  await fixture?.close();
});
Given('真实网页的模型请求被HTTP{string}拒绝', { timeout: 30_000 }, async function (this: SpecWorld, status: string) {
  const fixture = new ModelServiceErrorBrowserCase(); browsers.set(this, fixture); await fixture.open(Number(status));
});
When('网页收到该错误并且用户选择{string}', timeout, async function (this: SpecWorld, choice: string) { await browsers.get(this)!.act(choice); });
Then('应显示相应错误信息且无需文本回复或续窗', timeout, async function (this: SpecWorld) { await browsers.get(this)!.verify(); });
Then('应提交该明确决定并保留已有成果', timeout, async function (this: SpecWorld) { await browsers.get(this)!.verify(); });
