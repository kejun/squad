import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve,join } from 'node:path';
import { generateMessages } from '@cucumber/gherkin';
import { IdGenerator, SourceMediaType } from '@cucumber/messages';
const [evidenceArg='reports/kej-108-model-session',cucumberArg,...unexpected]=process.argv.slice(2);
assert.equal(unexpected.length,0,'Usage: node tests/model-session-composition-readback.mjs [evidence-directory] [cucumber-report]');
const area=resolve(evidenceArg), cucumberPath=resolve(cucumberArg ?? join(area,'cucumber.json'));
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
const cucumberRaw=readFileSync(cucumberPath,'utf8'), cucumber=JSON.parse(cucumberRaw);
const featurePath='features/38_adapter_composition.feature';
const features=cucumber.filter(feature=>feature.uri?.replaceAll('\\','/').match(/(?:^|\/)features\/38_adapter_composition\.feature$/));
assert.equal(features.length,1,'report must contain the adapter feature exactly once');
const messages=generateMessages(readFileSync(featurePath,'utf8'),featurePath,SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
 {newId:IdGenerator.incrementing(),includeGherkinDocument:false,includePickles:true,includeSource:false});
assert(!messages.some(message=>message.parseError),'adapter feature must parse');
const expected=messages.flatMap(message=>message.pickle ? [message.pickle] : []);
const actual=features[0].elements.filter(scenario=>scenario.type==='scenario');
const signature=(name,tags,steps)=>JSON.stringify({name,tags:tags.map(tag=>tag.name).filter(name=>/^@BT_[A-Z]\d+$/.test(name)).sort(),steps});
const business=scenario=>scenario.steps.filter(step=>!step.hidden && typeof step.name==='string');
assert.deepEqual(actual.map(scenario=>signature(scenario.name,scenario.tags,business(scenario).map(step=>step.name))).sort(),
 expected.map(pickle=>signature(pickle.name,pickle.tags,pickle.steps.map(step=>step.text))).sort(),'report must contain every expanded adapter scenario exactly once');
let businessSteps=0;
for(const scenario of actual)for(const step of scenario.steps) {
 assert.equal(step.result.status,'passed',`adapter scenario did not pass: ${scenario.name}`);
 if(!step.hidden && typeof step.name==='string')businessSteps++;
}
assert.equal(actual.length,10,'complete adapter feature expected');
assert.equal(businessSteps,31,'complete adapter business steps expected');
console.log(JSON.stringify({status:'verified',sequences:49,controls:4,scenarios:actual.length,businessSteps,cucumber:cucumberPath,
 cucumberSha256:createHash('sha256').update(cucumberRaw).digest('hex')}));
