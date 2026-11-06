import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { deliveryScenarios, type DeliveryScenario } from '../delivery-contract-scenarios.js';
import type { SpecWorld } from './steps.js';
interface Run { scenario: DeliveryScenario; flow: AsyncGenerator<string, void, unknown> }
const runs = new WeakMap<SpecWorld, Run>();
Given(/^在(.+)中已具备"([^"]*)"并准备"([^"]*)"$/, async function (this: SpecWorld, label: string, condition: string, operation: string) {
  const scenario = deliveryScenarios.find(row => row.label === label && row.condition === condition && row.operation === operation);
  assert(scenario, `Unknown delivery boundary: ${label}: ${condition}: ${operation}`);
  const flow = scenario.create();
  assert.equal((await flow.next()).value, 'prepared');
  runs.set(this, { scenario, flow });
});
When(/^执行本次(.+)的"([^"]*)"$/, async function (this: SpecWorld, label: string, operation: string) {
  const run = runs.get(this); assert(run);
  assert.equal(run.scenario.label, label); assert.equal(run.scenario.operation, operation);
  assert.equal((await run.flow.next()).value, 'observed');
});
Then(/^(.+)的结果应为"([^"]*)"$/, async function (this: SpecWorld, label: string, expected: string) {
  const run = runs.get(this); assert(run);
  assert.equal(run.scenario.label, label); assert.equal(run.scenario.result, expected);
  assert.equal((await run.flow.next()).done, true);
});

import { readRevisionDirective, verifyRevisionDirective } from '../source-request-contract-fixture.js';
const directives = new WeakMap<SpecWorld, { text: string; actual?: ReturnType<typeof readRevisionDirective>; executed: boolean }>();
Given(/^用户本次修订输入为 ([\s\S]*)$/, function (this: SpecWorld, encoded: string) {
  // Gherkin table cells retain literal escape sequences so quoted and indented input stays observable.
  const text = encoded.replace('（四个前导空格）', '    ').replace(/\\(\\|n|t)/g, (_whole, escape: string) => escape === 'n' ? '\n' : escape === 't' ? '\t' : '\\');
  directives.set(this, { text, executed: false });
});
When('系统识别本次输入的旧报告目标', function (this: SpecWorld) {
  const run = directives.get(this); assert(run); run.actual = readRevisionDirective(run.text); run.executed = true;
});
Then(/^旧报告目标应为 (.*) 且显式产物标记为 (是|否)$/, function (this: SpecWorld, name: string, explicit: string) {
  const run = directives.get(this); assert(run?.executed); verifyRevisionDirective(run.actual, name, explicit === '是');
});
