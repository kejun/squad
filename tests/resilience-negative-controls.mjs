/** Targeted production-source mutations in a disposable copy; assertion failures only count as detection. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(), scratch = mkdtempSync(join(tmpdir(), 'squad-resilience-controls-'));
const evidence = resolve(process.env.SQUAD_CONTROL_EVIDENCE ?? 'reports/kej-113-114/negative-controls');
mkdirSync(evidence, { recursive: true });
const sha = text => createHash('sha256').update(text).digest('hex');
function replaceOnce(text, old, changed) { assert.equal(text.split(old).length - 1, 1, 'Mutation anchor must be unique'); return text.replace(old, changed); }
function replaceFunction(text, name, next, replacement) {
  const start = text.indexOf(`export function ${name}(`), end = text.indexOf(`\nexport function ${next}(`, start);
  assert(start >= 0 && end > start, 'Mutation function boundaries missing'); return text.slice(0, start) + replacement + '\n' + text.slice(end);
}
const controls = [
  { id: 'deadline-without-freeze', file: 'src/task/resilience.ts', args: ['tests/task-resilience-model-fixture.ts'],
    mutate: text => replaceOnce(text, "if (decision === 'freeze' || decision === 'stopped')", "if (decision === 'stopped')") },
  { id: 'resource-fact-without-proof', file: 'src/resource-acquisition.ts', args: ['tests/execution-receipts-model-fixture.ts'],
    mutate: text => replaceFunction(text, 'missingResourceAcquisitions', 'resourceAcquisitionProblem', 'export function missingResourceAcquisitions(_c, _work) { return []; }') },
  { id: 'deleted-room-resurrection', file: 'src/store.ts',
    args: ['--input-type=module', '-e', "import('./tests/room-deletion-acceptance.ts').then(m=>m.deletionStoreAcceptance('SQLite'))"],
    mutate: text => { const old = 'else assertBarrier(deletion, roomId);'; assert.equal(text.split(old).length - 1, 2); return text.replaceAll(old, 'else { /* mutation: bypass tombstone */ }'); } },
  { id: 'conflicting-resource-concurrency', file: 'src/local-resource-policy.ts',
    args: ['--input-type=module', '-e', "import('./tests/local-resource-policy-acceptance.ts').then(m=>m.resourceLeaseStoreAcceptance(true))"],
    mutate: text => replaceOnce(text, 'return resourceLeaseBlockerOwners(rows, requests, owner, legacyRows).length === 0;', 'return true;') },
  { id: 'guardian-does-not-restart', file: 'src/process-supervisor.machine.ts', args: ['tests/process-supervisor-model-gate.ts'],
    mutate: text => { const old = "EXIT: { guard: 'current', target: 'restarting', actions: 'retry' }"; assert(text.includes(old)); return text.replaceAll(old, "EXIT: { guard: 'current', target: 'stopped', actions: 'retry' }"); } },
  { id: 'delete-while-physical-preparation-is-running', file: 'src/runtime-ownership.ts',
    args: ['--input-type=module', '-e', "import('./tests/room-deletion-acceptance.ts').then(m=>m.deletionPhysicalPreparationAcceptance())"],
    mutate: text => replaceOnce(text, 'if (!input.quiescent)', 'if (false)') },
  { id: 'delete-with-prepared-workspace-cache-retained', file: 'src/local-runtime.ts',
    args: ['--input-type=module', '-e', "import('./tests/room-deletion-acceptance.ts').then(m=>m.deletionRuntimeProjectionAcceptance())"],
    mutate: text => replaceOnce(text, 'this.retireWorkspaceCache(claim.asset);', '/* mutation: omit prepared workspace projection retirement */') },
];
const env = { ...process.env }; delete env.MODEL_API_KEY;
const results = [];
try {
  for (const path of ['src', 'tests', 'scripts', 'web', 'team.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json'])
    cpSync(join(root, path), join(scratch, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const execute = args => spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000 });
  for (const control of controls) {
    const folder = join(evidence, control.id); mkdirSync(folder, { recursive: true });
    const path = join(scratch, control.file), original = readFileSync(path, 'utf8');
    const baseline = execute(control.args); writeFileSync(join(folder, 'baseline.log'), `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`);
    assert.equal(baseline.status, 0, `Baseline failed for ${control.id}: ${baseline.stderr}`);
    const changed = control.mutate(original); assert.notEqual(changed, original);
    writeFileSync(path, changed);
    let mutant;
    try { mutant = execute(control.args); }
    finally { writeFileSync(path, original); }
    const output = `${mutant.stdout ?? ''}${mutant.stderr ?? ''}`;
    writeFileSync(join(folder, 'mutant.log'), output);
    assert.notEqual(mutant.status, 0, `${control.id} escaped its behavior oracle`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${control.id} failed without the intended behavioral assertion`);
    assert.equal(mutant.error, undefined, `${control.id} terminated for timeout/environment instead of contract failure`);
    writeFileSync(join(folder, 'mutation.json'), JSON.stringify({ file: control.file, originalSha256: sha(original), mutatedSha256: sha(changed), original, changed }, null, 2));
    const restored = execute(control.args); writeFileSync(join(folder, 'restored.log'), `${restored.stdout ?? ''}${restored.stderr ?? ''}`);
    assert.equal(restored.status, 0, `${control.id} original did not recover after mutation removal`);
    results.push({ id: control.id, baseline: 'passed', detectedBy: 'behavioral assertion', mutantExit: mutant.status, restored: 'passed',
      file: control.file, originalSha256: sha(original), mutantLogSha256: sha(output) });
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ status: 'passed', controls: results, scope: 'Seven targeted source faults; no mutation score or exhaustive guarantee', scratchRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', controls: results.length, evidence }));
} finally { rmSync(scratch, { recursive: true, force: true }); assert(!existsSync(scratch)); }
