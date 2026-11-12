import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { boundedFactsModelGate, capabilityFactModelGate, fullPartitionModelGate } from '../task-efficiency-model-fixture.js';
import { capabilityFactAcceptance, fullPartitionAcceptance, sandboxFactAcceptance } from '../task-efficiency-acceptance.js';

interface State { discovery?: string; boundary?: string; capacity?: number; facts?: unknown[]; oversized?: boolean;
  sandbox?: Awaited<ReturnType<typeof sandboxFactAcceptance>>; partitions?: Awaited<ReturnType<typeof fullPartitionAcceptance>> }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; };
Given('同任务成员已经核实{string}并保存回执', function (this: SpecWorld, discovery: string) { capabilityFactModelGate(discovery); state(this).discovery = discovery; });
When('另一成员开始自己的独立工作', async function (this: SpecWorld) { state(this).facts = await capabilityFactAcceptance(state(this).discovery!); });
Then('该成员应看到带原回执标识的能力事实而无需重复发现', function (this: SpecWorld) { assert.equal(state(this).facts!.length, 1); });
Then('事实不得授予执行权限或声称其他来源已经读取', function (this: SpecWorld) { assert.equal((state(this).facts![0] as { observationOnly: boolean }).observationOnly, true); });
Given('同任务成员的沙箱命令已确定失败且没有未知效果', function () { capabilityFactModelGate('沙箱失败'); });
When('另一成员查看当前任务能力事实', async function (this: SpecWorld) { state(this).sandbox = await sandboxFactAcceptance(); });
Then('应看到沙箱不可用及原失败回执而不包含命令输出', function (this: SpecWorld) { assert(!state(this).sandbox!.knowledge.includes('stdout')); });
Then('改用宿主执行仍须经过原有审批', function (this: SpecWorld) { assert.equal(state(this).sandbox!.operation.status, 'awaitingApproval'); });
Given('已保存能力事实受到{string}约束', function (this: SpecWorld, boundary: string) { state(this).boundary = boundary; });
When('为后续成员准备能力事实', function (this: SpecWorld) { const s = state(this); s.facts = s.oversized
  ? boundedFactsModelGate() : capabilityFactModelGate('宿主能力', s.boundary!).facts; });
Then('不应提供该事实且不得启动额外发现或命令', function (this: SpecWorld) { assert.deepEqual(state(this).facts, []); });
Given('同任务积累多份能力回执且一份目录具有大量元信息', function (this: SpecWorld) { state(this).oversized = true; });
Then('全部已结算能力事实和完整目录元信息应保留', function (this: SpecWorld) { assert.equal(state(this).facts!.length, 20); });
Then('未查询的命令不得被推断为不存在', function () { const { facts } = capabilityFactModelGate(); assert(!JSON.stringify(facts).includes('missing-command')); });
Given('八份独立来源的总分片容量为{int}且有四名空闲成员', function (this: SpecWorld, capacity: number) { fullPartitionModelGate(capacity); state(this).capacity = capacity; });
When('理解模型按宿主指引提交完整计划并执行', async function (this: SpecWorld) { state(this).partitions = await fullPartitionAcceptance(state(this).capacity!); });
Then('应保留{int}个分片且完整覆盖八份来源各一次', function (this: SpecWorld, capacity: number) { assert.equal(state(this).partitions!.plan.partitions.length, capacity); assert.equal(state(this).partitions!.sources.length, 8); });
Then('理解指引应仅在明确语义理由下合并独立来源', function (this: SpecWorld) { assert(state(this).partitions); });
Then('实际并发不得超过四名成员且只归并一次', function (this: SpecWorld) { assert.equal(state(this).partitions!.peak, 4); });
