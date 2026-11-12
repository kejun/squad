import assert from 'node:assert/strict';
import { Before, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { approvalGateDeadline, approvalGateDecision, approvalGateSkip, approvalGateModel } from '../host-approval-gate-model-fixture.js';
import { hostApprovalGateServiceAcceptance, hostApprovalGateSkipServiceAcceptance } from '../host-approval-gate-acceptance.js';

interface Case { id: string; result?: Record<string, unknown> }
const states = new WeakMap<SpecWorld, Case>();
const state = (world: SpecWorld) => { const value = states.get(world); assert(value); return value; };
Before({ tags: '@BT_Y102 or @BT_Y103 or @BT_Y104 or @BT_Y105 or @BT_Y106' }, function (this: SpecWorld, { pickle }) {
  const id = pickle.tags.find(tag => /^@BT_Y10[2-6]$/.test(tag.name))!.name.slice(1); states.set(this, { id });
});
for (const premise of [
  '宿主命令已提出明确批准申请且人类尚未回应',
  '宿主批准申请及对应必需授权门已持久保存',
  '必需宿主批准仍未回应且原命令尚未启动',
]) Given(premise, function (this: SpecWorld) { assert(state(this)); approvalGateModel(); });
Given('真实宿主命令已经产生待批准申请但没有启动进程', function (this: SpecWorld) { assert.equal(state(this).id, 'BT_Y105'); });
Given('宿主批准申请已经保存且原执行器实际等待该批准', function (this: SpecWorld) { assert.equal(state(this).id, 'BT_Y106'); });
When('原命令经历{string}', function (this: SpecWorld, boundary: string) { state(this).result = approvalGateDeadline(boundary); });
When('人类或旧客户端提交{string}', function (this: SpecWorld, decision: string) { state(this).result = approvalGateDecision(decision); });
When('人类在{string}明确跳过该内容', function (this: SpecWorld, timing: string) { state(this).result = approvalGateSkip(timing); });
When('服务经历{string}并重新读取会话', { timeout: 20_000 }, async function (this: SpecWorld, boundary: string) { state(this).result = await hostApprovalGateServiceAcceptance(boundary); });
When('人类通过当前阻塞入口明确跳过授权内容', { timeout: 20_000 }, async function (this: SpecWorld) { state(this).result = await hostApprovalGateSkipServiceAcceptance(); });
for (const consequence of [
  '必需授权门应按原工作操作和批准身份保持待回复',
  '自动窗口不应续期且未批准命令不能执行',
  '只有当前工作操作批准身份的有效决定应解除该权限门',
  '普通回复及过期批准不能获得执行许可',
  '原待批准操作应撤销且原父工作不能继续等待该批准',
  '应记录真实缺失并继续独立内容或交付已有不完整结果',
  '跳过不应成为批准成功或执行成功',
  '到期后跳过命令应请求新窗口而不自动结束全部任务',
  '会话应继续暴露精确授权阻塞和明确人类处理入口',
  '不能仅因token过期或恢复服务而返回业务完成',
  '原批准调用应退出等待且该命令不能启动',
  '后继内容应能获得实际处理且旧批准不能恢复为待领',
]) Then(consequence, function (this: SpecWorld) {
  const result = state(this).result; assert(result, 'Each consequence must have an executed model or actual service prefix');
  if (state(this).id === 'BT_Y102') { assert.equal(result.gateOpen, true); assert.equal(result.unstarted, true); }
  else if (state(this).id === 'BT_Y103') { assert.equal(result.unstarted, true); assert.equal(typeof result.replied, 'boolean'); }
  else if (state(this).id === 'BT_Y104') { assert.equal(result.cancelled, true); assert.equal(result.unstarted, true); }
  else if (state(this).id === 'BT_Y105') { assert.equal(result.requiredGateVisible, true); assert.equal(result.processStarts, 0); assert.equal(result.outcome, null); }
  else { assert.equal(result.originalWaiters, 0); assert.equal(result.nextModelRequest, true); assert.equal(result.processStarts, 0); }
});
