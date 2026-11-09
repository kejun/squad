#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Mutations live only in an owned detached worktree. The acceptance assertions
// and controlled provider remain unchanged in every counterexample.
const root = process.cwd();
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const evidence = resolve('reports/verify-squad-negative', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
mkdirSync(evidence, { recursive: true });
mkdirSync('work', { recursive: true });
const directory = mkdtempSync(resolve('work/browser-negative-'));
const env = { ...process.env, TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json' };
delete env.MODEL_API_KEY;
const cases = [
  { name: 'active-placeholder', tag: 'BT_U01', file: 'web/src/App.tsx', from: '"补充当前工作…"', to: '"开始新任务…"', detects: 'Timed out: active task input placeholder' },
  { name: 'midflight-input', tag: 'BT_U01', file: 'web/src/App.tsx', from: 'disabled={!connected || sending}', to: 'disabled={!connected || sending || !!task}', detects: 'not enabled' },
  { name: 'replace-status-row', tag: 'BT_U02', file: 'web/src/App.tsx', from: '<div className="task-status-row">', to: '<div className="task-status-row" key={latestTask.phase}>', detects: 'must update the original DOM status row' },
  { name: 'status-message-leak', tag: 'BT_U02', file: 'web/src/App.tsx', from: '{messages.map((message: Message) => {', to: '<article className="message">状态更新：正在执行</article>{messages.map((message: Message) => {', detects: 'Timeline contains exactly the persisted actual messages' },
  { name: 'raw-tool-open', tag: 'BT_U02', file: 'web/src/Details.tsx', from: '<Collapsible.Root\n                                  className={`execution-event', to: '<Collapsible.Root defaultOpen\n                                  className={`execution-event', detects: 'Raw tool details start collapsed' },
  { name: 'wrong-artifact-source', tag: 'BT_U03', file: 'web/src/Details.tsx', from: 'onOpen({ taskId: source.sourceTaskId, artifactId: source.artifactId })', to: 'onOpen({ taskId: source.sourceTaskId + ":missing", artifactId: source.artifactId })', detects: 'name: \'验证报告\'' },
  { name: 'offline-working-spinner', tag: 'BT_U09', file: 'web/src/App.tsx', from: 'working && connected', to: 'working', all: true, detects: 'Offline host cannot be presented as executing' },
  { name: 'new-id-on-retry', tag: 'BT_U09', file: 'web/src/App.tsx', from: 'const id = identity?.roomId === targetRoom && identity.payload === serialized ? identity.id : crypto.randomUUID();', to: 'const id = crypto.randomUUID();', detects: 'Retry keeps the original request identity' },
];
const selected = process.argv[2] ? cases.filter(test => test.name === process.argv[2]) : cases;
assert(selected.length, 'Unknown mutation name');
const report = { source, evidence, results: [], cleanup: false };
function command(program, args, path, log, timeout = 180_000) {
  const result = spawnSync(program, args, { cwd: path, env, encoding: 'utf8', timeout, maxBuffer: 20_000_000 });
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? String(result.error) : ''));
  return result;
}
try {
  const added = spawnSync('git', ['worktree', 'add', '--detach', directory, source], { encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  for (const test of selected) {
    const folder = join(evidence, test.name);
    mkdirSync(folder);
    const path = join(directory, test.file);
    const original = readFileSync(path, 'utf8');
    const matches = original.split(test.from).length - 1;
    assert(test.all ? matches > 0 : matches === 1, `Mutation anchor drift: ${test.name} (${matches})`);
    const mutated = test.all ? original.replaceAll(test.from, test.to) : original.replace(test.from, test.to);
    writeFileSync(path, mutated);
    const build = command(process.execPath, ['scripts/build.mjs'], directory, join(folder, 'build.log'));
    assert.equal(build.status, 0, `Mutation ${test.name} must build; failures must be behavioral`);
    const result = command(process.execPath, ['--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js', 'features', '--import', 'tests/bdd/*.ts', '--tags', `@${test.tag}`, '--format', 'progress', '--format', `json:${join(folder, 'cucumber.json')}`], directory, join(folder, 'failure.log'));
    const output = readFileSync(join(folder, 'failure.log'), 'utf8');
    assert.notEqual(result.status, 0, `Mutation survived: ${test.name}`);
    assert(output.includes(test.detects), `Mutation ${test.name} failed without the intended business assertion: ${test.detects}`);
    if (existsSync(join(directory, 'reports/verify-squad'))) {
      cpSync(join(directory, 'reports/verify-squad'), join(folder, 'browser'), { recursive: true });
      rmSync(join(directory, 'reports/verify-squad'), { recursive: true });
    }
    report.results.push({ mutation: test.name, scenario: test.tag, file: test.file, mutatedSha256: createHash('sha256').update(mutated).digest('hex'), exitCode: result.status, signal: result.signal, detectedBy: test.detects });
    writeFileSync(path, original);
    console.log(`Killed ${test.name} with ${test.tag}: ${test.detects}`);
  }
  const restored = command(process.execPath, ['scripts/build.mjs'], directory, join(evidence, 'restored-build.log'));
  assert.equal(restored.status, 0);
  const positive = command(process.execPath, ['--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js', 'features', '--import', 'tests/bdd/*.ts', '--tags', '@BT_U01 or @BT_U02 or @BT_U03 or @BT_U09', '--format', 'progress', '--format', `json:${join(evidence, 'restored-cucumber.json')}`], directory, join(evidence, 'restored.log'));
  assert.equal(positive.status, 0, readFileSync(join(evidence, 'restored.log'), 'utf8'));
  cpSync(join(directory, 'reports/verify-squad'), join(evidence, 'restored-browser'), { recursive: true });
  report.restored = '4 original browser contracts passed';
} finally {
  const removed = spawnSync('git', ['worktree', 'remove', '--force', directory], { encoding: 'utf8' });
  report.cleanup = removed.status === 0 && !existsSync(directory);
  writeFileSync(join(evidence, 'negative.json'), JSON.stringify(report, null, 2));
  assert(report.cleanup, 'Owned mutation worktree must be removed');
}
console.log(JSON.stringify(report, null, 2));
