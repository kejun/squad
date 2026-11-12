import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { cancellationDrainAcceptance, configurationDiagnosticAcceptance, dependencyRecoveryAcceptance,
  notStartedRunnerAcceptance, serviceCloseResponsibilitiesAcceptance, sharedReceiptSemanticsAcceptance,
  receiptWindowRecoveryAcceptance, webScopeRecoveryAcceptance } from '../execution-recovery-acceptance.js';
import { notStartedRecoveryModel, skippedContentCustodyModel, type RecoveryRole } from '../execution-recovery-model-fixture.js';

interface State {
  role?: string; configuration?: string; content?: string; boundary?: string; callback?: string; closeLabel?: string;
  scope?: Awaited<ReturnType<typeof webScopeRecoveryAcceptance>>;
  configured?: Awaited<ReturnType<typeof configurationDiagnosticAcceptance>>;
  semantic?: ReturnType<typeof sharedReceiptSemanticsAcceptance>;
  dependency?: Awaited<ReturnType<typeof dependencyRecoveryAcceptance>>;
  notStarted?: Awaited<ReturnType<typeof notStartedRunnerAcceptance>>;
  close?: Awaited<ReturnType<typeof serviceCloseResponsibilitiesAcceptance>>;
  cancel?: Awaited<ReturnType<typeof cancellationDrainAcceptance>>;
  skip?: ReturnType<typeof skippedContentCustodyModel>;
  receiptBackend?: string;
  receiptWindow?: Awaited<ReturnType<typeof receiptWindowRecoveryAcceptance>>;
}
const states = new WeakMap<SpecWorld, State>();
const state = (world: SpecWorld) => { let value = states.get(world); if (!value) { value = {}; states.set(world, value); } return value; };

Given('{string}已经提交真实CLI正文结果但取得观察尚未提交', function (this: SpecWorld, backend: string) { state(this).receiptBackend = backend; });
When('宿主在此边界中断并重新领取同一工作', async function (this: SpecWorld) {
  state(this).receiptWindow = await receiptWindowRecoveryAcceptance(state(this).receiptBackend!);
});
Then('首次模型调用前应从已保存结果补回匹配资源的取得凭证', function (this: SpecWorld) { assert(state(this).receiptWindow!.beforeAdapter); });
Then('凭证应保留原操作的执行次数采集时间和完整快照', function (this: SpecWorld) {
  const value = state(this).receiptWindow!;
  assert.equal(value.originalAttempt, 1); assert.equal(value.restoredAttempt, 2);
  assert(value.preservedCaptureTime && value.preservedSnapshot);
});
Then('不得重新执行确定命令或为补观察额外计费', function (this: SpecWorld) {
  assert.equal(state(this).receiptWindow!.commandExecutions, 1); assert.equal(state(this).receiptWindow!.extraAcquisitionCharges, 0);
});
Then('恢复后应沿用原正文通过独立检查完成交付', function (this: SpecWorld) { assert.equal(state(this).receiptWindow!.outcome, 'complete'); });

Given('任务已经保存完整工具目录和另一成员的真实工具发现记录', function (this: SpecWorld) { state(this); });
Given('当前执行身份为{string}且仍具有相应工具权限', function (this: SpecWorld, role: string) { state(this).role = role; });
When('该成员通过网页执行并遇到可替代的已知网页读取失败', async function (this: SpecWorld) { state(this).scope = await webScopeRecoveryAcceptance(state(this).role!); });
Then('实际模型输入应收到当前完整工具目录和可复用方法的来源标识', function (this: SpecWorld) { assert.equal(state(this).scope!.modelRequests, 5); });
Then('该失败应被保存并回传为未取得目标资料', function (this: SpecWorld) { assert.equal(state(this).scope!.failureCount, 1); });
Then('成员应能在原期限和预算内选择获准替代方法', function (this: SpecWorld) { assert.equal(state(this).scope!.cliCalls, 1); });
Then('不应因网页执行记录包装丢失失败反馈或重复收取已授权请求费用', function (this: SpecWorld) { assert.equal(state(this).scope!.additionalOrdinary, 4); });

