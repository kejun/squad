import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=process.cwd(), area=resolve(process.env.MODEL_SESSION_CONTROLS_EVIDENCE ?? 'reports/kej-108-model-session/controls');
mkdirSync(area,{recursive:true});
const env={...process.env};for(const key of Object.keys(env))if(/^(?:MODEL_|A_MODEL_|B_MODEL_|BUILDER_[123]_MODEL_|FACILITATOR_MODEL_|CHECK_MODEL_|INTENT_MODEL_)/.test(key))delete env[key];
const faults=[
 ['drop-web-result','SessionEvidence',"messages.push({ role: 'assistant', content: choice.message.content },\n            { role: 'user', content: JSON.stringify({ type: `${toolType}_result`, untrusted: true, text }) });","/* faulty omission of acquired webpage result */"],
 ['echo-invalid-body','InvalidBodyIsolation','messages.push(repairFeedback(work.kind, error.issue, error.fieldRequirements));',"messages.push({ role: 'assistant', content: choice.message.content }, repairFeedback(work.kind, error.issue, error.fieldRequirements));"],
];
const original=readFileSync('src/model-adapter.ts','utf8'), before=createHash('sha256').update(original).digest('hex'), records=[];
function run(target,name,expected) {
 const evidence=join(area,name);mkdirSync(evidence,{recursive:true});
 const child=spawnSync(process.execPath,['--import',join(root,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',"import { modelSessionComposition } from './tests/model-session-composition-fixture.ts'; await modelSessionComposition();"],
 {cwd:target,env:{...env,MODEL_SESSION_COMPOSITION_EVIDENCE:evidence},encoding:'utf8',timeout:30000});
 writeFileSync(join(evidence,'process.log'),child.stdout+child.stderr);
 assert(!child.error,`${name}: process failed to execute`);
 if(expected)assert(child.status!==0&&(child.stdout+child.stderr).includes(expected),`${name}: did not catch ${expected}`);
 else assert.equal(child.status,0,`${name}: original implementation failed`);
 return {name,expected:expected??'pass',exitCode:child.status};
}
for(const [name,property,from,to] of faults) {
 assert.equal(original.split(from).length-1,1,`source anchor drift: ${name}`);
 const scratch=mkdtempSync(join(tmpdir(),'session-composition-control-'));
 try {
  for(const dir of ['src','tests'])cpSync(join(root,dir),join(scratch,dir),{recursive:true});
  for(const file of ['package.json','tsconfig.json','team.config.ts'])cpSync(join(root,file),join(scratch,file));
  symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
  const mutated=original.replace(from,to);writeFileSync(join(scratch,'src/model-adapter.ts'),mutated);
  writeFileSync(join(area,name+'.diff'),JSON.stringify({file:'src/model-adapter.ts',from,to,originalHash:before,mutatedHash:createHash('sha256').update(mutated).digest('hex')},null,2));
  records.push(run(scratch,name,property));
 }finally{rmSync(scratch,{recursive:true,force:true});}
 records.push(run(root,name+'-restored'));
}
assert.equal(createHash('sha256').update(readFileSync('src/model-adapter.ts')).digest('hex'),before);
writeFileSync(join(area,'controls.json'),JSON.stringify({status:'verified',records,coveredFileUnchanged:true},null,2));console.log(JSON.stringify({status:'verified',records}));
