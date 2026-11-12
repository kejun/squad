import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = resolve(root, process.argv[2] ?? `reports/cli-input-evidence-negative/${Date.now()}-${process.pid}`);
assert(!existsSync(output), 'Evidence output must be new and owned by this run');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'squad-cli-input-controls-'));
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []);
}
function fingerprints(directory) {
  return Object.fromEntries(sourceFiles(join(directory, 'src')).sort().map(path =>
    [relative(directory, path), createHash('sha256').update(readFileSync(path)).digest('hex')]));
}
const beforeSource = fingerprints(root);
const env = { ...process.env, TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json' }; delete env.MODEL_API_KEY;
const bdd = tags => ['--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js', 'features/69_cli_stdin.feature',
  '--import', 'tests/bdd/cli-stdin.steps.ts', '--tags', tags, '--format', 'summary'];
const model = ['--import', 'tsx', 'tests/cli-input-evidence-model-gate.ts'];
function run(name, args, passed, oracle) {
  const child = spawnSync(process.execPath, args, { cwd: scratch, env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const log = `${child.stdout ?? ''}${child.stderr ?? ''}`; writeFileSync(resolve(output, `${name}.log`), log);
  assert.equal(child.error, undefined, `${name} did not complete normally`);
  assert.equal(child.status, passed ? 0 : 1, `${name} returned an unexpected exit; inspect ${output}`);
  if (!passed) {
    assert(log.includes('AssertionError'), `${name} must fail at a business assertion`);
    assert(log.includes(oracle), `${name} must fail in its unchanged intended business oracle`);
    assert(!/SyntaxError|Cannot find module|ERR_MODULE|timed out|ETIMEDOUT/.test(log), `${name} cannot count setup errors/timeouts as detection`);
  }
  return { status: child.status, log: `${name}.log` };
}
const controls = [
  { name: 'missing-runtime-invocation', file: 'src/local-runtime.ts',
    anchor: 'outputFiles, outputFilesTruncated, validationInputsChanged, invocation, execution:',
    replacement: 'outputFiles, outputFilesTruncated, validationInputsChanged, execution:', args: bdd('@BT_Y151'), oracle: 'CliInputEvidenceAcceptance.assertFixedEvidence' },
  { name: 'unbound-fixed-invocation', file: 'src/task/evidence.ts',
    anchor: 'if (expected && expected.cliSnapshot !== saved.cliSnapshot) return undefined;',
    replacement: '// Negative control: do not bind actual input identity.', args: model, oracle: 'assertChangedInputEvidenceRejected' },
  { name: 'unlimited-identical-input-failures', file: 'src/local-runtime.ts',
    anchor: "if (stdin && repeatedCliFailures(work, action, { ...stdin.plan, environmentHash }) >= 2) throw new LocalToolError('CLI_REPEAT_FAILURE_LIMIT');",
    replacement: '// Negative control: do not limit known repeated input failures.', args: bdd('@BT_Y152'), oracle: 'CliInputEvidenceAcceptance.assertRepeat' },
  { name: 'expanded-fixed-check-stdin', file: 'src/task/verification.ts',
    anchor: ' && action.stdin === undefined;', replacement: ';', args: model, oracle: 'assertFixedCheckRejectsAddedStdin' },
];
const records = [];
const oracleHashes = () => Object.fromEntries(['tests/cli-input-evidence-model-gate.ts', 'tests/cli-input-evidence-model-fixture.ts',
  'tests/cli-input-evidence-acceptance.ts', 'tests/bdd/cli-stdin.steps.ts'].map(path =>
  [path, createHash('sha256').update(readFileSync(resolve(scratch, path))).digest('hex')]));
try {
  for (const path of ['src', 'tests', 'scripts', 'web', 'features', 'team.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
    cpSync(join(root, path), join(scratch, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  assert.deepEqual(fingerprints(scratch), beforeSource);
  const oracles = oracleHashes();
  run('baseline-bdd', bdd('@BT_Y151 or @BT_Y152'), true); run('baseline-model', model, true);
  for (const control of controls) {
    const path = resolve(scratch, control.file), before = readFileSync(path);
    const source = before.toString('utf8'); assert.equal(source.split(control.anchor).length, 2, `Expected one exact anchor for ${control.name}`);
    try {
      writeFileSync(path, source.replace(control.anchor, control.replacement));
      records.push({ name: control.name, oracle: control.oracle, ...run(control.name, control.args, false, control.oracle), restoredSha256: createHash('sha256').update(before).digest('hex') });
      assert.deepEqual(oracleHashes(), oracles, 'Business oracles must remain unchanged');
    } finally { writeFileSync(path, before); assert.deepEqual(readFileSync(path), before, `${control.name} must restore exact source bytes`); }
  }
  run('restored-model', model, true); run('restored-bdd', bdd('@BT_Y145 or @BT_Y146 or @BT_Y147 or @BT_Y148 or @BT_Y151 or @BT_Y152 or @BT_Y153'), true);
  assert.deepEqual(fingerprints(scratch), beforeSource, 'Owned copy must be fully restored');
  assert.deepEqual(fingerprints(root), beforeSource, 'User checkout production source must remain unchanged');
  const report = { status: 'passed', boundary: 'Real persisted taskMachine and actual filesystem/process/model-adapter BDD in an owned copy. No timeout or import-error detection.',
    source: beforeSource, sourceUnchanged: true, oracleHashes: oracles, records };
  writeFileSync(resolve(output, 'controls.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, controls: records.length, sourceUnchanged: true, evidence: output }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
  assert(!existsSync(scratch), 'Owned mutation copy must be removed');
  assert.deepEqual(fingerprints(root), beforeSource, 'User checkout production source must remain unchanged');
}
