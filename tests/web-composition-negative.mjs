import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSource } from '../.agents/skills/verify-squad/scripts/build-proof.mjs';

const root = process.cwd();
const evidence = resolve(process.argv[2] ?? join(root, 'reports/verify-web-composition-negative', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
assert(!existsSync(evidence)); mkdirSync(evidence, { recursive: true });
const parent = mkdtempSync(join(tmpdir(), 'squad-composition-negative-')), checkout = join(parent, 'checkout');
const before = captureSource(root);
const report = { status: 'running', source: before, evidence, mutations: [], restored: [], cleanup: false };
const env = { ...process.env, MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'controlled-import', MODEL_NO_AUTH: 'true' };
delete env.MODEL_API_KEY;
function run(name, args) {
  const result = spawnSync(process.execPath, args, { cwd: checkout, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 12 * 1024 * 1024 });
  writeFileSync(join(evidence, name + '.stdout'), result.stdout ?? ''); writeFileSync(join(evidence, name + '.stderr'), result.stderr ?? '');
  assert(!result.error, String(result.error)); assert.equal(result.signal, null, name + ' must complete rather than time out');
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
function build(name) { const result = run(name, ['scripts/build.mjs']); assert.equal(result.status, 0, result.output); }
const driver = (name, scenario, variant) => run(name, ['.agents/skills/verify-squad/scripts/composition.mjs', '--case', scenario, '--variant', variant, '--evidence', join(evidence, name)]);
function replaceOnce(body, from, to) { assert.equal(body.split(from).length, 2, 'Mutation must name one exact production decision'); return body.replace(from, to); }
function broken(name, file, mutate, probe, marker, needsBuild = true) {
  const path = join(checkout, file), original = readFileSync(path, 'utf8'), changed = mutate(original);
  writeFileSync(path, changed);
  writeFileSync(join(evidence, name + '.mutation.json'), JSON.stringify({ file, original, changed }, null, 2));
  try {
    if (needsBuild) build(name + '-build');
    const result = probe();
    assert.notEqual(result.status, 0, name + ' must be caught by the original behavioral probe');
    assert(result.output.includes(marker), name + ' must fail the intended behavior: ' + result.output);
    report.mutations.push({ name, file, marker, status: result.status });
  } finally { writeFileSync(path, original); }
}
try {
  execFileSync('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], { cwd: root, stdio: 'pipe' });
  for (const path of ['src', 'web', 'scripts', 'team.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', '.agents/skills/verify-squad/scripts']) cpSync(join(root, path), join(checkout, path), { recursive: true });
  cpSync(join(root, 'tests/inspector-generation-fixture.ts'), join(checkout, 'tests/inspector-generation-fixture.ts'));
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  broken('clear-all-room-identities', 'web/src/App.tsx', body => replaceOnce(body, '      delete sendIdentities.current[targetRoom];', '      sendIdentities.current = {};'),
    () => driver('clear-all-room-identities', 'BT_U20', '普通'), 'CrossRoomRetryIdentity');
  broken('drop-old-snapshot-isolation', 'web/src/api.ts', body => replaceOnce(replaceOnce(replaceOnce(body,
    '        if (controller.signal.aborted || activeRoom.current !== roomId) return;', '        if (false) return;'),
    '        if (!merged || activeRoom.current !== roomId) return;', '        if (!merged) return;'),
    '      controller.abort();\n      clearTimeout(timer);', '      clearTimeout(timer);'),
  () => driver('drop-old-snapshot-isolation', 'BT_U21', '成功'), 'CurrentRoomIsolation');
  broken('report-obsolete-loader-failure', 'web/src/inspector-window.ts', body => replaceOnce(body,
    '    }).catch(cause => { if (token === generation) failed(cause); });', '    }).catch(cause => { failed(cause); });'),
  () => run('report-obsolete-loader-failure', ['--import', 'tsx', 'tests/inspector-generation-fixture.ts']), 'StaleGenerationFeedback', false);
  build('restored-build');
  for (const [scenario, variants] of [['BT_U20', ['普通', '来源引用']], ['BT_U21', ['成功', '失败']]]) for (const variant of variants) {
    const name = 'restored-' + scenario + '-' + variant;
    const result = driver(name, scenario, variant); assert.equal(result.status, 0, result.output);
    report.restored.push({ scenario, variant });
  }
  const inspector = run('restored-inspector', ['--import', 'tsx', 'tests/inspector-generation-fixture.ts']);
  assert.equal(inspector.status, 0, inspector.output); report.restored.push({ scenario: 'BT_V41', cases: 4 });
  assert.deepEqual(captureSource(root), before, 'Negative controls must not change production source in the user checkout');
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  try {
    if (existsSync(checkout)) execFileSync('git', ['worktree', 'remove', '--force', checkout], { cwd: root, stdio: 'pipe' });
    rmSync(parent, { recursive: true, force: true }); report.cleanup = !existsSync(parent);
  } catch (error) { report.status = 'failed'; report.cleanupError = error.stack; process.exitCode = 1; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, evidence, mutations: report.mutations, restored: report.restored, error: report.error }));
}
