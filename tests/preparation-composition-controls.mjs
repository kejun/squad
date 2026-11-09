import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const evidence = resolve(process.argv[2] ?? 'reports/kej-108-preparation');
const hashes = () => Object.fromEntries(['src/local-skills.ts', 'src/local-runtime.ts'].map(file => [file,
  createHash('sha256').update(readFileSync(file)).digest('hex')]));
const baseline = hashes(); const controls = [];
for (const [fault, scenario, expected] of [
  ['skip-existing-permissions', '技能发布后进程丢失', 'Published skill directory must be read-only'],
  ['skip-scratch-reentry', '副本标记后进程丢失', 'PREPARATION_INCOMPLETE'],
  ['skip-check-output-preparation', '检查副本标记后进程丢失', 'PREPARATION_INCOMPLETE'],
]) {
  for (const mutation of [true, false]) {
    const label = `${fault}-${mutation ? 'negative' : 'restored'}`;
    const area = join(evidence, label); mkdirSync(area, { recursive: true });
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'tests/preparation-composition-fixture.ts', scenario], {
      encoding: 'utf8', timeout: 45000, env: { ...process.env, PREPARATION_EVIDENCE: area, PREPARATION_MUTATION: mutation ? fault : '' },
    });
    writeFileSync(join(area, 'run.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
    assert.equal(run.error, undefined, `Controlled verification process did not finish: ${label}`);
    const proof = JSON.parse(readFileSync(join(area, `${scenario}.json`), 'utf8'));
    assert.equal(proof.cleanup, true); assert.equal(proof.runs[0].signal, 'SIGKILL');
    if (mutation) {
      assert.notEqual(run.status, 0, 'A source fault must make the public-interface property fail');
      assert.equal(proof.status, 'failed'); assert(proof.failure.includes(expected), proof.failure);
      if (fault === 'skip-check-output-preparation') {
        for (const name of ['dist', 'test-results', 'reports', 'coverage']) assert(proof.failure.includes(name), 'The check output directories must be the missing resources');
      }
      const changes = proof.runs.flatMap(item => item.messages).filter(message => message.type === 'mutation' && message.fault === fault);
      assert(changes.length >= 2, 'Both the killed host and the fresh host must load the isolated source mutation');
      assert(changes.every(change => change.originalHash !== change.mutatedHash));
    } else { assert.equal(run.status, 0, `${label}: ${run.stderr}`); assert.equal(proof.status, 'passed'); }
    assert.deepEqual(hashes(), baseline, 'Source controls must not change product files');
    controls.push({ label, status: mutation ? 'detected' : 'passed', exitCode: run.status, proof: join(area, `${scenario}.json`) });
  }
}
const result = { status: 'passed', scope: 'Real source mutations loaded only in child hosts; unchanged files and restoration reruns', sourceHashes: baseline, controls };
writeFileSync(join(evidence, 'controls.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: 'passed', controls: controls.length, evidence }));
