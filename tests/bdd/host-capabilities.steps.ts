import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { hostCapabilityAcceptance, hostCapabilityGuardAcceptance } from '../host-capabilities-acceptance.js';
interface State { constraint?: string; verified?: boolean; code?: string }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let item = states.get(world); if (!item) { item = {}; states.set(world, item); } return item; };
Given('宿主存在可用技能以及已安装和未安装的命令', function (this: SpecWorld) { state(this); });
When('成员经持久化操作查询指定命令的宿主能力', async function (this: SpecWorld) { await hostCapabilityAcceptance(); state(this).verified = true; });
Then('应返回平台、技能发现状态以及逐项命令存在性', function (this: SpecWorld) { assert(state(this).verified); });
Then('应区分沙箱可用性、宿主审批边界与未接入的 MCP', function (this: SpecWorld) { assert(state(this).verified); });
Then('能力发现不得启动命令、读取凭据或消耗执行额度', function (this: SpecWorld) { assert(state(this).verified); });
Given('能力发现工作受到{string}约束', function (this: SpecWorld, constraint: string) { state(this).constraint = constraint; });
When('成员尝试保存能力发现操作', function (this: SpecWorld) { state(this).code = hostCapabilityGuardAcceptance(state(this).constraint!).code; });
Then('应以{string}拒绝发现且不得产生新执行意图', function (this: SpecWorld, code: string) { assert.equal(state(this).code, code); });
Given('模型需要选择宿主工具且尚未核实命令存在性', function (this: SpecWorld) { state(this); });
When('模型先查询能力再调用已发现的技能或命令', async function (this: SpecWorld) { await hostCapabilityAcceptance(true); state(this).verified = true; });
Then('模型应看到真实能力回执且工具动作仍通过原执行接口', function (this: SpecWorld) { assert(state(this).verified); });
Then('模型上下文应说明未查询能力未知且没有直接 MCP 调用接口', function (this: SpecWorld) { assert(state(this).verified); });
