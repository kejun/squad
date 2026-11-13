import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { mergedRecallAcceptance, progressiveInventoryAcceptance } from '../tool-discovery-planning-acceptance.js';

interface State {
  progressive?: Awaited<ReturnType<typeof progressiveInventoryAcceptance>>;
  merged?: Awaited<ReturnType<typeof mergedRecallAcceptance>>;
}
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) {
  let value = states.get(world);
  if (!value) { value = {}; states.set(world, value); }
  return value;
}

Given('已接入超过旧展示边界的 CLI 与技能目录', async function (this: SpecWorld) {
  state(this).progressive = await progressiveInventoryAcceptance();
});
Given('成员尚未通过发现动作召回任何 CLI 元信息', function (this: SpecWorld) {
  assert(state(this).progressive);
});
When('尚未召回目录的成员首次选择当前任务工具', function (this: SpecWorld) {
  assert(state(this).progressive);
});
Then('模型应收到内置接口目录规模与观察版本', function (this: SpecWorld) {
  const proof = state(this).progressive; assert(proof);
  assert(proof.inventory.interfaces.length > 0);
  assert(proof.inventory.cli.entryCount! > 64);
});
Then('不得默认附带全部已注册 CLI 与全部已扫描技能的完整条目', function (this: SpecWorld) {
  const proof = state(this).progressive; assert(proof);
  assert.equal(proof.inventory.cli.entries.length, 0);
  assert.equal(proof.inventory.skills.skills.length, 0);
});

Given('工具目录登记了 OCR 相关命令且包含用途未知的通用条目', function (this: SpecWorld) { /* fixture catalog */ });
When('成员发起发现且同时提交中文用途词英文同义词与多个候选命令名', async function (this: SpecWorld) {
  state(this).merged = await mergedRecallAcceptance();
});
Then('系统应合并 BM25 与精确名称命中并去重', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  assert(proof.recalled.entries.some(entry => entry.command === 'tesseract'));
  assert(proof.recalled.entries.some(entry => entry.command === 'git'));
});
Then('名称命中条目应返回完整目录资料', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  const tesseract = proof.recalled.entries.find(entry => entry.command === 'tesseract');
  assert(tesseract?.scenarios?.length);
});
Then('目录未登记名称应作为检索假设单独标注且不得推断已安装或任务完成', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  assert.deepEqual(proof.recalled.recall?.unregisteredNames, ['paddleocr']);
});

Given('成员已通过发现动作召回若干 CLI 元信息', async function (this: SpecWorld) {
  state(this).merged = await mergedRecallAcceptance();
});
When('同一任务发起下一次模型请求', function (this: SpecWorld) {
  assert(state(this).merged?.followUp);
});
Then('渐进式工具上下文应包含已召回 CLI 条目', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  assert(proof.followUp.cli.entries.some(entry => entry.command === 'tesseract'));
});
Then('未召回条目仍应通过发现动作可取回', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  assert(!proof.followUp.cli.entries.some(entry => entry.command === 'pdftotext'));
});

Then('生成目录上下文不得启动命令或授予执行权限', function (this: SpecWorld) {
  const proof = state(this).progressive; assert(proof);
  assert.equal(proof.inventory.executionAuthority, false);
  assert.equal(proof.inventory.metadataOnly, true);
});

Then('发现不得启动命令或消耗执行额度', async function (this: SpecWorld) {
  const proof = state(this).merged ?? await mergedRecallAcceptance();
  assert(proof);
  assert(proof.recalled.entries.length > 0);
});

Then('目录观察不得冒充授权或执行结果', function (this: SpecWorld) {
  const proof = state(this).merged; assert(proof);
  assert.equal(proof.followUp.executionAuthority, false);
  assert.equal(proof.followUp.metadataOnly, true);
});
