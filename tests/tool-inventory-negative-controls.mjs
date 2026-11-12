/** Two targeted source faults checked by unchanged public acceptance functions. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = process.cwd();
const evidence = resolve(process.argv[2] ?? process.env.SQUAD_TOOL_INVENTORY_CONTROL_EVIDENCE
  ?? join('reports', 'tool-inventory-negative-controls', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`));
assert(!existsSync(evidence), 'Evidence output must be new and owned by this run');
mkdirSync(evidence, { recursive: true });
const sha = text => createHash('sha256').update(text).digest('hex');
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
function fingerprints(directory) {
  return Object.fromEntries(sourceFiles(join(directory, 'src')).sort()
    .map(path => [relative(directory, path), sha(readFileSync(path))]));
}
function replaceOnce(text, original, changed) {
  assert.equal(text.split(original).length - 1, 1, 'Mutation must name exactly one expression');
  return text.replace(original, changed);
}
const controls = [
  { id: 'truncate-complete-skill-inventory', scenario: 'BT_Y121', file: 'src/local-skills.ts',
    entry: "await import('./tests/unified-tool-context-acceptance.ts').then(m => m.completeToolInventoryAcceptance());",
    marker: '20 !== 28', oracle: 'completeToolInventoryAcceptance',
    mutate: text => replaceOnce(text,
      'skills: this.entries.map(({ root: _root, files: _files, ...metadata }) => structuredClone(metadata)),',
      'skills: this.entries.slice(0, 20).map(({ root: _root, files: _files, ...metadata }) => structuredClone(metadata)),') },
  { id: 'ignore-selected-entry-change', scenario: 'BT_Y124', file: 'src/model-tool-inventory.ts',
    entry: "await import('./tests/unified-tool-context-acceptance.ts').then(m => m.inventorySelectionChangeAcceptance('模型决策返回前', '选中条目元信息变化'));",
    marker: 'Changed tool metadata must not create a local operation or approval', oracle: 'inventorySelectionChangeAcceptance',
    mutate: text => replaceOnce(text,
      'return !!original && !!current && original.entryVersion !== current.cli.entries.find(entry => entry.command === executable)?.entryVersion;',
      'return false;') },
];
const before = fingerprints(root);
const scratch = mkdtempSync(join(tmpdir(), 'squad-tool-inventory-controls-'));
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
const env = { ...process.env, NODE_DISABLE_COLORS: '1' }; delete env.MODEL_API_KEY;
const report = { status: 'running', controls: [], source: before, sourceUnchanged: false, cleanup: false,
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  workingTreeDirty: status.status === 0 ? status.stdout.length > 0 : null,
  scope: 'Two targeted production faults; controlled model transport, no model-accuracy or exhaustive mutation claim' };
function run(folder, phase, entry) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', entry],
    { cwd: scratch, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(folder, `${phase}.log`), output);
  assert.equal(result.error, undefined, `${phase} must not fail from timeout or environment`);
  assert.equal(result.signal, null, `${phase} must exit normally`);
  return { status: result.status, output };
}
try {
  for (const path of ['src', 'tests', 'scripts', 'web', 'features', 'team.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
    cpSync(join(root, path), join(scratch, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  assert.deepEqual(fingerprints(scratch), before, 'The complete current production tree must enter the owned copy');
  for (const control of controls) {
    const folder = join(evidence, control.id); mkdirSync(folder);
    const path = join(scratch, control.file), original = readFileSync(path, 'utf8');
    const acceptance = join(scratch, 'tests/unified-tool-context-acceptance.ts');
    const oracleHash = sha(readFileSync(acceptance));
    const baseline = run(folder, 'baseline', control.entry);
    assert.equal(baseline.status, 0, `${control.id} baseline must pass: ${baseline.output}`);
    const changed = control.mutate(original);
    assert.notEqual(changed, original, 'The production fault must be applied');
    writeFileSync(path, changed);
    let mutant;
    try { mutant = run(folder, 'mutant', control.entry); }
    finally { writeFileSync(path, original); }
    assert.equal(mutant.status, 1, `${control.id} must exit 1 at the original business assertion`);
    assert.match(mutant.output, /AssertionError \[ERR_ASSERTION\]/, `${control.id} needs an assertion counterexample`);
    assert(mutant.output.includes(control.marker), `${control.id} missed its precise business marker: ${mutant.output}`);
    assert(mutant.output.includes(control.oracle), `${control.id} must fail in its unchanged acceptance function`);
    assert(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|Cannot find module|timed out|Timed out/.test(mutant.output),
      `${control.id} cannot count import, environment or timeout failures as detection`);
    assert.equal(sha(readFileSync(acceptance)), oracleHash, 'The acceptance oracle must remain unchanged');
    const restored = run(folder, 'restored', control.entry);
    assert.equal(restored.status, 0, `${control.id} must pass after restoring production source: ${restored.output}`);
    assert.deepEqual(fingerprints(scratch), before, 'The complete owned production tree must be restored');
    writeFileSync(join(folder, 'mutation.json'), JSON.stringify({ file: control.file, originalSha256: sha(original),
      mutatedSha256: sha(changed), acceptanceSha256: oracleHash, original, changed }, null, 2));
    report.controls.push({ id: control.id, scenario: control.scenario, baseline: 'passed', mutantExit: mutant.status,
      detectedBy: { assertion: control.marker, acceptance: control.oracle }, restored: 'passed' });
  }
  assert.deepEqual(fingerprints(root), before, 'Negative controls must not change the user checkout production tree');
  report.sourceUnchanged = true; report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  report.cleanup = !existsSync(scratch);
  assert(report.cleanup, 'The owned mutation copy must be removed');
  report.sourceUnchanged = JSON.stringify(fingerprints(root)) === JSON.stringify(before);
  if (!report.sourceUnchanged) { report.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, controls: report.controls, sourceUnchanged: report.sourceUnchanged,
    cleanup: report.cleanup, evidence, ...(report.error ? { error: report.error } : {}) }));
}
