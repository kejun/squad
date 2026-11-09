import { After, Given, When, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { SpecWorld } from './steps.js';
import { crashEvidenceDirectory, SqliteTransactionCrash } from '../sqlite-transaction-crash.js';
import type { TransactionOperation } from '../fixtures/sqlite-transaction-child.js';
const cases = new WeakMap<SpecWorld, { operation: TransactionOperation; crash?: SqliteTransactionCrash }>();
Given('已准备一个{string}的可信请求但尚未提交', function (this: SpecWorld, operation: string) {
  assert(['报告结果', '本地领取'].includes(operation)); cases.set(this, { operation: operation === '报告结果' ? 'report' : 'lease' });
});
When('宿主在该请求的{string}被强制终止', async function (this: SpecWorld, boundary: string) {
  assert(['完成写入但尚未提交', '完成提交但尚未响应'].includes(boundary));
  const state = cases.get(this)!;
  const point = boundary === '完成写入但尚未提交' ? 'beforeCommit' : 'afterCommit';
  state.crash = new SqliteTransactionCrash(state.operation, point, crashEvidenceDirectory(`${state.operation}-${point}`));
  await state.crash.crash();
});
Then('重开后该请求的快照回执和适用租约应为{string}', function (this: SpecWorld, expected: '全部不可见' | '完整保留') { cases.get(this)!.crash!.verifyBoundary(expected); });
Then('重放相同请求只产生一次可见结果且不会重复派发', function (this: SpecWorld) { cases.get(this)!.crash!.verifyReplay(); });
After(function (this: SpecWorld) { cases.get(this)?.crash?.cleanup(); cases.delete(this); });
