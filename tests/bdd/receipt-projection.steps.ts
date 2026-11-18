import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { LocalFixture } from '../local-tools-fixture.js';
import {
  directoryReceiptCollapsesToOperationId,
  olderReceiptsBecomeCards, prepareDirectoryReceiptScenario, prepareOlderReceiptsScenario, prepareWebPagesScenario,
  prepareProjectionHashScenario, executeProjectionHashScenario, prepareCheckMaterialsScenario, executeCheckMaterialsScenario,
  prepareFailedReceiptScenario, executeFailedReceiptScenario,
  webPagesProjectAndSearchStays, type PreparedWebReceiptScenario, type PreparedReceiptRequest,
} from '../receipt-projection-acceptance.js';

type Case = 'older' | 'directory' | 'web' | 'tampered' | 'check' | 'failed';
type Result = Record<string, unknown>;
const cases = new WeakMap<SpecWorld, Case>();
const preparedFixtures = new WeakMap<SpecWorld, LocalFixture | PreparedWebReceiptScenario | PreparedReceiptRequest>();
After({ timeout: 30_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this);
  if (!prepared) return;
  preparedFixtures.delete(this);
  if (prepared instanceof LocalFixture) await prepared.close();
  else if ('f' in prepared) await prepared.f.close();
  else prepared.h.store.close();
});
const results = new WeakMap<SpecWorld, Result>();
const select = (world: SpecWorld, value: Case) => { cases.set(world, value); results.delete(world); };
const result = (world: SpecWorld) => { const value = results.get(world); assert(value, 'When 必须先执行真实回执投影'); return value; };

Given('同一次负责人工作已准备连续命令和技能读取操作', { timeout: 30_000 }, async function (this: SpecWorld) {
  preparedFixtures.set(this, await prepareOlderReceiptsScenario()); select(this, 'older');
});
When('模型继续执行另一条命令并再次请求决策', { timeout: 60_000 }, async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared instanceof LocalFixture);
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
  const prepared = preparedFixtures.get(this); assert(prepared instanceof LocalFixture);
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

Given('已准备包含旧正文冲突的检查点和两条已保存命令回执', function (this: SpecWorld) {
  preparedFixtures.set(this, prepareProjectionHashScenario()); select(this, 'tampered');
});
When('该回执已不是最近一条工具结果并再次组装模型请求', async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !(prepared instanceof LocalFixture) && !('f' in prepared));
  results.set(this, await executeProjectionHashScenario(prepared) as unknown as Result);
});
Then('索引卡应使用已结算回执的内容哈希', function (this: SpecWorld) { assert.match(String(result(this).hash), /^[a-f0-9]{64}$/); });
Then('请求不应包含检查点里的那份旧正文', function (this: SpecWorld) { assert.equal(result(this).tamperedBodyAbsent, true); assert.equal(result(this).latestBodyVisible, true); });

Given('检查工作已准备当前候选全文、证据正文和更早失败回执', function (this: SpecWorld) {
  preparedFixtures.set(this, prepareCheckMaterialsScenario()); select(this, 'check');
});
Given('检查工作已准备两条命令回执且一条正文缺失', function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !(prepared instanceof LocalFixture) && !('f' in prepared));
  assert.equal(prepared.work.kind, 'check');
  assert.equal(prepared.work.payload.checkMaterials !== undefined, true);
});
When('系统组装检查请求', async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !(prepared instanceof LocalFixture) && !('f' in prepared));
  results.set(this, await executeCheckMaterialsScenario(prepared) as unknown as Result);
});
Then('请求应完整包含候选全文和证据正文', function (this: SpecWorld) {
  assert.equal(result(this).candidate, true); assert.equal(result(this).evidence, true); assert.equal(result(this).latestReceiptVisible, true);
});
Then('更早的命令回执应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(result(this).code, 'EVIDENCE_CONTENT_MISSING'); });
Then('固定输入不应改成静默截断', function (this: SpecWorld) { assert.equal(result(this).fixedInputNotTruncated, true); });

Given('已准备一条失败回执、一条正文缺失回执和一条最新成功回执', function (this: SpecWorld) {
  preparedFixtures.set(this, prepareFailedReceiptScenario()); select(this, 'failed');
});
When('它不再是最近一条工具结果', async function (this: SpecWorld) {
  const prepared = preparedFixtures.get(this); assert(prepared && !(prepared instanceof LocalFixture) && !('f' in prepared));
  results.set(this, await executeFailedReceiptScenario(prepared) as unknown as Result);
});
Then('索引卡应使用原失败或内容缺失代码', function (this: SpecWorld) {
  assert.equal(result(this).failure, 'EXIT_NONZERO'); assert.equal(result(this).missing, 'EVIDENCE_CONTENT_MISSING'); assert.equal(result(this).failureCompleteness, 'failed');
});
Then('不应补写命令正文', function (this: SpecWorld) { assert.equal(result(this).failedBodyAbsent, true); assert.equal(result(this).missingBodyAbsent, true); assert.equal(result(this).latestBodyVisible, true); });
