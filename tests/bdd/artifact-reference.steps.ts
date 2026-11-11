import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import {
  cleanupReferenceFixtures, verifyRevisionIsolation, prepareSourceAmbiguity,
  verifySourceRejections, verifyReferenceBusy, verifyReferenceControls,
  verifySourceBeyondHistory, verifyReferenceReplay, verifyReferenceRollback,
  verifyReferenceRecovery, verifyLegacyPublication,
} from '../artifact-reference-fixture.js';
import { verifyRejectedRevision, verifyStoppedRevision, verifyFixedSourceExecution, verifyExplicitPublicationAuthority } from '../artifact-reference-model-fixture.js';
import { verifyReferenceConcurrency } from '../artifact-reference-http-fixture.js';
import { verifyArtifactSourceComposer } from '../artifact-source-ui-fixture.js';

interface ReferenceState { variant?: string; verified?: boolean; select?: () => void }
const states = new WeakMap<SpecWorld, ReferenceState>();
function state(world: SpecWorld) {
  let current = states.get(world); if (!current) { current = {}; states.set(world, current); }
  return current;
}
After(function () { cleanupReferenceFixtures(); });
Given('同群 A 已成功发布唯一的 a.md', function (this: SpecWorld) { state(this); });
When('用户发送修改 a.md 补充部署说明并输出 b.md', function (this: SpecWorld) {
  verifyRevisionIsolation(); state(this).verified = true;
});
Then('应创建由 A 负责的新任务并完整固定 a.md 原文', function (this: SpecWorld) { assert(state(this).verified); });
Then('新文档通过独立检查后才发布且来源可定位原产物', function (this: SpecWorld) { assert(state(this).verified); });
Then('原任务快照历史发布清单和下载正文保持原样', function (this: SpecWorld) { assert(state(this).verified); });
Given('同群有两个成功发布的同名 Markdown', function (this: SpecWorld) { state(this); });
When('用户按文件名请求修改', function (this: SpecWorld) { state(this).select = prepareSourceAmbiguity().select; state(this).verified = true; });
Then('应返回含任务负责人交付时间的候选且不创建或补充任务', function (this: SpecWorld) { assert(state(this).verified); });
When('用户选定一个来源并直接点名现有成员', function (this: SpecWorld) { const select = state(this).select; assert(select); select(); });
Then('应固定所选原文并由点名成员负责', function (this: SpecWorld) { assert(state(this).verified); });
Given('用户选择的来源为{string}', function (this: SpecWorld, variant: string) { state(this).variant = variant; });
When('用户请求引用到新任务', function (this: SpecWorld) { verifySourceRejections(state(this).variant!); state(this).verified = true; });
Then('应明确拒绝且不创建任务或派发工作', function (this: SpecWorld) { assert(state(this).verified); });
Then('存在显式发布记录时不能回退到更早的最终消息', function () { assert.equal(verifyExplicitPublicationAuthority().status, 'passed'); });
Given('群内存在已发布的 a.md', function (this: SpecWorld) { state(this); });
When('用户发送{string}', function (this: SpecWorld, input: string) { verifyReferenceControls(input); state(this).verified = true; });
Then('不应从这条输入创建产物修订任务', function (this: SpecWorld) { assert(state(this).verified); });
Given('群处于{string}', function (this: SpecWorld, variant: string) { state(this).variant = variant; });
When('用户提交明确的产物修订请求', function (this: SpecWorld) { verifyReferenceBusy(state(this).variant!); state(this).verified = true; });
Then('应拒绝本次请求并保留原任务状态消息和工作意图', function (this: SpecWorld) { assert(state(this).verified); });
Given('新任务已固定超出群历史窗口的来源原文', function (this: SpecWorld) { state(this); });
When('历史刷新源任务发布新修订并且服务重启', function (this: SpecWorld) { verifySourceBeyondHistory(); verifyFixedSourceExecution(); state(this).verified = true; });
Then('新任务负责人协作者和独立检查仍取得同一完整原文和用户要求', function (this: SpecWorld) { assert(state(this).verified); });
Then('原文中的伪指令没有调度权限且不作为本轮产物', function (this: SpecWorld) { assert(state(this).verified); });
Given('新任务已固定一份来源原文', function (this: SpecWorld) { state(this); });
When('模型提交{string}', function (this: SpecWorld, candidate: string) { verifyRejectedRevision(candidate); state(this).verified = true; });
Then('不应发布成功结果或改变来源任务', function (this: SpecWorld) { assert(state(this).verified); });
Given('已有合格来源和一个修订请求', function (this: SpecWorld) { state(this); });
When('同请求重放更改载荷并发提交或事务回滚发生', async function (this: SpecWorld) {
  await verifyReferenceConcurrency(); verifyReferenceReplay(); verifyReferenceRollback('memory'); verifyReferenceRollback('sqlite'); verifyReferenceRecovery(); state(this).verified = true;
});
Then('相同载荷只创建一个任务且变更载荷复用标识被拒绝', function (this: SpecWorld) { assert(state(this).verified); });
Then('未提交任务不会执行且来源任务不变', function (this: SpecWorld) { assert(state(this).verified); });
Given('引用任务已领取负责人工作', function (this: SpecWorld) { state(this); });
When('用户停止任务后旧结果返回', function (this: SpecWorld) { verifyStoppedRevision(); state(this).verified = true; });
Then('不应发布成功修订且固定来源与原任务均保持原样', function (this: SpecWorld) { assert(state(this).verified); });
Given('用户预览当前群成功发布的Markdown', function (this: SpecWorld) { state(this); });
When('用户引用到新任务并编辑或移除引用', async function (this: SpecWorld) { await verifyArtifactSourceComposer(); state(this).verified = true; });
Then('输入区应展示可移除的来源且请求只携带来源身份', function (this: SpecWorld) { assert(state(this).verified); });
Then('忙碌拒绝保留输入和引用并允许以新请求标识重发', function (this: SpecWorld) { assert(state(this).verified); });
Given('来源来自可确认发布的旧快照', function (this: SpecWorld) { state(this); });
When('用户修订并再次从新文档发起任务', function (this: SpecWorld) { verifyLegacyPublication(); state(this).verified = true; });
Then('每个任务应只指向自己的直接来源且无引用旧快照行为不变', function (this: SpecWorld) { assert(state(this).verified); });
