import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { unknownBatch, stopBatch, settleBatch, restoreLegacyBatch } from '../host-retry-lifecycle-fixture.js';
import type { SpecWorld } from './steps.js';
const cases = new WeakMap<SpecWorld, ReturnType<typeof unknownBatch>>();
Given('首条宿主续办效果未知且第二条尚未执行', function (this: SpecWorld) { cases.set(this, unknownBatch()); });
When('用户停止并重启恢复这次续办', function (this: SpecWorld) { stopBatch(cases.get(this)!); });
Then('续办应等待已启动命令的核对且不得启动后续命令', function (this: SpecWorld) {
  assert.equal(cases.get(this)!.m.c.hostRetryBatch?.phase, 'draining');
});
When('已启动命令的可信回执到达', function (this: SpecWorld) { settleBatch(cases.get(this)!); });
Then('批次只退休一次且预留释放而真实收费不回退', function (this: SpecWorld) {
  const run = cases.get(this)!; assert.equal(run.m.c.hostRetryBatch, undefined); assert.deepEqual(run.m.c.usage, run.usage);
});
Given('已保存的续办快照没有显式阶段但保留未知执行记录', function (this: SpecWorld) { cases.set(this, unknownBatch()); });
When('恢复旧续办快照并重复请求核对', function (this: SpecWorld) { restoreLegacyBatch(cases.get(this)!); });
Then('应恢复为等待核对且不重复收费或派发下一条命令', function (this: SpecWorld) {
  const run = cases.get(this)!; assert.equal(run.m.c.hostRetryBatch?.phase, 'uncertain'); assert.deepEqual(run.m.c.usage, run.usage);
});
