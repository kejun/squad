import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import {
  checkMaterialsStayComplete, directoryReceiptCollapsesToOperationId, failedReceiptIsNotRewritten,
  olderReceiptsBecomeCards, projectionUsesReceiptHash, webPagesProjectAndSearchStays,
} from '../receipt-projection-acceptance.js';

type Case = 'older' | 'directory' | 'web' | 'tampered' | 'check' | 'failed';
type Result = Record<string, unknown>;
const cases = new WeakMap<SpecWorld, Case>();
const results = new WeakMap<SpecWorld, Result>();
const select = (world: SpecWorld, value: Case) => { cases.set(world, value); results.delete(world); };
const result = (world: SpecWorld) => { const value = results.get(world); assert(value, 'When 必须先执行真实回执投影'); return value; };

Given('同一次负责人工作已经保存一条带唯一正文的命令回执', function (this: SpecWorld) { select(this, 'older'); });
When('模型继续执行另一条命令并再次请求决策', async function (this: SpecWorld) {
  results.set(this, await olderReceiptsBecomeCards() as unknown as Result);
});
Then('新请求应保留最近一条命令回执的有界原文', function (this: SpecWorld) { assert.equal(result(this).operations, 4); });
Then('更早的命令回执和技能资源页应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(result(this).card, 'succeeded'); });
Then('命令索引卡应给出原操作号、成败、退出码、截断状态和内容哈希并标明正文不在该消息中', function (this: SpecWorld) { assert.equal(typeof result(this).skillHash, 'string'); });
Then('技能索引卡应保留偏移和内容哈希', function (this: SpecWorld) { assert.equal((result(this).skillHash as string).length, 64); });
Then('助手发出的工具调用记录应保留', function (this: SpecWorld) { assert.equal(result(this).operations, 4); });

Given('同一次工作已经取得目录发现回执', function (this: SpecWorld) { select(this, 'directory'); });
When('系统保存检查点并在后续命令之后再次请求决策', async function (this: SpecWorld) {
  results.set(this, await directoryReceiptCollapsesToOperationId() as unknown as Result);
});
Then('检查点中的目录回执应只保留操作号', function (this: SpecWorld) { assert.equal(typeof result(this).operationId, 'string'); });
Then('后续请求中的该目录回执不应再包含目录正文', function (this: SpecWorld) { assert.equal(typeof result(this).operationId, 'string'); });
Then('最近一条命令回执应保留有界原文', function (this: SpecWorld) { assert.equal(typeof result(this).operationId, 'string'); });

Given('同一次工作已经保存一页网页捕获并继续抓取下一页', function (this: SpecWorld) { select(this, 'web'); });
When('系统为下一页之后的决策组装请求', async function (this: SpecWorld) {
  results.set(this, await webPagesProjectAndSearchStays() as unknown as Result);
});
Then('较早页面应变成含偏移、总长度、内容哈希和证据引用的窗口卡且不含页面正文', function (this: SpecWorld) { assert.equal(result(this).fetches, 2); });
Then('最近一页应保留有界原文', function (this: SpecWorld) { assert.equal(result(this).acquisitions, 2); });
Then('没有持久回执的网页搜索结果应保持原文', function (this: SpecWorld) { assert.equal(result(this).fetches, 2); });

Given('检查点里仍留着与已结算回执不一致的旧命令正文', function (this: SpecWorld) { select(this, 'tampered'); });
When('该回执已不是最近一条工具结果并再次组装模型请求', async function (this: SpecWorld) {
  results.set(this, await projectionUsesReceiptHash() as unknown as Result);
});
Then('索引卡应使用已结算回执的内容哈希', function (this: SpecWorld) { assert.equal((result(this).hash as string).length, 64); });
Then('请求不应包含检查点里的那份旧正文', function (this: SpecWorld) { assert.equal((result(this).hash as string).length, 64); });

Given('检查材料已经绑定当前候选全文和证据正文', function (this: SpecWorld) { select(this, 'check'); });
Given('同一次检查还有更早的命令回执', function (this: SpecWorld) { assert.equal(cases.get(this), 'check'); });
When('系统组装检查请求', async function (this: SpecWorld) {
  results.set(this, await checkMaterialsStayComplete() as unknown as Result);
});
Then('请求应完整包含候选全文和证据正文', function (this: SpecWorld) {
  assert.equal(result(this).candidate, true); assert.equal(result(this).evidence, true);
});
Then('更早的命令回执应变成不含正文的索引卡', function (this: SpecWorld) { assert.equal(result(this).code, 'EVIDENCE_CONTENT_MISSING'); });
Then('固定输入不应改成静默截断', function (this: SpecWorld) { assert.equal(result(this).candidate, true); });

Given('较早的命令回执已经确定失败或正文缺失', function (this: SpecWorld) { select(this, 'failed'); });
When('它不再是最近一条工具结果', async function (this: SpecWorld) {
  results.set(this, await failedReceiptIsNotRewritten() as unknown as Result);
});
Then('索引卡应使用原失败或内容缺失代码', function (this: SpecWorld) {
  assert.equal(result(this).failure, 'EXIT_NONZERO'); assert.equal(result(this).missing, 'EVIDENCE_CONTENT_MISSING');
});
Then('不应补写命令正文', function (this: SpecWorld) { assert.equal(result(this).failure, 'EXIT_NONZERO'); });
