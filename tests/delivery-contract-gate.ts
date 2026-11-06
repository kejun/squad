import assert from 'node:assert/strict';
import { deliveryScenarios } from './delivery-contract-scenarios.js';
import { readRevisionDirective, sourceRequestExamples, verifyRevisionDirective } from './source-request-contract-fixture.js';

const args = process.argv.slice(2);
const domainAt = args.indexOf('--domain');
const domain = domainAt < 0 ? undefined : args[domainAt + 1];
const pureDomains = new Set(['交付检查生命周期', '技能资源检查证据', '本地回执证据', '固定原文修订', '固定原文历史']);
const selected = deliveryScenarios.filter(row => (!domain || row.label === domain) && (!args.includes('--pure') || pureDomains.has(row.label)));
let verified = 0;
for (const scenario of selected) {
  const flow = scenario.create();
  assert.equal((await flow.next()).value, 'prepared');
  assert.equal((await flow.next()).value, 'observed');
  assert.equal((await flow.next()).done, true);
  console.log(JSON.stringify({ domain: scenario.label, condition: scenario.condition, operation: scenario.operation, result: scenario.result, status: 'passed' }));
  verified++;
}
if (!domain || domain === '直接修订指令') {
  for (const row of sourceRequestExamples) {
    verifyRevisionDirective(readRevisionDirective(row.text), row.name, row.explicit);
    console.log(JSON.stringify({ domain: '直接修订指令', input: row.text, target: row.name, explicit: row.explicit, status: 'passed' }));
    verified++;
  }
}
assert(verified, `No delivery contract matched ${domain ?? 'default'}`);
console.log(JSON.stringify({ verified, pure: args.includes('--pure') }));