Given('当前读取入口的已知状态为{string}', function (this: SpecWorld, label: string) { state(this).configuration = label; });
When('成员请求带配置诊断的当前工作工具建议', async function (this: SpecWorld) { state(this).configured = await configurationDiagnosticAcceptance(state(this).configuration!); });
Then('应明确返回{string}并保留已有的可行发现或替代入口', function (this: SpecWorld, diagnostic: string) {
  const result = state(this).configured!;
  const actual: Record<string, string | number | undefined> = { 自动目录为空: result.inventory.cli.configuration.state, 目录为空: result.inventory.cli.configuration.state,
    完整登记目录: result.inventory.cli.entries.length, 入口未安装: result.readiness?.installation,
    当前未获授权: result.readiness?.authorization, 需要认证: result.readiness?.authentication };
  const expected: Record<string, string | number> = { 自动目录为空: 'empty', 目录为空: 'empty', 完整登记目录: 1,
    入口未安装: 'not_found', 当前未获授权: 'denied', 需要认证: 'required' };
  assert.equal(actual[diagnostic], expected[diagnostic]);
});
Then('不应把未核实安装、认证或授权状态宣称为可用', function (this: SpecWorld) { assert.equal(state(this).configured!.inventory.executionAuthority, false); });
Then('不应为生成建议自动执行、安装、登录或收费', function (this: SpecWorld) {
  const result = state(this).configured!;
  assert.equal(result.cliCalls, state(this).configuration === '已核实相关账号需要认证' ? 1 : 0);
});

Given('工具用途和调用入口已登记且宿主保存敏感配置', function (this: SpecWorld) { state(this); });
When('成员收到工具建议并选择需要宿主权限的入口', async function (this: SpecWorld) { state(this).configured = await configurationDiagnosticAcceptance('已核实宿主授权被拒绝'); });
Then('建议应提供非敏感配置状态和已知前提', function (this: SpecWorld) { assert.equal(state(this).configured!.inventory.cli.configuration.state, 'configured'); });
Then('凭据值和账号文件内容不得进入模型输入或执行记录', function (this: SpecWorld) { assert.equal(state(this).configured!.credentialsLeaked, false); });
Then('目录元数据和推荐不得代替当前用户的实际授权', function (this: SpecWorld) { assert.equal(state(this).configured!.readiness!.authorization, 'denied'); });

Given('读取工具进程退出成功或返回HTTP200', function (this: SpecWorld) { state(this); });
Given('宿主校验的内容状态为{string}', function (this: SpecWorld, label: string) { state(this).content = label; });
When('系统向其他成员提供该次读取经验', function (this: SpecWorld) { state(this).semantic = sharedReceiptSemanticsAcceptance(state(this).content!); });
Then('应保留原始进程或传输事实', function (this: SpecWorld) { assert.equal(state(this).semantic!.processStatus, 'succeeded'); });
Then('内容级共享方法应标为{string}', function (this: SpecWorld, label: string) {
  const result = state(this).semantic!;
  assert.equal(result.contentMethods, label === '已取得对应资源正文' ? 1 : 0);
});
Then('不得由模型叙述或标准输出自带字段授予正文验证权限', function (this: SpecWorld) { assert.equal(state(this).semantic!.selfReportedVerified, false); });

Given('当前成员仍有权限和执行期限且模型或本地替代仍可用', function (this: SpecWorld) { state(this); });
When('技能发现遇到{string}', async function (this: SpecWorld, boundary: string) { state(this).dependency = await dependencyRecoveryAcceptance(boundary); });
Then('系统应将故障归类为可诊断的暂时依赖失败', function (this: SpecWorld) { assert.equal(state(this).dependency!.usage.retries, 1); });
Then('应在原预算和恢复边界内有限重试或选择替代方法', function (this: SpecWorld) { assert.equal(state(this).dependency!.skillCalls, 2); });
Then('每次实际新增请求均按原规则授权和计费', function (this: SpecWorld) { assert.equal(state(this).dependency!.usage.ordinary, 5); });
Then('不应仅因这次可恢复故障永久等待人类', function (this: SpecWorld) { assert.equal(state(this).dependency!.phase, 'checking'); });

