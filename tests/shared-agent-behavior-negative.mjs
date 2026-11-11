/** Three production-source faults in an isolated copy; only the HTTP business assertion counts as detection. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { captureSource } from '../.agents/skills/verify-squad/scripts/build-proof.mjs';

const root = process.cwd();
const evidence = resolve(process.argv[2] ?? join('reports/shared-agent-behavior-negative', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
assert(!existsSync(evidence), 'Retain earlier failed or successful evidence rather than overwriting it'); mkdirSync(evidence, { recursive: true });
mkdirSync(join(root, 'work'), { recursive: true });
const scratch = mkdtempSync(join(root, 'work/shared-behavior-negative-'));
const runtimeRoot = join(scratch, 'owned-runtime'); mkdirSync(runtimeRoot);
const before = captureSource(root), sha = value => createHash('sha256').update(value).digest('hex');
const env = { ...process.env, TMPDIR: runtimeRoot, TSX_DISABLE_CACHE: '1' }; delete env.MODEL_API_KEY;
const normal = "        sharedAgentBehavior,\n        work.kind === 'interpretation'";
const checker = '      sharedAgentBehavior,\n      materials.delta';
const request = '      const requestMessages = observations.length ? [messages[0]!, ...observations, ...messages.slice(1)] : messages;';
const cases = [
  { id: 'ordinary-work-loses-shared-policy', role: 'owner', mode: 'normal', from: normal, to: "        '',\n        work.kind === 'interpretation'" },
  { id: 'fixed-check-loses-shared-policy', role: 'check', mode: 'normal', from: checker, to: "      '',\n      materials.delta" },
  { id: 'follow-up-loses-shared-policy', role: 'owner', mode: 'repair', from: request,
    to: request + "\n      if (turn > 0) requestMessages[0] = { ...requestMessages[0]!, content: requestMessages[0]!.content.replace(sharedAgentBehavior, '') };" },
];
const report = { status: 'running', source: before, cases: [], processes: [], cleanup: { scratchRemoved: false, mainSourceUnchanged: false } };
function run(control, label, folder, expectedSource) {
  const path = join(folder, label + '.json');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/shared-agent-behavior-negative-driver.mjs', control.role, control.mode, path, runtimeRoot], {
    cwd: scratch, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(join(folder, label + '.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.error, undefined, 'Timeout or external process failure is not behavioral detection');
  assert.equal(result.signal, null, 'A killed process is not behavioral detection');
  assert(existsSync(path), 'The actual HTTP fixture and independent cleanup observer must finish');
  const proof = JSON.parse(readFileSync(path, 'utf8'));
  assert(Object.values(proof.cleanup).every(value => value === true), 'Every owned HTTP server, connection and fixture directory must be cleaned');
  assert.equal(proof.loadedSourceSha256, sha(expectedSource), 'The child must actually load the selected production-source bytes');
  report.processes.push({ control: control.id, phase: label, exitCode: result.status, signal: result.signal,
    sourceSha256: proof.loadedSourceSha256, cleanup: proof.cleanup, naturalExit: true });
  return { result, proof };
}
try {
  for (const path of ['src', 'tests', 'scripts', 'team.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json'])
    cpSync(join(root, path), join(scratch, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const sourcePath = join(scratch, 'src/model-adapter.ts');
  for (const control of cases) {
    const folder = join(evidence, control.id); mkdirSync(folder);
    const original = readFileSync(sourcePath, 'utf8');
    const baseline = run(control, 'baseline', folder, original);
    assert.equal(baseline.result.status, 0, 'The unmodified HTTP fixture must pass before fault injection');
    assert.equal(original.split(control.from).length - 1, 1, `Production mutation anchor drift: ${control.id}`);
    const mutated = original.replace(control.from, control.to); assert.notEqual(mutated, original);
    writeFileSync(join(folder, 'original-source.ts'), original); writeFileSync(join(folder, 'mutant-source.ts'), mutated);
    writeFileSync(join(folder, 'mutation.json'), JSON.stringify({ file: 'src/model-adapter.ts', from: control.from, to: control.to,
      replacementCount: 1, originalSha256: sha(original), mutantSha256: sha(mutated) }, null, 2));
    writeFileSync(sourcePath, mutated);
    let mutant;
    try { mutant = run(control, 'mutant', folder, mutated); }
    finally { writeFileSync(sourcePath, original); }
    assert.equal(mutant.result.status, 1, 'The selected prompt-delivery business assertion must fail normally');
    assert.equal(mutant.proof.error?.name, 'AssertionError');
    assert.match(mutant.proof.error?.message ?? '', /SharedBehaviorPromptCopies|SharedBehaviorPromptBody/,
      'Import, fixture protocol, hash and unrelated assertion failures cannot count as detection');
    const restored = run(control, 'restored', folder, original);
    assert.equal(restored.result.status, 0, 'The complete original HTTP fixture must recover after removing the fault');
    report.cases.push({ id: control.id, role: control.role, mode: control.mode, baseline: 'verified',
      mutant: 'detected by actual HTTP shared-policy assertion', restored: 'verified', originalSha256: sha(original), mutantSha256: sha(mutated) });
  }
  assert.deepEqual(captureSource(root), before, 'Isolated source faults may not alter the main checkout or HEAD');
  report.cleanup.mainSourceUnchanged = true; report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  rmSync(scratch, { recursive: true, force: true }); report.cleanup.scratchRemoved = !existsSync(scratch);
  if (!report.cleanup.scratchRemoved) { report.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, childProcesses: report.processes.length, evidence, cleanup: report.cleanup, error: report.error }));
}
