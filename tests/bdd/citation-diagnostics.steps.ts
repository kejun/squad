import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { judgmentsProblem } from '../../src/delivery-acceptance.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, { unknown: boolean; code?: string | null }>();
Given('检查结果包含{string}引用', function (this: SpecWorld, problem: string) { runs.set(this, { unknown: problem === '未知来源' }); });
When('系统接收该检查结论', function (this: SpecWorld) {
 const run = runs.get(this)!;
 run.code = judgmentsProblem([{ id: 'criterion', text: 'requirement', goalVersion: 1, sources: [] }],
 [{ criterionId: 'criterion', status: 'passed', source: { id: run.unknown ? 'private-source-id' : 'known', quote: 'private-rejected-quote' } }],
 [{ id: 'known', content: 'actual source' }]);
});
Then('应报告{string}且不接受引用', function (this: SpecWorld, code: string) { assert.equal(runs.get(this)!.code, code); });
Then('诊断不得包含来源编号或引用正文', function (this: SpecWorld) { const code = runs.get(this)!.code!; assert(!code.includes('private-')); assert(!code.includes('known')); });

Then('应采用合法检查结论且不因可选引用重复审核',function(this:SpecWorld){assert.equal(runs.get(this)!.code,null);});
