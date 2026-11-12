import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { catalogModelAcceptance } from '../cli-catalog-model-fixture.js';
import { catalogExplicitAcceptance, catalogForgedCursorAcceptance, catalogInvalidConfigAcceptance, catalogLookupAcceptance,
  catalogModelLoopAcceptance, catalogPaginationAcceptance, skillSearchAcceptance } from '../cli-catalog-acceptance.js';

interface State { constraint?: string; modelResult?: ReturnType<typeof catalogModelAcceptance>; report?: Awaited<ReturnType<typeof catalogLookupAcceptance>>; kind?: string; verified?: boolean }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let item = states.get(world); if (!item) { item = {}; states.set(world, item); } return item; };
Given('成员准备按用途查询宿主命令目录', function (this: SpecWorld) { state(this); });
When('通过真实任务模型保存领取并回传目录结果', function (this: SpecWorld) { state(this).modelResult = catalogModelAcceptance(); });
Then('目录结果应进入原工作检查点且不消耗执行额度', function (this: SpecWorld) {
  const m = state(this).modelResult!.model;
  assert.equal(m.op!.status, 'succeeded'); assert.equal(m.c.usage.ordinary, 1);
  assert(m.c.intents[0]!.localCheckpoint!.messages.at(-1)!.content.includes('document-reader'));
});
Given('命令目录请求受到{string}约束', function (this: SpecWorld, constraint: string) { state(this).constraint = constraint; });
When('通过真实任务模型请求目录查询', function (this: SpecWorld) { const s = state(this); s.modelResult = catalogModelAcceptance(s.constraint); });
Then('命令目录请求应以{string}结束且不得启动命令', function (this: SpecWorld, code: string) {
  const s = state(this); assert.equal(s.modelResult!.response.code, code); assert.equal(s.modelResult!.model.op, undefined);
});
Given('宿主目录登记了文档读取命令及其帮助参数和环境要求', function (this: SpecWorld) { state(this); });
When('成员按{string}查询宿主命令目录', async function (this: SpecWorld, query: string) { state(this).report = await catalogLookupAcceptance(query); });
Then('应找到已登记的文档读取命令并保留帮助参数和环境要求', function (this: SpecWorld) {
  const entries = state(this).report!.cli.catalog!.entries; assert.equal(entries[0]!.command, 'node'); assert.deepEqual(entries[0]!.helpArgs, ['--version']); assert(entries[0]!.requirements!.length);
});
Then('查询只核实存在性而不执行目录中的命令或帮助', function (this: SpecWorld) { assert.equal(state(this).report!.cli.presenceIsNotExecution, true); });
Given('宿主目录包含尚未安装的命令', function (this: SpecWorld) { state(this); });
When('成员查询该目录并显式核实另一个已安装命令', async function (this: SpecWorld) { await catalogExplicitAcceptance(); state(this).verified = true; });
Then('应分别报告目录命令缺失和显式命令存在且保留宿主批准要求', function (this: SpecWorld) { assert(state(this).verified); });
Given('宿主命令目录配置包含{string}', function (this: SpecWorld, problem: string) { state(this).constraint = problem; });
When('服务校验命令目录配置', function (this: SpecWorld) { catalogInvalidConfigAcceptance(state(this).constraint!); state(this).verified = true; });
Then('应明确拒绝该配置而不执行任何命令', function (this: SpecWorld) { assert(state(this).verified); });
Given('本地技能目录包含名称用途和兼容要求不同的技能', function (this: SpecWorld) { state(this); });
When('成员用跨字段关键词检索本地技能', async function (this: SpecWorld) { await skillSearchAcceptance(); state(this).verified = true; });
Then('应返回同时符合全部关键词的技能而不受词序限制', function (this: SpecWorld) { assert(state(this).verified); });
Given('{string}的搜索结果超过原20条分页', function (this: SpecWorld, kind: string) { state(this).kind = kind; });
When('成员一次读取完整匹配结果并核对旧游标', async function (this: SpecWorld) { await catalogPaginationAcceptance(state(this).kind!); state(this).verified = true; });
Then('应无遗漏且无重复地读完匹配条目', function (this: SpecWorld) { assert(state(this).verified); });
Then('修改查询或目录版本后不得复用旧游标', function (this: SpecWorld) { assert(state(this).verified); });
Given('模型只知道需要读取文档而不知道宿主命令名', function (this: SpecWorld) { state(this); });
When('模型查询目录并按返回的帮助参数调用命令', async function (this: SpecWorld) { await catalogModelLoopAcceptance(); state(this).verified = true; });
Then('模型应收到目录和真实命令回执且执行仍经过持久化本地操作', function (this: SpecWorld) { assert(state(this).verified); });
Given('成员查询{string}时提供伪造的分页游标', function (this: SpecWorld, kind: string) { state(this).kind = kind; });
When('读取对应目录页', async function (this: SpecWorld) { await catalogForgedCursorAcceptance(state(this).kind!); state(this).verified = true; });
Then('应返回明确的游标错误而不是空页或跳过结果', function (this: SpecWorld) { assert(state(this).verified); });
