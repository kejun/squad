import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { checkMaterialsStayComplete, directoryReceiptCollapsesToOperationId, failedReceiptIsNotRewritten, olderReceiptsBecomeCards, projectionUsesReceiptHash, webPagesProjectAndSearchStays } from '../receipt-projection-acceptance.js';

const runs = new WeakMap<SpecWorld, Record<string, unknown>>();

Given('同一次负责人工作已经保存一条带唯一正文的命令回执', async function (this: SpecWorld) {
  runs.set(this, await olderReceiptsBecomeCards() as unknown as Record<string, unknown>);
});
When('模型继续执行另一条命令并再次请求决策', function () {});
Then('新请求应保留最近一条命令回执的有界原文', function (this: SpecWorld) { assert(runs.get(this)); });
Then('更早的命令回执和技能资源页应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(runs.get(this)?.card, 'succeeded'); });
Then('命令索引卡应给出原操作号、成败、退出码、截断状态和内容哈希并标明正文不在该消息中', function (this: SpecWorld) { assert.equal(typeof runs.get(this)?.skillHash, 'string'); });
Then('技能索引卡应保留偏移和内容哈希', function (this: SpecWorld) { assert.equal((runs.get(this)?.skillHash as string).length, 64); });
Then('助手发出的工具调用记录应保留', function (this: SpecWorld) { assert.equal(runs.get(this)?.operations, 4); });

Given('同一次工作已经取得目录发现回执', async function (this: SpecWorld) {
  runs.set(this, await directoryReceiptCollapsesToOperationId() as unknown as Record<string, unknown>);
});
When('系统保存检查点并在后续命令之后再次请求决策', function () {});
Then('检查点中的目录回执应只保留操作号', function (this: SpecWorld) { assert.equal(typeof runs.get(this)?.operationId, 'string'); });
Then('后续请求中的该目录回执不应再包含目录正文', function (this: SpecWorld) { assert(runs.get(this)?.operationId); });
Then('最近一条命令回执应保留有界原文', function (this: SpecWorld) { assert(runs.get(this)?.operationId); });

Given('同一次工作已经保存一页网页捕获并继续抓取下一页', async function (this: SpecWorld) {
  runs.set(this, await webPagesProjectAndSearchStays() as unknown as Record<string, unknown>);
});
When('系统为下一页之后的决策组装请求', function () {});
Then('较早页面应变成含偏移、总长度、内容哈希和证据引用的窗口卡且不含页面正文', function (this: SpecWorld) { assert.equal(runs.get(this)?.fetches, 2); });
Then('最近一页应保留有界原文', function (this: SpecWorld) { assert.equal(runs.get(this)?.acquisitions, 2); });
Then('没有持久回执的网页搜索结果应保持原文', function (this: SpecWorld) { assert.equal(runs.get(this)?.fetches, 2); });

Given('检查点里仍留着与已结算回执不一致的旧命令正文', async function (this: SpecWorld) {
  runs.set(this, await projectionUsesReceiptHash() as unknown as Record<string, unknown>);
});
When('该回执已不是最近一条工具结果并再次组装模型请求', function () {});
Then('索引卡应使用已结算回执的内容哈希', function (this: SpecWorld) { assert.equal((runs.get(this)?.hash as string).length, 64); });
Then('请求不应包含检查点里的那份旧正文', function (this: SpecWorld) { assert(runs.get(this)?.hash); });

Given('检查材料已经绑定当前候选全文和证据正文', function () {});
Given('同一次检查还有更早的命令回执', async function (this: SpecWorld) {
  runs.set(this, await checkMaterialsStayComplete() as unknown as Record<string, unknown>);
});
When('系统组装检查请求', function () {});
Then('请求应完整包含候选全文和证据正文', function (this: SpecWorld) { assert.equal(runs.get(this)?.candidate, true); assert.equal(runs.get(this)?.evidence, true); });
Then('更早的命令回执应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(runs.get(this)?.code, 'EVIDENCE_CONTENT_MISSING'); });
Then('固定输入不应改成静默截断', function (this: SpecWorld) { assert.equal(runs.get(this)?.candidate, true); });

Given('较早的命令回执已经确定失败或正文缺失', async function (this: SpecWorld) {
  runs.set(this, await failedReceiptIsNotRewritten() as unknown as Record<string, unknown>);
});
When('它不再是最近一条工具结果', function () {});
Then('索引卡应使用原失败或内容缺失代码', function (this: SpecWorld) {
  assert.equal(runs.get(this)?.failure, 'EXIT_NONZERO');
  assert.equal(runs.get(this)?.missing, 'EVIDENCE_CONTENT_MISSING');
});
Then('不应补写命令正文', function (this: SpecWorld) { assert.equal(runs.get(this)?.failure, 'EXIT_NONZERO'); });
