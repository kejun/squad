import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gherkin-gate-')); directories.push(directory);
  for (const name of ['features', 'test-results', 'tests/bdd']) mkdirSync(join(directory, name), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'features/test.feature'), '# language: zh-CN\n功能: 门禁\n  @BT_Z01\n  场景: 新场景\n    假如 尚未绑定的前置条件\n    当 新事件发生\n    那么 产生可观察结果\n');
  writeFileSync(join(directory, 'features/acceptance-gaps.json'), '{}');
  writeFileSync(join(directory, 'tests/bdd/empty.ts'), 'export {};');
  writeFileSync(join(directory, 'tests/bdd/tsconfig.json'), '{}');
  writeFileSync(join(directory, 'test-results/vitest.json'), JSON.stringify({ numTotalTests: 1, numPassedTests: 1, testResults: [{ assertionResults: [{ status: 'passed', fullName: '[BT_Z01] fixture' }] }] }));
  writeFileSync(join(directory, 'test-results/cucumber.json'), JSON.stringify([{ elements: [{ type: 'scenario', tags: [{ name: '@BT_Z01' }], steps: [{ result: { status: 'passed' } }] }] }]));
  return directory;
}
function run(directory: string, script = 'scripts/spec-coverage.ts') {
  return spawnSync(process.execPath, ['--import', 'tsx', join(root, script)], { cwd: directory, encoding: 'utf8', timeout: 15000 });
}
describe('Gherkin acceptance gate', () => {
  it('discovers a newly added unbound scenario without an allowlist and fails execution', () => {
    const result = run(fixture(), 'scripts/run-bdd.mjs');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('undefined');
  });
  it('rejects missing direct executions even when a regression is linked', () => {
    const directory = fixture(); writeFileSync(join(directory, 'test-results/cucumber.json'), '[]');
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Automatable Gherkin case was skipped: BT_Z01');
  });
  it('rejects duplicate scenario identities', () => {
    const directory = fixture(); const source = readFileSync(join(directory, 'features/test.feature'), 'utf8');
    writeFileSync(join(directory, 'features/duplicate.feature'), source);
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Duplicate scenario identity: BT_Z01');
  });
  it('rejects an exclusion tag absent from the explicit scenario registry', () => {
    const directory = fixture(); const path = join(directory, 'features/test.feature');
    writeFileSync(path, readFileSync(path, 'utf8').replace('@BT_Z01', '@BT_Z01 @manual_browser'));
    writeFileSync(join(directory, 'features/acceptance-gaps.json'), JSON.stringify({ manual_browser: { reason: 'fixture', ids: ['BT_Z02'] } }));
    const result = run(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Acceptance gap registration/tag mismatch: BT_Z01');
  });
  it('counts actual feature files and directly executed examples', () => {
    const directory = fixture(); const result = run(directory);
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(join(directory, 'reports/spec-coverage.json'), 'utf8'));
    expect(report.totals).toMatchObject({ features: 1, definitions: 1, cases: 1, directlyExecutedGherkinCasesPassed: 1, deferredCases: 0 });
  });
});
