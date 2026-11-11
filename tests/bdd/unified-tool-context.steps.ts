import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { completeToolInventoryAcceptance, directHostInventoryAcceptance, inventoryRefreshAcceptance,
  inventorySelectionChangeAcceptance, inventoryRefreshFailureAcceptance, sharedInventoryObservationAcceptance,
  pinnedSkillInventoryAcceptance, inventoryBoundaryAcceptance, incompleteInventoryAcceptance } from '../unified-tool-context-acceptance.js';

interface State {
  premise?: string; metadataLanguage?: boolean; label?: string; stage?: string;
  complete?: Awaited<ReturnType<typeof completeToolInventoryAcceptance>>;
  host?: Awaited<ReturnType<typeof directHostInventoryAcceptance>>;
  browser?: { executions: number; sandboxCalls: number; approvalPosts: number; evidence: string };
  refresh?: Awaited<ReturnType<typeof inventoryRefreshAcceptance>>;
  selected?: Awaited<ReturnType<typeof inventorySelectionChangeAcceptance>>;
  failed?: Awaited<ReturnType<typeof inventoryRefreshFailureAcceptance>>;
  shared?: Awaited<ReturnType<typeof sharedInventoryObservationAcceptance>>;
  pinned?: Awaited<ReturnType<typeof pinnedSkillInventoryAcceptance>>;
  boundary?: Awaited<ReturnType<typeof inventoryBoundaryAcceptance>>;
  incomplete?: Awaited<ReturnType<typeof incompleteInventoryAcceptance>>;
}
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) {
  let value = states.get(world);
  if (!value) { value = {}; states.set(world, value); }
  return value;
}

Given('已接入网页工具以及超过旧展示数量和分页边界的CLI与技能', function (this: SpecWorld) { state(this).premise = 'complete'; });
Given('工具元信息使用不同语言且部分工具没有匹配当前任务的词项', function (this: SpecWorld) { state(this).metadataLanguage = true; });
When('获准成员首次选择完成当前任务所需的工具', async function (this: SpecWorld) {
  assert.equal(state(this).premise, 'complete'); assert.equal(state(this).metadataLanguage, true);
  state(this).complete = await completeToolInventoryAcceptance();
});
Then('模型应同时收到全部已注册CLI全部已扫描技能和获准网页工具的精简元信息', function (this: SpecWorld) {
  const proof = state(this).complete; assert(proof);
  assert.equal(proof.inventory.cli.entries.length, 27); assert.equal(proof.inventory.skills.skills.length, 28);
  assert(proof.inventory.interfaces.some(tool => tool.type === 'web_fetch'));
  assert(proof.inventory.interfaces.some(tool => tool.type === 'web_search'));
});
Then('同名工具的沙盒与宿主能力前提和授权要求应分别保留', function (this: SpecWorld) {
  const proof = state(this).complete; assert(proof);
  const reader = proof.inventory.cli.entries.find(entry => entry.command === 'node'); assert(reader);
  assert.deepEqual(reader.variants.map(variant => variant.execution), ['sandbox', 'host']);
  assert.equal(reader.variants.find(variant => variant.execution === 'host')!.approvalRequired, true);
});
Then('生成目录上下文不得启动命令取得正文或授予执行权限', function (this: SpecWorld) {
  const proof = state(this).complete; assert(proof);
  assert.equal(proof.executions, 0); assert.equal(proof.ordinaryUsed, 1);
  assert.equal(proof.inventory.metadataOnly, true); assert.equal(proof.inventory.executionAuthority, false);
});

Given('当前成员尚未执行沙盒命令且已看见适用的宿主工具元信息', function (this: SpecWorld) { state(this).premise = 'direct-host'; });
When('成员直接申请该宿主调用且用户决定为{string}', { timeout: 60_000 }, async function (this: SpecWorld, decision: string) {
  assert.equal(state(this).premise, 'direct-host'); state(this).label = decision;
  state(this).host = await directHostInventoryAcceptance(decision);
  if (decision === '明确批准') {
    const browser = await import(new URL('../unified-tool-context-browser-case.mjs', import.meta.url).href);
    state(this).browser = await browser.directHostInventoryBrowserAcceptance();
  }
});
Then('系统应保存该具体调用并在宿主启动前显示其精确授权要求', function (this: SpecWorld) {
  const proof = state(this).host; assert(proof);
  assert(proof.approval.operationId); assert(proof.approval.approvalId); assert(proof.approval.executable);
  assert.equal(proof.firstModelRequests, 1); assert.equal(proof.sandboxCalls, 0);
});
Then('宿主实际执行应符合{string}且不得额外制造沙盒失败', function (this: SpecWorld, expected: string) {
  const proof = state(this).host; assert(proof); assert.equal(proof.sandboxCalls, 0);
  assert.equal(proof.runs, expected === '批准后一次启动' ? 'once\n' : '');
  if (expected === '批准后一次启动') {
    const browser = state(this).browser; assert(browser);
    assert.equal(browser.executions, 1); assert.equal(browser.sandboxCalls, 0); assert.equal(browser.approvalPosts, 1);
    assert(browser.evidence);
  } else assert.equal(expected, '零次启动');
});

