import { Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { SpecWorld } from './steps.js';
import type { ToolExperience } from '../../src/task/tool-experience.js';
import { currentActionableExperience, firstRoundToolExperience, historicalToolExperience } from '../tool-experience-acceptance.js';

interface ExperienceRun { fresh?: boolean; boundary?: string; values?: ToolExperience[] }
const runs = new WeakMap<SpecWorld, ExperienceRun>();
const run = (world: SpecWorld) => { let value = runs.get(world); if (!value) { value = {}; runs.set(world, value); } return value; };
Given('同任务已有宿主验证的资料读取经验', function (this: SpecWorld) { run(this).boundary = '成功'; });
Given('一个尚未进行工具试错的新任务', function (this: SpecWorld) { run(this).fresh = true; });
Given('历史能力回执受到{string}约束', function (this: SpecWorld, boundary: string) { run(this).boundary = boundary; });
Given('待共享读取经验受到{string}约束', function (this: SpecWorld, boundary: string) { run(this).boundary = boundary; });
When('为后续成员构建可行动的共享经验', async function (this: SpecWorld) {
  const value = run(this);
  value.values = value.fresh ? await firstRoundToolExperience() : currentActionableExperience(value.boundary);
});
When('服务重新打开并构建首轮模型请求', async function (this: SpecWorld) { run(this).values = await firstRoundToolExperience(); });
When('新任务请求可行动的工具经验', async function (this: SpecWorld) { const value = run(this); value.values = await historicalToolExperience(value.boundary!); });
Then('每条经验应说明适用条件具体行动预期结果和证据级别', function (this: SpecWorld) {
  const values = run(this).values!; assert(values.length >= 3);
  assert(values.every(item => item.condition.description && item.action.description && item.expectedResult.description && item.evidence.verificationLevel));
});
Then('读取经验应保留资源范围并要求独立执行', function (this: SpecWorld) {
  const method = run(this).values!.find(item => item.evidence.kind === 'verified_resource_method')!;
  assert.deepEqual(method.condition.resourceScope, { kind: 'url_origin', origin: 'https://example.com', catalogVersion: 'v1', catalogOperationId: 'catalog' });
  assert.equal(method.requiresIndependentExecution, true); assert.equal(method.expectedResult.provesCurrentResource, false);
});
Then('模型应得到把中间产物保存在工作区的版本化配方', function (this: SpecWorld) {
  const recipe = run(this).values!.find(item => item.id === 'workspace-intermediates:v1')!;
  assert(recipe.action.description.includes('工作区')); assert(recipe.action.steps!.some(step => step.includes('.tmp/')));
  assert.equal(recipe.evidence.version, 'workspace-files:v1');
});
Then('配方不得包含其他任务的正文或凭据', function (this: SpecWorld) {
  const text = JSON.stringify(run(this).values!);
  assert(!text.includes('SECRET_FILE')); assert(!text.includes('host-model-secret')); assert(!text.includes('原始资料正文'));
});
Then('历史能力事实的复用结果应为{string}', function (this: SpecWorld, expected: string) { assert.equal(run(this).values!.length > 0, expected === '可复用'); });
Then('不应提供当前资源已获取的成功经验', function (this: SpecWorld) {
  assert(!run(this).values!.some(item => item.evidence.kind === 'verified_resource_method'));
  assert(run(this).values!.every(item => item.expectedResult.provesCurrentResource === false));
});
Then('OCR配方应要求工具支持标准输入且输入文件位于工作区', function (this: SpecWorld) {
  const recipe = run(this).values!.find(item => item.id === 'ocr-stdin:v1')!;
  assert(recipe.condition.description.includes('明确支持 stdin')); assert(recipe.condition.description.includes('当前工作区'));
});
Then('OCR配方应给出标准输入文件模板并保留独立验证和宿主授权', function (this: SpecWorld) {
  const recipe = run(this).values!.find(item => item.id === 'ocr-stdin:v1')!;
  assert.deepEqual(recipe.action.template!.stdin, { path: '<workspace-relative-input>' });
  assert(recipe.action.steps!.some(step => step.includes('正常宿主授权')));
  assert.equal(recipe.requiresIndependentExecution, true); assert.equal(recipe.executionAuthority, false);
});
