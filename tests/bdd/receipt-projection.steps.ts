import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import type { LocalFixture } from '../local-tools-fixture.js';
import {
  checkMaterialsStayComplete, directoryReceiptCollapsesToOperationId, failedReceiptIsNotRewritten,
  olderReceiptsBecomeCards, prepareDirectoryReceiptScenario, prepareOlderReceiptsScenario, prepareWebPagesScenario,
  projectionUsesReceiptHash, webPagesProjectAndSearchStays, type PreparedWebReceiptScenario,
} from '../receipt-projection-acceptance.js';

type Case = 'older' | 'directory' | 'web' | 'tampered' | 'check' | 'failed';
type Result = Record<string, unknown>;
const cases = new WeakMap<SpecWorld, Case>();
const preparedFixtures = new WeakMap<SpecWorld, LocalFixture | PreparedWebReceiptScenario>();
After({ timeout: 30_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this);
  if (!prepared) return;
  preparedFixtures.delete(this);
  await ('f' in prepared ? prepared.f.close() : prepared.close());
});
const results = new WeakMap<SpecWorld, Result>();
const select = (world: SpecWorld, value: Case) => { cases.set(world, value); results.delete(world); };
const result = (world: SpecWorld) => { const value = results.get(world); assert(value, 'When 必须先执行真实回执投影'); return value; };

Given('同一次负责人工作已准备连续命令和技能读取操作', { timeout: 30_000 }, async function (this: SpecWorld) {
  preparedFixtures.set(this, await prepareOlderReceiptsScenario()); select(this, 'older');
});
When('模型继续执行另一条命令并再次请求决策', { timeout: 60_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !('f' in prepared));
  results.set(this, await olderReceiptsBecomeCards(prepared) as unknown as Result);
});
Then('新请求应保留最近一条命令回执的有界原文', function (this: SpecWorld) { assert.equal(result(this).latestBody, 'UNIQUE-SECOND-STDOUT-BODY'); });
Then('更早的命令回执和技能资源页应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal((result(this).command as { bodyIncluded: boolean }).bodyIncluded, false); assert.equal((result(this).skill as { bodyIncluded: boolean }).bodyIncluded, false); });
Then('命令索引卡应给出原操作号、成败、退出码、截断状态和内容哈希并标明正文不在该消息中', function (this: SpecWorld) { const c = result(this).command as { operationId: string; ok: boolean; exitCode: number; truncated: boolean; capturedContentHash: string; bodyIncluded: boolean }; assert(c.operationId); assert.equal(c.ok, true); assert.equal(c.exitCode, 0); assert.equal(c.truncated, false); assert.match(c.capturedContentHash, /^[a-f0-9]{64}$/); assert.equal(c.bodyIncluded, false); });
Then('技能索引卡应保留偏移和内容哈希', function (this: SpecWorld) { const c = result(this).skill as { offset: number; capturedContentHash: string }; assert.equal(c.offset, 0); assert.match(c.capturedContentHash, /^[a-f0-9]{64}$/); });
Then('助手发出的工具调用记录应保留', function (this: SpecWorld) { assert.equal(result(this).assistantToolCall, true); });

Given('同一次工作已准备目录发现和后续命令操作', { timeout: 30_000 }, async function (this: SpecWorld) {
  preparedFixtures.set(this, await prepareDirectoryReceiptScenario()); select(this, 'directory');
});
When('系统保存检查点并在后续命令之后再次请求决策', { timeout: 60_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !('f' in prepared));
  results.set(this, await directoryReceiptCollapsesToOperationId(prepared) as unknown as Result);
});
Then('检查点中的目录回执应只保留操作号', function (this: SpecWorld) { assert.deepEqual(result(this).checkpointData, { persistedMetadataOperationId: result(this).operationId }); });
Then('后续请求中的该目录回执不应再包含目录正文', function (this: SpecWorld) { assert.equal(result(this).laterBodyIncluded, false); assert.deepEqual(result(this).laterData, { persistedMetadataOperationId: result(this).operationId }); });
Then('最近一条命令回执应保留有界原文', function (this: SpecWorld) { assert.equal(result(this).latestCommandVisible, true); });