Given('多名成员共用一份有效工具目录且任务已有执行契约版本', function (this: SpecWorld) { state(this).premise = 'refresh'; });
When('目录通过{string}发布新增修改或移除后的有效元信息', { timeout: 30_000 }, async function (this: SpecWorld, kind: string) {
  assert.equal(state(this).premise, 'refresh'); state(this).refresh = await inventoryRefreshAcceptance(kind);
});
Then('后续模型请求应看见同一份完整新目录而已发请求保留其原一致视图', function (this: SpecWorld) {
  const proof = state(this).refresh; assert(proof); assert.equal(proof.views.length, 3);
  assert.notEqual(proof.views[0]!.catalogVersion, proof.views[1]!.catalogVersion);
  assert.equal(proof.views[1]!.catalogVersion, proof.views[2]!.catalogVersion);
});
Then('目录观察版本变化不得修改任务执行契约或使无关工作与批准失效', function (this: SpecWorld) {
  const proof = state(this).refresh; assert(proof); assert.equal(proof.contractVersionUnchanged, true); assert.equal(proof.executions, 1);
});

Given('成员选中的宿主调用处于{string}', function (this: SpecWorld, stage: string) { state(this).stage = stage; });
When('实际执行前发生{string}', { timeout: 30_000 }, async function (this: SpecWorld, change: string) {
  const stage = state(this).stage; assert(stage); state(this).selected = await inventorySelectionChangeAcceptance(stage, change);
});
Then('系统应按{string}处理该调用且不得扩大批准范围', function (this: SpecWorld, expected: string) {
  const proof = state(this).selected; assert(proof);
  const outcomes: Record<string, { code: string; executions: number }> = {
    '返回TOOL_METADATA_CHANGED与新目录供重选且零次启动': { code: 'TOOL_METADATA_CHANGED', executions: 0 },
    '拒绝过时批准且零次启动': { code: 'HOST_APPROVAL_STALE', executions: 0 },
    '原计划不变且按原批准一次启动': { code: 'succeeded', executions: 1 },
  };
  const outcome = outcomes[expected]; assert(outcome);
  assert.equal(proof.code, outcome.code); assert.equal(proof.executions, outcome.executions);
});

Given('当前目录已发布且成员可以继续按原权限作出判断', function (this: SpecWorld) { state(this).premise = 'failed-refresh'; });
When('下一次目录刷新遭遇{string}', { timeout: 30_000 }, async function (this: SpecWorld, failure: string) {
  assert.equal(state(this).premise, 'failed-refresh'); state(this).failed = await inventoryRefreshFailureAcceptance(failure);
});
Then('后续请求应收到最后有效目录与可追溯刷新诊断而没有半份新目录', function (this: SpecWorld) {
  const proof = state(this).failed; assert(proof);
  assert.equal(proof.observed.refresh.status, 'failed'); assert(proof.observed.refresh.error);
  assert.equal(proof.observed.cli.entries.length, 1); assert.equal(proof.executions, 0);
});
Then('随后恢复有效配置应发布新目录并清除本次刷新失败状态', function (this: SpecWorld) {
  const proof = state(this).failed; assert(proof);
  assert.equal(proof.recovered.refresh.status, 'current'); assert.equal(proof.recovered.refresh.error, undefined);
  assert.notEqual(proof.recovered.catalogVersion, proof.observed.catalogVersion); assert.equal(proof.recovered.cli.entries.length, 2);
});

