import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';

interface Row { id: string; file: string; name: string; cases: number; passedGherkinCases: number; regressionTests: string[] }
const rows = new Map<string, Row>();
for (const file of readdirSync('features').filter(f => f.endsWith('.feature')).sort()) {
  const messages = generateMessages(readFileSync(`features/${file}`, 'utf8'), file, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, { newId: IdGenerator.incrementing(), includeGherkinDocument: true, includePickles: true, includeSource: false });
  const errors = messages.filter(m => m.parseError);
  if (errors.length) throw new Error(JSON.stringify(errors));
  for (const message of messages) {
    const p = message.pickle;
    if (!p) continue;
    const id = p.tags.find(t => /^@BT_[A-Z]\d+$/.test(t.name))?.name.slice(1);
    if (!id) throw new Error(`Missing scenario identity: ${p.name}`);
    const row = rows.get(id) ?? { id, file, name: p.name, cases: 0, passedGherkinCases: 0, regressionTests: [] };
    row.cases++; rows.set(id, row);
  }
}
const unit = JSON.parse(readFileSync('test-results/vitest.json', 'utf8')) as { numTotalTests: number; numPassedTests: number; testResults: { assertionResults: { fullName: string; status: string }[] }[] };
if (unit.numTotalTests !== unit.numPassedTests) throw new Error('Regression tests did not all pass');
for (const file of unit.testResults) for (const test of file.assertionResults) {
  if (test.status !== 'passed') continue;
  for (const match of test.fullName.matchAll(/\[(BT_[A-Z]\d+)\]/g)) rows.get(match[1]!)?.regressionTests.push(test.fullName);
}
const bdd = JSON.parse(readFileSync('test-results/cucumber.json', 'utf8')) as { elements: { type: string; tags?: { name: string }[]; steps: { result: { status: string } }[] }[] }[];
let passedBdd = 0;
for (const feature of bdd) for (const scenario of feature.elements) {
  if (scenario.type !== 'scenario') continue;
  if (!scenario.steps.every(step => step.result.status === 'passed')) throw new Error('Gherkin scenario did not pass');
  const id = scenario.tags?.find(t => /^@BT_[A-Z]\d+$/.test(t.name))?.name.slice(1);
  if (!id || !rows.has(id)) throw new Error('Unknown Gherkin identity in results');
  rows.get(id)!.passedGherkinCases++; passedBdd++;
}
const scenarios = [...rows.values()];
const report = {
  baseline: 'v0.4', scope: 'XState domain core; no live Pi Durable adapter or web UI',
  totals: { features: 9, definitions: scenarios.length, cases: scenarios.reduce((sum, r) => sum + r.cases, 0),
    regressionTestsPassed: unit.numPassedTests, directlyExecutedGherkinCasesPassed: passedBdd,
    fullyExecutedGherkinDefinitions: scenarios.filter(r => r.cases === r.passedGherkinCases).length,
    definitionsWithLinkedRegressionTests: scenarios.filter(r => r.regressionTests.length > 0).length },
  note: 'A linked regression test is not a claim that every original step/example is implemented. Only passedGherkinCases reports direct execution.',
  scenarios,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/spec-coverage.json', JSON.stringify(report, null, 2) + '\n');
const table = scenarios.map(r => `| ${r.id} | ${r.name} | ${r.passedGherkinCases}/${r.cases} | ${r.regressionTests.length ? '已关联回归断言' : '待实现或绑定'} |`).join('\n');
writeFileSync('reports/spec-coverage.md', `# Gherkin 与 XState 覆盖报告\n\n本次是状态执行内核。真实 Pi Durable 适配器和网页尚未实现。\n\n已通过 ${unit.numPassedTests} 项回归测试，直接执行原 Gherkin 的 ${passedBdd} 个用例。全部原规格共有 ${scenarios.length} 个场景定义、${report.totals.cases} 个展开用例。\n\n回归关联只表明存在对应断言，不等于原场景的所有步骤与例子都已完成。\n\n| 编号 | 场景 | 原 Gherkin 直接通过/总例子 | 回归关联 |\n| --- | --- | --- | --- |\n${table}\n`);
console.log(JSON.stringify(report.totals, null, 2));
