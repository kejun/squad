import assert from 'node:assert/strict';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { checkReviewSources, judgmentsProblem } from '../../src/delivery-acceptance.js';
import { Harness } from '../helpers.js';
import type { SpecWorld } from './steps.js';
const runs = new WeakMap<SpecWorld, Harness>();
Given('已保存的成员答复包含换行和引号', function(this: SpecWorld) {
 const h = new Harness(); runs.set(this,h); h.help();
 assert(h.event({type:'HELP_RESULT',requestId:'H1',resultId:'R1',status:'success',answer:'第一行\n第二行："通过"'}).ok);
});
When('当前目标交付进入独立检查', function(this: SpecWorld) { assert(runs.get(this)!.event({type:'DELIVER',text:'交付',artifactIds:[]}).ok); });
Then('原始答复片段应可逐字引用而无需引用JSON转义字符', function(this: SpecWorld) {
 const sources=checkReviewSources(runs.get(this)!.context());
 assert.equal(judgmentsProblem([{id:'C',text:'审查',goalVersion:1,sources:[]}],[{criterionId:'C',status:'passed',source:{id:'R1',quote:'第一行\n第二行："通过"'}}],sources),null);
});
Then('不属于原始答复的改写仍应被拒绝', function(this: SpecWorld) {
 assert.equal(judgmentsProblem([{id:'C',text:'审查',goalVersion:1,sources:[]}],[{criterionId:'C',status:'passed',source:{id:'R1',quote:'第一行 第二行：通过'}}],checkReviewSources(runs.get(this)!.context())),'CHECK_SOURCE_QUOTE_MISMATCH');
});
After(function(this:SpecWorld){runs.get(this)?.store.close();runs.delete(this);});