Given('多名成员需要连续判断工具且已保存部分工具的存在性观测', function (this: SpecWorld) { state(this).premise = 'shared'; });
When('成员在目录未变化时发起首次及后续模型请求', { timeout: 30_000 }, async function (this: SpecWorld) {
  assert.equal(state(this).premise, 'shared'); state(this).shared = await sharedInventoryObservationAcceptance();
});
Then('各请求应取得完整一致目录及带来源时间的已有观测', function (this: SpecWorld) {
  const proof = state(this).shared; assert(proof);
  assert(proof.views.every(view => view.catalogVersion === proof.views[0]!.catalogVersion));
  const readiness = proof.memberViews[0]!.cli.entries[0]!.variants.find(variant => variant.execution === 'sandbox')!.readiness;
  assert.equal(readiness.installation, 'found'); assert(readiness.sourceOperationIds.length > 0); assert.notEqual(readiness.observedAt, null);
});
Then('未核实的安装登录网络状态应保持未知且目录观察不得冒充授权', function (this: SpecWorld) {
  const proof = state(this).shared; assert(proof);
  const readiness = proof.memberViews[0]!.cli.entries[0]!.variants.find(variant => variant.execution === 'sandbox')!.readiness;
  assert.equal(readiness.authentication, 'unknown'); assert.equal(readiness.network, 'unknown');
  assert.equal(proof.memberViews[0]!.executionAuthority, false);
});
Then('决策读取不得重新扫描技能源运行帮助探测账号或增加发现往返', function (this: SpecWorld) {
  const proof = state(this).shared; assert(proof);
  assert.equal(proof.discoveryOperations, 1); assert.equal(proof.extraDiscoveryOperations, 0); assert.equal(proof.executions, 1);
});

Given('当前任务已按现有规则固定并加载一个技能版本', function (this: SpecWorld) { state(this).premise = 'pinned'; });
When('该技能源修改后后台发布新技能元信息', { timeout: 30_000 }, async function (this: SpecWorld) {
  assert.equal(state(this).premise, 'pinned'); state(this).pinned = await pinnedSkillInventoryAcceptance();
});
Then('后续模型应能区分当前目录版本与本任务已固定版本', function (this: SpecWorld) {
  const proof = state(this).pinned; assert(proof); assert.notEqual(proof.currentVersion, proof.oldVersion);
});
Then('原任务继续读取已固定内容且不得被静默替换或取得额外权限', function (this: SpecWorld) {
  const proof = state(this).pinned; assert(proof);
  assert.equal(proof.originalContentPreserved, true); assert.equal(proof.executions, 0); assert.equal(proof.normalRemovalPublished, true);
});

Given('目录所属工作已处于{string}', function (this: SpecWorld, boundary: string) { state(this).label = boundary; });
When('系统准备该工作的下一次模型请求或命令启动', { timeout: 30_000 }, async function (this: SpecWorld) {
  const boundary = state(this).label; assert(boundary); state(this).boundary = await inventoryBoundaryAcceptance(boundary);
});
Then('完整工具上下文不得使该工作越过原可见性执行结算和授权守卫', function (this: SpecWorld) {
  const proof = state(this).boundary; assert(proof); assert.equal(proof.modelAllowed, false);
});
Then('最终检查的固定材料不得因工具目录刷新而扩充', function (this: SpecWorld) {
  const proof = state(this).boundary; assert(proof); assert.equal(proof.checkInventoryMessages, 0);
});

Given('工具目录来源处于{string}', function (this: SpecWorld, kind: string) { state(this).label = kind; });
When('成员读取统一工具上下文', { timeout: 30_000 }, async function (this: SpecWorld) {
  const kind = state(this).label; assert(kind); state(this).incomplete = await incompleteInventoryAcceptance(kind);
});
Then('系统应如实给出已接入内容与未配置不完整或未知的来源状态', function (this: SpecWorld) {
  const proof = state(this).incomplete; assert(proof);
  assert.equal(proof.inventory.cli.configuration.state, proof.kind === 'CLI目录明确为空' ? 'empty' : 'unconfigured');
  if (proof.kind === '技能源扫描达到边界') assert.equal(proof.inventory.skills.complete, false);
});
Then('不得虚构目录外工具已安装已登录可联网或已获授权', function (this: SpecWorld) {
  const proof = state(this).incomplete; assert(proof);
  assert.equal(proof.inventory.cli.entries.length, 0); assert.equal(proof.inventory.executionAuthority, false); assert.equal(proof.executions, 0);
  if (proof.kind === '宿主MCP未接入本服务') assert(!proof.inventory.interfaces.some(tool => tool.type.startsWith('mcp')));
});
Then('同一代技能源完整性应在统一目录本地技能目录和宿主发现接口中保持一致', function (this: SpecWorld) {
  const proof = state(this).incomplete; assert(proof);
  assert.equal(proof.completeness.local, proof.completeness.inventory);
  assert.equal(proof.completeness.registry, proof.completeness.inventory);
  assert.equal(proof.completeness.discovery, proof.completeness.inventory);
});
