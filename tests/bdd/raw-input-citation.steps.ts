import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { RegenerationFixture } from '../model-regeneration-fixture.js';
import { candidateJudgments } from '../helpers.js';
import type { CheckMaterials } from '../../src/delivery-acceptance.js';
import type { SpecWorld } from './steps.js';
import { TeamEngine } from '../../src/index.js';

const fixtures = new WeakMap<SpecWorld, RegenerationFixture>();
const failures = new WeakMap<RegenerationFixture, string[]>();
After(function (this: SpecWorld) { fixtures.get(this)?.close(); fixtures.delete(this); });
Given('交付检查需要引用用户原始输入且引文为{string}', function (this: SpecWorld, kind: string) {
  const f = new RegenerationFixture('check'); fixtures.set(this, f);
  const errors: string[] = []; failures.set(f, errors);
  f.h.engine = new TeamEngine(f.currentStore, f.h.config, () => f.h.now, (_room, frame) => {
    if (frame.event.type === 'WORK_FAILED') errors.push(frame.event.reason);
  });
  const input = (f.work.payload.rawInputs as CheckMaterials['rawInputs'])[0]!;
  assert(input);
  const results = candidateJudgments(f.h.context().candidate);
  f.replies = [{ type: 'check', criteriaResults: [
    { ...results[0], status: 'failed', reason: '候选未遵守原始输入', source: {
      id: kind === '未提供的输入ID' ? 'not-provided-input' : input.id,
      quote: kind === '非原文改写' ? '这段文字不在原文中' : input.text,
    } }, ...results.slice(1),
  ] }];
});
When('检查器提交带用户输入引用的失败结论', async function (this: SpecWorld) {
  await fixtures.get(this)!.run();
});
Then('输入引用应{string}并在最终正文保留问题',function(this:SpecWorld,expected:string){
 const f=fixtures.get(this)!,c=f.h.context();assert.equal(f.requests.length,1);assert.equal(c.usage.checks,1);assert.equal(c.usage.retries,0);assert.equal(c.outcome,'complete');assert(c.candidate!.text.includes('候选未遵守原始输入'));assert(!c.intents.some(w=>w.status==='pending'));assert(expected);
});
