import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,join } from 'node:path';
const area=resolve(process.argv[2] ?? 'reports/kej-108-model-session');
for(const [name,expected] of [['representative',1],['generated',48]]) {
 const record=JSON.parse(readFileSync(join(area,name+'.json'),'utf8'));
 assert.equal(record.status,'verified');assert.equal(record.sequences,expected);assert.equal(record.results.length,expected);
 assert.equal(new Set(record.results.map(item=>JSON.stringify(item.sequence))).size,expected,'duplicate generated sequences');
 assert.deepEqual(Object.keys(record.sourceHashes).sort(),['src/model-adapter.ts','src/runner.ts','tests/model-session-composition-fixture.ts'].sort());
 for(const [file,hash] of Object.entries(record.sourceHashes))assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),hash,`Source drift:${file}`);
 for(const result of record.results) {
  assert.equal(result.cleanOtherRoom,true);assert.equal(result.repairs,result.sequence.filter(t=>t==='invalid').length);
  for(const token of ['search','fetch','skills'])assert.equal(result.calls[token],result.sequence.filter(t=>t===token).length);
  const local=result.sequence.filter(t=>t==='local').length;
  assert.equal(result.modelRequests,result.sequence.length+local+1,'expanded local pair and final request');
 }
}
const controls=JSON.parse(readFileSync(join(area,'controls/controls.json'),'utf8'));
assert.equal(controls.status,'verified');assert.equal(controls.coveredFileUnchanged,true);
assert.deepEqual(controls.records.map(r=>[r.name,r.exitCode]),[['drop-web-result',1],['drop-web-result-restored',0],['echo-invalid-body',1],['echo-invalid-body-restored',0]]);
for(const [name,expected] of [['drop-web-result','SessionEvidence'],['echo-invalid-body','InvalidBodyIsolation']]) {
 const log=readFileSync(join(area,'controls',name,'process.log'),'utf8');assert(log.includes(expected));
 const proof=JSON.parse(readFileSync(join(area,'controls',name+'.diff'),'utf8'));assert.notEqual(proof.originalHash,proof.mutatedHash);assert(proof.from&&proof.to);
}
const cucumber=JSON.parse(readFileSync(join(area,'cucumber.json'),'utf8'));
let scenarios=0,businessSteps=0;for(const feature of cucumber)for(const scenario of feature.elements ?? []) { scenarios++;for(const step of scenario.steps ?? []) { assert.equal(step.result.status,'passed'); if (typeof step.name === 'string') businessSteps++; } }
assert.equal(scenarios,10,'complete adapter feature expected');
console.log(JSON.stringify({status:'verified',sequences:49,controls:4,scenarios,businessSteps}));
