import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';

interface Gap { reason: string; ids: string[] }
interface Row { id: string; file: string; name: string; cases: number; passedGherkinCases: number; regressionTests: string[]; deferred: { tag: string; reason: string } | null }
const gaps = JSON.parse(readFileSync('features/acceptance-gaps.json', 'utf8')) as Record<string, Gap>;
const expectedGaps = new Map<string, string>();
for (const [tag, gap] of Object.entries(gaps)) {
  if (!gap.reason?.trim() || !Array.isArray(gap.ids) || !gap.ids.length) throw new Error(`Invalid acceptance gap: ${tag}`);
  for (const id of gap.ids) { if (expectedGaps.has(id)) throw new Error(`Duplicate deferred identity: ${id}`); expectedGaps.set(id, tag); }
}
const identity = (tags: readonly { name: string }[]) => {
  const matches = tags.filter(tag => /^@BT_[A-Z]\d+$/.test(tag.name));
  if (matches.length !== 1) throw new Error('Every scenario must have exactly one @BT_* identity');
  return matches[0]!.name.slice(1);
};
const rows = new Map<string, Row>();
const definitions = new Set<string>();
const files = readdirSync('features').filter(file => file.endsWith('.feature')).sort();
for (const file of files) {
  const messages = generateMessages(readFileSync(`features/${file}`, 'utf8'), file, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, { newId: IdGenerator.incrementing(), includeGherkinDocument: true, includePickles: true, includeSource: false });
  const errors = messages.filter(message => message.parseError);
  if (errors.length) throw new Error(JSON.stringify(errors));
  for (const message of messages) {
    for (const child of message.gherkinDocument?.feature?.children ?? []) {
      const scenarios = child.scenario ? [child.scenario] : child.rule?.children.flatMap(item => item.scenario ? [item.scenario] : []) ?? [];
      for (const scenario of scenarios) { const id = identity(scenario.tags); if (definitions.has(id)) throw new Error(`Duplicate scenario identity: ${id}`); definitions.add(id); }
    }
    const pickle = message.pickle;
    if (!pickle) continue;
    const id = identity(pickle.tags);
    const excluded = pickle.tags.map(tag => tag.name.slice(1)).filter(tag => Object.hasOwn(gaps, tag));
    const expected = expectedGaps.get(id);
    if (excluded.length > 1 || excluded[0] !== expected) throw new Error(`Acceptance gap registration/tag mismatch: ${id}`);
    const row = rows.get(id) ?? { id, file, name: pickle.name, cases: 0, passedGherkinCases: 0, regressionTests: [], deferred: expected ? { tag: expected, reason: gaps[expected]!.reason } : null };
    row.cases++; rows.set(id, row);
  }
}
for (const id of expectedGaps.keys()) if (!rows.has(id)) throw new Error(`Deferred scenario no longer exists: ${id}`);
for (const id of definitions) if (!rows.has(id)) throw new Error(`Scenario has no executable example: ${id}`);
const unit = JSON.parse(readFileSync('test-results/vitest.json', 'utf8')) as { numTotalTests: number; numPassedTests: number; testResults: { assertionResults: { fullName: string; status: string }[] }[] };
if (unit.numTotalTests !== unit.numPassedTests) throw new Error('Regression tests did not all pass');
for (const file of unit.testResults) for (const test of file.assertionResults) {
  if (test.status !== 'passed') continue;
  for (const match of test.fullName.matchAll(/\[(BT_[A-Z]\d+)\]/g)) {
    const row = rows.get(match[1]!);
    if (!row) throw new Error(`Regression links unknown scenario: ${match[1]}`);
    row.regressionTests.push(test.fullName);
  }
}
const bdd = JSON.parse(readFileSync('test-results/cucumber.json', 'utf8')) as { elements: { type: string; tags?: { name: string }[]; steps: { result: { status: string } }[] }[] }[];
let passedBdd = 0;
for (const feature of bdd) for (const scenario of feature.elements) {
  if (scenario.type !== 'scenario') continue;
  if (!scenario.steps.length || !scenario.steps.every(step => step.result.status === 'passed')) throw new Error('Gherkin scenario did not pass');
  const id = identity(scenario.tags ?? []);
  const row = rows.get(id);
  if (!row || row.deferred) throw new Error(`Unexpected Gherkin execution: ${id}`);
  row.passedGherkinCases++; passedBdd++;
  if (row.passedGherkinCases > row.cases) throw new Error(`Duplicate Gherkin execution: ${id}`);
}
const scenarios = [...rows.values()];
for (const row of scenarios) if (!row.deferred && row.passedGherkinCases !== row.cases) throw new Error(`Automatable Gherkin case was skipped: ${row.id}`);
const report = {
  baseline: 'v0.4 plus current implemented features',
  scope: 'XState domain, SQLite group-review recovery, controlled model HTTP and Markdown SSR; deferred integration/browser/cost acceptance is explicit',
  totals: { features: files.length, definitions: scenarios.length, cases: scenarios.reduce((sum, row) => sum + row.cases, 0),
    regressionTestsPassed: unit.numPassedTests, directlyExecutedGherkinCasesPassed: passedBdd,
    fullyExecutedGherkinDefinitions: scenarios.filter(row => row.cases === row.passedGherkinCases).length,
    definitionsWithLinkedRegressionTests: scenarios.filter(row => row.regressionTests.length > 0).length,
    deferredDefinitions: scenarios.filter(row => row.deferred).length,
    deferredCases: scenarios.filter(row => row.deferred).reduce((sum, row) => sum + row.cases, 0) },
  note: 'Regression links are not direct Gherkin execution. Every non-deferred example must pass; deferred requirements keep their original criteria.',
  scenarios,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/spec-coverage.json', JSON.stringify(report, null, 2) + '\n');
const table = scenarios.map(row => `| ${row.id} | ${row.name} | ${row.passedGherkinCases}/${row.cases} | ${row.regressionTests.length} | ${row.deferred ? `待验收：${row.deferred.reason}` : '直接执行通过'} |`).join('\n');
writeFileSync('reports/spec-coverage.md', `# Gherkin 与实现覆盖报告\n\n共有 ${scenarios.length} 个场景定义、${report.totals.cases} 个展开用例。直接执行通过 ${passedBdd} 个，明确待验收 ${report.totals.deferredCases} 个；其余遗漏会令检查失败。另有 ${unit.numPassedTests} 项回归测试通过。\n\n范围：任务内核、群历史与评审、SQLite 评审恢复、受控模型 HTTP 和 Markdown 服务端渲染。完整浏览器交互、费用展示和 Pi Durable 的缺口逐项保留在表中。回归关联不代表场景步骤已执行。\n\n| 编号 | 场景 | Gherkin 通过/用例 | 回归关联数 | 状态与原因 |\n| --- | --- | --- | --- | --- |\n${table}\n`);
console.log(JSON.stringify(report.totals, null, 2));
