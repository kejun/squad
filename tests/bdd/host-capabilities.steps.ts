import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { hostCapabilityAcceptance, hostCapabilityGuardAcceptance, type HostCapabilityObservation } from '../host-capabilities-acceptance.js';
import type { LocalModel } from '../local-model-fixture.js';
import { capabilityMetadata, assertCapabilityMetadata, minimalCapabilityRequest, cancelCapabilityRequest } from '../host-capabilities-model-fixture.js';
interface State { constraint?: string; observation?: string; metadata?: Awaited<ReturnType<typeof capabilityMetadata>>; verified?: boolean; code?: string; report?: Awaited<ReturnType<typeof hostCapabilityAcceptance>>; observationData?: HostCapabilityObservation; model?: LocalModel }
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let item = states.get(world); if (!item) { item = {}; states.set(world, item); } return item; };
Given('宿主能力查询需要核对{string}', function (this: SpecWorld, observation: string) { state(this).observation = observation; });
When('成员经持久化操作查询指定命令的宿主能力', async function (this: SpecWorld) { const s = state(this);
  if (s.observation === '真实技能和命令') s.report = await hostCapabilityAcceptance(false, data => { s.observationData = data; });
  else if (s.observation === '没有剩余执行额度') { const result = await minimalCapabilityRequest(); s.model = result.m; s.report = result.report; }
  else { s.metadata = await capabilityMetadata(s.observation!); s.model = s.metadata.m; s.report = s.metadata.report; }
  s.verified = true; });
Then('应返回平台、技能发现状态以及逐项命令存在性', function (this: SpecWorld) { const s = state(this); assert(s.report!.platform); assert(s.report!.skills.catalogVersion); assert(Array.isArray(s.report!.cli.commands)); if (s.metadata) assertCapabilityMetadata(s.observation!, s.metadata); });
Then('应区分沙箱可用性、宿主审批边界与未接入的 MCP', function (this: SpecWorld) { const report = state(this).report!; assert.equal(report.cli.hostApprovalRequired, true); assert.equal(report.cli.presenceIsNotExecution, true); assert.equal(typeof report.cli.sandbox.available, 'boolean'); assert.equal(report.mcp.status, 'not_connected'); assert.equal(report.mcp.scope, 'this_service'); });
Then('能力发现不得启动命令、读取凭据或消耗执行额度', function (this: SpecWorld) { const s = state(this); assert.equal(s.report!.cli.queriedOnly, true); if (s.model) { assert.equal(s.model.op?.status, 'succeeded'); assert.equal(s.model.op?.workspaceId, undefined); assert.equal(s.model.c.usage.ordinary, 1); assert(s.model.c.intents[0]?.localCheckpoint?.messages.at(-1)?.content.includes('not_connected')); } else { assert.equal(s.observationData!.backendCalls, 0); assert.equal(s.observationData!.ordinary, 2); } });
Given('能力发现工作受到{string}约束', function (this: SpecWorld, constraint: string) { state(this).constraint = constraint; });
When('成员尝试保存或继续能力发现操作', async function (this: SpecWorld) { const s = state(this); if (['查询前取消', '首个环境查询后取消', '停止后迟到的发现回执'].includes(s.constraint!)) s.code = await cancelCapabilityRequest(s.constraint!); else { const result = hostCapabilityGuardAcceptance(s.constraint!); s.code = result.code; s.model = result.model; } });
Then('应以{string}拒绝发现且不得产生新执行意图', function (this: SpecWorld, code: string) { const s = state(this); assert.equal(s.code, code); if (s.model) { assert.equal(s.model.op, undefined); assert.equal(s.model.c.usage.ordinary, 1); } });
Given('模型需要选择宿主工具且尚未核实命令存在性', function (this: SpecWorld) { state(this); });
When('模型先查询能力再调用已发现的技能或命令', async function (this: SpecWorld) { const s = state(this); s.report = await hostCapabilityAcceptance(true, data => { s.observationData = data; }); });
Then('模型应看到真实能力回执且工具动作仍通过原执行接口', function (this: SpecWorld) { const data = state(this).observationData!; assert.deepEqual(data.actionTypes, ['discoverHost', 'loadSkill', 'readSkillResource', 'runCli']); assert(data.statuses.every(status => status === 'succeeded')); assert(data.receipts.some(text => text.includes('squad-probe') && text.includes('not_connected'))); });
Then('模型上下文应说明未查询能力未知且没有直接 MCP 调用接口', function (this: SpecWorld) { const instructions = state(this).observationData!.instructions; assert(instructions.includes('Only queried commands are checked for installation; absence from the result means unknown')); assert(instructions.includes('The service has no native MCP transport: do not invent MCP tool calls')); });
