import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const evidence = resolve(process.argv[2] ?? 'reports/kej-108-preparation');
const cases = ['技能并发加载', '技能复制变化后重试', '技能发布前进程丢失', '技能发布后进程丢失',
  '副本复制变化后重试', '副本标记前进程丢失', '副本标记后进程丢失', '检查副本标记后进程丢失'];
const records = [];
for (const scenario of cases) {
  const path = join(evidence, `${scenario}.json`); const raw = readFileSync(path); const proof = JSON.parse(raw);
  assert.equal(proof.status, 'passed'); assert.equal(proof.cleanup, true); assert.equal(proof.scenario, scenario);
  for (const [source, hash] of Object.entries(proof.sourceHashes)) assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), hash, `Evidence source drift: ${source}`);
  const crashed = scenario.includes('进程丢失');
  assert.equal(proof.runs.length, crashed ? 2 : 1);
  if (crashed) { assert.equal(proof.runs[0].signal, 'SIGKILL'); assert(proof.runs[0].messages.some(message => message.type === 'barrier')); }
  const final = proof.runs.at(-1); assert.equal(final.code, 0); assert(final.messages.some(message => message.type === 'complete'));
  if (scenario === '检查副本标记后进程丢失') {
    const result = final.messages.find(message => message.type === 'complete').result;
    assert.equal(result.kind, 'check'); assert.equal(result.validationOutputs, 'all four ready before backend');
    assert.equal(result.scratch, 'ready'); assert.equal(result.processSpawned, false);
  }
  records.push({ path, sha256: createHash('sha256').update(raw).digest('hex'), scenario, processLossVerified: crashed });
}
const controls = JSON.parse(readFileSync(join(evidence, 'controls.json'), 'utf8')); assert.equal(controls.status, 'passed'); assert.equal(controls.controls.length, 6);
for (const control of controls.controls) { const proof = JSON.parse(readFileSync(control.proof, 'utf8')); assert.equal(proof.cleanup, true); assert.equal(proof.status, control.status === 'detected' ? 'failed' : 'passed'); }
const report = { status: 'passed', verifier: 'independent evidence readback; no fixture execution', records, controls: controls.controls.length };
writeFileSync(join(evidence, 'readback.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: 'passed', artifacts: records.length + 7, evidence }));
