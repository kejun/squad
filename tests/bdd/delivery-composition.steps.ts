import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { createVerification, createCycles, type DeliveryBackend } from '../delivery-composition-fixture.js';
import { createSourceLineage } from '../source-lineage-formal-fixture.js';
import type { SpecWorld } from './steps.js';

type Case = { directory: string; fixture: { apply(action: string): Record<string, unknown>; observe(): Record<string, unknown>; close(): void } };
const cases = new WeakMap<SpecWorld, Case>();
function current(world: SpecWorld) { const value = cases.get(world); assert(value); return value.fixture; }
async function create(world: SpecWorld, backend: string, kind: 'verification' | 'cycles' | 'lineage') {
  assert(backend === 'memory' || backend === 'sqlite');
  const directory = mkdtempSync(join(tmpdir(), 'squad-delivery-composition-bdd-'));
  try {
    const fixture = await (kind === 'verification' ? createVerification : kind === 'cycles' ? createCycles : createSourceLineage)(process.cwd(), backend as DeliveryBackend, directory);
    cases.set(world, { directory, fixture });
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
After(function (this: SpecWorld) {
  const value = cases.get(this);
  if (value) { value.fixture.close(); rmSync(value.directory, { recursive: true, force: true }); cases.delete(this); }
});
Given('使用{string}创建需要运行工程验证的候选', async function (this: SpecWorld, backend: string) { await create(this, backend, 'verification'); });
When('在工程回执前申请模型检查并随后保存成功的隔离工程回执', function (this: SpecWorld) {
  current(this).apply('ConsumeEarly'); current(this).apply('RequestValidation'); current(this).apply('ClaimValidation'); current(this).apply('StartValidation'); current(this).apply('ValidationPassed');
});
Then('首次申请应获准且后续验证结果应保留在同一检查工作', function (this: SpecWorld) {
  const snapshot = current(this).apply('Consume'); assert('stage' in snapshot); assert.equal(snapshot.stage, 5); assert.equal(snapshot.earlyCheckAllowed, true);
});
When('本轮独立检查返回通过并完成相同版本的最终复核', function (this: SpecWorld) {
  current(this).apply('ModelResult'); current(this).apply('RequestVersion'); current(this).apply('ClaimVersion'); current(this).apply('StartVersion'); current(this).apply('VersionResult'); current(this).apply('Publish');
});
Then('当前候选应原子发布且只有一条对应最终消息', function (this: SpecWorld) { const snapshot = current(this).observe(); assert('published' in snapshot); assert.equal(snapshot.published, true); });
When('保存隔离工程回执并取得独立检查结果后出现{string}', function (this: SpecWorld, boundary: string) {
  const fixture = current(this); fixture.apply('RequestValidation'); fixture.apply('ClaimValidation'); fixture.apply('StartValidation'); fixture.apply('ValidationPassed'); fixture.apply('Consume'); fixture.apply('ModelResult');
  if (boundary === '缺少最终版本复核') fixture.apply('PublishWithoutVersion');
  else { assert.equal(boundary, '工作区版本变化'); fixture.apply('ChangeWorkspace'); fixture.apply('RequestVersion'); fixture.apply('ClaimVersion'); fixture.apply('StartVersion'); fixture.apply('VersionFailure'); fixture.apply('FailVersionWork'); }
});
Then('本轮应正常交付且正文声明实际版本验证缺口', function (this: SpecWorld) { const snapshot = current(this).observe(); assert('published' in snapshot); assert.equal(snapshot.published, true); assert.equal(snapshot.gapsDeclared,true); });
Given('使用{string}成功发布了第一版文档', async function (this: SpecWorld, backend: string) { await create(this, backend, 'cycles'); });
When('用户连续修订两轮并在每轮交错提交旧检查回执', function (this: SpecWorld) {
  const fixture = current(this);
  fixture.apply('Continue'); fixture.apply('ClaimOwner'); fixture.apply('Draft'); fixture.apply('ClaimCheck'); fixture.apply('Consume'); fixture.apply('LateReceipt'); fixture.apply('OldReceipt'); fixture.apply('Pass');
  fixture.apply('Continue'); fixture.apply('ClaimOwner'); fixture.apply('Draft'); fixture.apply('ClaimCheck'); fixture.apply('Consume'); fixture.apply('LateReceipt'); fixture.apply('OldReceipt'); fixture.apply('Pass');
});
Then('每轮只由对应的新检查发布新修订且三份历史最终消息保持原选择', function (this: SpecWorld) {
  const snapshot = current(this).observe(); assert('finals' in snapshot); assert.equal(snapshot.finals, 3); assert.equal(snapshot.publication, 3); assert.equal(snapshot.oldAccepted, false);
});

Given('使用{string}发布原文并创建固定来源的修订任务', async function (this: SpecWorld, backend: string) {
  await create(this, backend, 'lineage'); current(this).apply('FreezeB');
});
When('停止修订任务并让原任务发布新版后重开存储', function (this: SpecWorld) {
  const fixture = current(this); fixture.apply('StopB'); fixture.apply('ContinueA'); fixture.apply('ClaimA'); fixture.apply('DeliverA'); fixture.apply('ClaimCheckA'); fixture.apply('ConsumeA'); fixture.apply('RepublishA'); fixture.apply('Reopen');
});
Then('新选择应拒绝旧发布且原引用请求重放不应替换已固定的来源', function (this: SpecWorld) {
  const fixture = current(this); fixture.apply('RejectStale'); fixture.apply('ReplayFreeze'); fixture.apply('ConflictReplay');
});
When('继续原修订任务并独立发布后再以该文档创建下一任务', function (this: SpecWorld) {
  const fixture = current(this); fixture.apply('ResumeB'); fixture.apply('RecoverFrozen'); fixture.apply('ClaimB'); fixture.apply('DeliverB'); fixture.apply('ClaimCheckB'); fixture.apply('ConsumeB'); fixture.apply('PublishB'); fixture.apply('FreezeC');
});
Then('原修订应保留旧原文且下一任务只标记直接交付作为来源', function (this: SpecWorld) {
  const snapshot = current(this).observe(); assert.equal(snapshot.sourceVersion, 2); assert.equal(snapshot.frozenVersion, 1); assert.equal(snapshot.direct, true);
});
