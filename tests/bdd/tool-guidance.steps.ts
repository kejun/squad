import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { initialGuidanceAcceptance, emptyGuidanceAcceptance, failureGuidanceAcceptance, correctedCliAcceptance, repeatedCliAcceptance, incompleteSkillGuidanceAcceptance } from '../tool-guidance-acceptance.js';
import { repeatedCliModel, modelGuidanceBoundary, modelExcludedResult } from '../tool-guidance-model-fixture.js';

interface State { label?: string; initial?: Awaited<ReturnType<typeof initialGuidanceAcceptance>>;
  empty?: Awaited<ReturnType<typeof emptyGuidanceAcceptance>>; failure?: Awaited<ReturnType<typeof failureGuidanceAcceptance>>;
  corrected?: Awaited<ReturnType<typeof correctedCliAcceptance>>; repeated?: ReturnType<typeof repeatedCliModel>;
  repeatFlow?: Awaited<ReturnType<typeof repeatedCliAcceptance>>;
  incomplete?: Awaited<ReturnType<typeof incompleteSkillGuidanceAcceptance>>;
  boundary?: ReturnType<typeof modelGuidanceBoundary>; excluded?: ReturnType<typeof modelExcludedResult> }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; };

Given('宿主已加载超过一页的可信工具目录和技能', function (this: SpecWorld) { state(this); });
When('成员首次处理包含{string}的工作', async function (this: SpecWorld, objective: string) { state(this).initial = await initialGuidanceAcceptance(objective); });
Then('模型应收到全部已注册工具元信息及来源版本而不因匹配或排名隐藏工具', function (this: SpecWorld) {
  assert.equal(state(this).initial!.observation.cli.entryCount, 27);
  assert.equal(state(this).initial!.observation.catalogProjection, 'progressive');
});
Then('完整目录应保持精简且不执行命令或扣除工具额度', function (this: SpecWorld) { assert.equal(state(this).initial!.executions, 0); assert.equal(state(this).initial!.ordinaryUsed, 1); });

Given('宿主工具推荐面对{string}', function (this: SpecWorld, label: string) { state(this).label = label; });
When('成员请求当前工作的工具建议', async function (this: SpecWorld) { state(this).empty = await emptyGuidanceAcceptance(state(this).label!); });
Then('应如实区分空目录与无词项匹配并保留已注册元信息和继续发现的入口', function (this: SpecWorld) {
  const result = state(this).empty!;
  assert.equal(result.cli.entries.length, state(this).label === '空目录' ? 0 : 1);
  assert.equal(result.skills.skills.length, 0);
});

Given('当前CLI的真实回执表现为{string}', function (this: SpecWorld, label: string) { state(this).label = label; });
When('系统向原成员提供下一次模型输入', async function (this: SpecWorld) { state(this).failure = await failureGuidanceAcceptance(state(this).label!); });
Then('应提供{string}诊断及原操作标识', function (this: SpecWorld, category: string) { const result = state(this).failure!; assert.equal(result.observation.failures[0]!.category, category); assert.equal(result.observation.failures[0]!.operationId, result.operation.id); });
Then('诊断不得改变原回执或启动纠正命令', function (this: SpecWorld) { const result = state(this).failure!; assert.deepEqual(result.operation.result, result.original); assert(result.executions <= 1); });

Given('成员对已登记命令使用了错误参数', function (this: SpecWorld) { state(this); });
When('成员收到诊断后读取帮助并执行修正后的命令', async function (this: SpecWorld) { state(this).corrected = await correctedCliAcceptance(); });
Then('应收到真实成功回执且所有命令均经过持久化操作和原额度规则', function (this: SpecWorld) { const result = state(this).corrected!; assert.equal(result.executions, 3); assert.equal(result.ordinaryUsed, 7); assert.equal(result.operations.at(-1)!.result!.ok, true); });

Given('同一工作已结算两次相同CLI失败', function (this: SpecWorld) { state(this); });
When('成员在{string}后第三次申请相同命令', async function (this: SpecWorld, condition: string) { state(this).repeated = repeatedCliModel(condition); state(this).repeatFlow = await repeatedCliAcceptance(); });
Then('应返回CLI_REPEAT_FAILURE_LIMIT且不创建或收费新的执行', function (this: SpecWorld) { assert.equal(state(this).repeated!.reply.code, 'CLI_REPEAT_FAILURE_LIMIT'); });
Then('不同帮助参数仍可按原权限申请', function (this: SpecWorld) { const result = state(this).repeatFlow!; assert.equal(result.executions, 4); assert.equal(result.operations.at(-1)!.result!.ok, true); });

Given('工具建议所属工作处于{string}', function (this: SpecWorld, label: string) { state(this).label = label; });
When('运行器读取该工作的工具建议', function (this: SpecWorld) { state(this).boundary = modelGuidanceBoundary(state(this).label!); });
Then('应不提供工具推荐或纠正建议', function (this: SpecWorld) { assert.equal(state(this).boundary!.allowed, false); });

Given('当前本地操作结果为{string}', function (this: SpecWorld, label: string) { state(this).label = label; });
When('系统投影CLI失败建议', function (this: SpecWorld) { state(this).excluded = modelExcludedResult(state(this).label!); });
Then('不应提供该操作的重试诊断', function (this: SpecWorld) { assert.deepEqual(state(this).excluded!.diagnostics, []); });

Given('技能源扫描达到宿主设置的数量边界', function (this: SpecWorld) { state(this); });
When('成员收到当前已扫描技能的完整精简元信息', async function (this: SpecWorld) { state(this).incomplete = await incompleteSkillGuidanceAcceptance(); });
Then('应明确来源扫描不完整且已扫描技能未被省略', function (this: SpecWorld) { const skills = state(this).incomplete!.observation.skills; assert.equal(skills.complete, false); assert.equal(skills.skills.length, 1); });
Then('推荐不得因扫描不完整而自动执行或补装技能', function (this: SpecWorld) { assert.equal(state(this).incomplete!.executions, 0); assert.equal(state(this).incomplete!.ordinaryUsed, 1); });