Given('技能发现恢复处于{string}', function (this: SpecWorld, boundary: string) { state(this).boundary = boundary; });
When('系统评估是否继续请求技能服务', async function (this: SpecWorld) { state(this).dependency = await dependencyRecoveryAcceptance(state(this).boundary!); });
Then('不应绕过该边界新增外部请求', function (this: SpecWorld) {
  assert.equal(state(this).dependency!.skillCalls, ['HTTP401', 'HTTP403', '恢复预算已耗尽'].includes(state(this).boundary!) ? 1 : 0);
});
Then('应保留原失败并进入相应的明确人类门或真实降级结果', function (this: SpecWorld) { assert(state(this).dependency!.reason.trim()); });
Then('不得把权限拒绝解释为自动提权或读取账号凭据的许可', function (this: SpecWorld) { assert.equal(state(this).dependency!.usage.retries, 0); });

Given('{string}工作在期限前已成功领取但尚无实际执行许可', function (this: SpecWorld, role: string) { state(this).role = role; });
When('启动校验发生在{string}', async function (this: SpecWorld, timing: string) {
  const lateBy = timing === '截止时刻' ? 0 : 1;
  notStartedRecoveryModel(state(this).role! as RecoveryRole, lateBy);
  state(this).notStarted = await notStartedRunnerAcceptance(state(this).role! as RecoveryRole, lateBy);
});
Then('适配器和外部工具均不应启动', function (this: SpecWorld) { assert.equal(state(this).notStarted!.adapterCalls, 0); });
Then('系统应记录该次尝试未启动', function (this: SpecWorld) { assert(state(this).notStarted); });
Then('应按该角色建立可执行恢复、明确人类门或真实终态', function (this: SpecWorld) { const result = state(this).notStarted!; assert(result.outcome || result.pending > 0 || result.phase === 'waitingHuman'); });
Then('反复定时检查和重启恢复不应留下无推进路径的活动阶段', function (this: SpecWorld) { const result = state(this).notStarted!; assert(result.outcome !== null || result.pending > 0); });

Given('同一服务保存{string}的执行或授权等待责任', function (this: SpecWorld, label: string) { state(this).closeLabel = label; });
When('服务关闭并达到配置的宽限边界', async function (this: SpecWorld) { state(this).close = await serviceCloseResponsibilitiesAcceptance(state(this).closeLabel!); });
Then('系统应完成取消和清理或持久移交未完成责任', function (this: SpecWorld) { assert(state(this).close!.durationMs < 900); });
Then('不得只因该任务不是当前任务而遗漏处理', function (this: SpecWorld) { assert(state(this).close!.responsibilities >= 1); });
Then('重启应从移交记录恢复且不得重复执行已结算操作', function (this: SpecWorld) { assert(state(this).close!.calls <= 2); });
Then('数据库关闭后不应再有未管理的状态写入', function (this: SpecWorld) { assert.deepEqual(state(this).close!.unhandled, []); });

Given('停止请求已使原执行真实结算', function (this: SpecWorld) { state(this); });
Given('外部取消回调{string}', function (this: SpecWorld, callback: string) { state(this).callback = callback; });
When('用户随后关闭服务', async function (this: SpecWorld) { state(this).cancel = await cancellationDrainAcceptance(state(this).callback!); });
Then('关闭应在配置宽限内完成或持久移交剩余取消责任', function (this: SpecWorld) { assert.equal(state(this).cancel!.drain.pending, 1); });
Then('不得无限等待已经没有业务效果的取消回调', function (this: SpecWorld) { assert.equal(state(this).cancel!.outcome, 'stopped'); });
Then('回调的迟到返回或异常不得在数据库关闭后提交结果', function (this: SpecWorld) { assert.equal(state(this).cancel!.lateAccesses, 0); });

Given('用户已经明确跳过某份内容但其外部执行效果尚未核实', function (this: SpecWorld) { state(this); });
When('服务关闭或重新启动', function (this: SpecWorld) { state(this).skip = skippedContentCustodyModel(); });
Then('内容应保持跳过且不得伪造正文成功', function (this: SpecWorld) { assert.equal(state(this).skip!.gateStatus, 'skipped'); assert.equal(state(this).skip!.contentVerified, false); });
Then('未决执行和真实冲突资源仍应有持久核对责任', function (this: SpecWorld) { assert.equal(state(this).skip!.custodyState, 'pending'); });
Then('不得仅因内容被跳过就释放仍有真实执行的独占资源', function (this: SpecWorld) { assert.deepEqual(state(this).skip!.resourceKeys, ['real-conflict-resource']); });
