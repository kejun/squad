import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { optionalSkillSelectionAcceptance } from '../unified-tool-skill-selection-acceptance.js';
import { originalPrivateToolResponseReplay } from '../unified-tool-skill-protocol-acceptance.js';

interface State { label?: string; result?: Awaited<ReturnType<typeof optionalSkillSelectionAcceptance>>;
  replay?: Awaited<ReturnType<typeof originalPrivateToolResponseReplay>> }
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) {
  let value = states.get(world);
  if (!value) { value = {}; states.set(world, value); }
  return value;
}
Given('模型原始调用输出具有{string}', function (this: SpecWorld, label: string) { state(this).label = label; });
When('适配器在保存本地操作前处理该调用的可选技能字段', { timeout: 30_000 }, async function (this: SpecWorld) {
  const label = state(this).label; assert(label); state(this).result = await optionalSkillSelectionAcceptance(label);
  if (label === '普通宿主调用的空可选技能标识') state(this).replay = await originalPrivateToolResponseReplay();
});
Then('该调用应当{string}', function (this: SpecWorld, expected: string) {
  const result = state(this).result; assert(result);
  if (expected === '首轮进入精确宿主审批且批准前不启动') {
    assert.equal(result.accepted, true); assert.equal(result.firstChoiceModelRequests, 1);
    assert.equal(result.rawResponsePreserved, true); assert.equal(result.canonicalHasSkillId, false);
    assert.equal(result.executions, 1);
    const replay = state(this).replay; assert(replay);
    assert.equal(replay.modelRequests, 1); assert.equal(replay.repairRequests, 0); assert.equal(replay.executions, 0);
  } else {
    assert.equal(expected, '保留原拒绝且不启动'); assert.equal(result.accepted, false);
    assert(result.rejection); assert.equal(result.executions, 0);
  }
});
Then('协议处理不得激活技能修改命令或替代任何执行授权', function (this: SpecWorld) {
  const result = state(this).result; assert(result);
  assert.equal(result.skillBindings, 0); assert.equal(result.sandboxCalls, 0);
});