Given('同一次工作已配置搜索结果和两页网页捕获来源', { timeout: 30_000 }, async function (this: SpecWorld) {
  preparedFixtures.set(this, await prepareWebPagesScenario()); select(this, 'web');
});
When('系统为下一页之后的决策组装请求', { timeout: 60_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && 'f' in prepared);
  results.set(this, await webPagesProjectAndSearchStays(prepared) as unknown as Result);
});
Then('较早页面应变成含偏移、总长度、内容哈希和证据引用的窗口卡且不含页面正文', function (this: SpecWorld) { const c = result(this).older as { bodyIncluded: boolean; text?: string; offset: number; totalChars: number; contentHash: string; evidenceId: string }; assert.equal(c.bodyIncluded, false); assert.equal(c.text, undefined); assert.equal(c.offset, 0); assert.equal(c.totalChars, 'PAGE-A-UNIQUE-BODY'.length); assert.match(c.contentHash, /^[a-f0-9]{64}$/); assert(c.evidenceId); assert.equal(result(this).olderBodyAbsent, true); });
Then('最近一页应保留有界原文', function (this: SpecWorld) { assert.equal(result(this).latestBody, 'PAGE-B-UNIQUE-BODY'); });
Then('没有持久回执的网页搜索结果应保持原文', function (this: SpecWorld) { assert.equal(result(this).searchSnippetVisible, true); });

Given('检查点里仍留着与已结算回执不一致的旧命令正文', function (this: SpecWorld) { select(this, 'tampered'); });
When('该回执已不是最近一条工具结果并再次组装模型请求', async function (this: SpecWorld) {
  results.set(this, await projectionUsesReceiptHash() as unknown as Result);
});
Then('索引卡应使用已结算回执的内容哈希', function (this: SpecWorld) { assert.match(String(result(this).hash), /^[a-f0-9]{64}$/); });
Then('请求不应包含检查点里的那份旧正文', function (this: SpecWorld) { assert.equal(result(this).tamperedBodyAbsent, true); assert.equal(result(this).latestBodyVisible, true); });

Given('检查材料已经绑定当前候选全文和证据正文', function (this: SpecWorld) { select(this, 'check'); });
Given('同一次检查还有更早的命令回执', function (this: SpecWorld) { assert.equal(cases.get(this), 'check'); });
When('系统组装检查请求', async function (this: SpecWorld) {
  results.set(this, await checkMaterialsStayComplete() as unknown as Result);
});
Then('请求应完整包含候选全文和证据正文', function (this: SpecWorld) {
  assert.equal(result(this).candidate, true); assert.equal(result(this).evidence, true); assert.equal(result(this).latestReceiptVisible, true);
});
Then('更早的命令回执应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(result(this).code, 'EVIDENCE_CONTENT_MISSING'); });
Then('固定输入不应改成静默截断', function (this: SpecWorld) { assert.equal(result(this).fixedInputNotTruncated, true); });

Given('较早的命令回执已经确定失败或正文缺失', function (this: SpecWorld) { select(this, 'failed'); });
When('它不再是最近一条工具结果', async function (this: SpecWorld) {
  results.set(this, await failedReceiptIsNotRewritten() as unknown as Result);
});
Then('索引卡应使用原失败或内容缺失代码', function (this: SpecWorld) {
  assert.equal(result(this).failure, 'EXIT_NONZERO'); assert.equal(result(this).missing, 'EVIDENCE_CONTENT_MISSING'); assert.equal(result(this).failureCompleteness, 'failed');
});
Then('不应补写命令正文', function (this: SpecWorld) { assert.equal(result(this).failedBodyAbsent, true); assert.equal(result(this).missingBodyAbsent, true); assert.equal(result(this).latestBodyVisible, true); });
