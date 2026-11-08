import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const [rootArg,output]=process.argv.slice(2),root=resolve(rootArg);
const {LocalRuntime}=await import(pathToFileURL(join(root,'src/local-runtime.ts')));
const {initialTask}=await import(pathToFileURL(join(root,'src/task.machine.ts')));
const {localModelInput}=await import(pathToFileURL(join(root,'tests/local-model-fixture.ts')));
const records=[];
for(const variant of ['unchanged','args','requestHash','workId','epoch','goalVersion','workspace','executable','environment','expiry']){
 const dir=mkdtempSync(join(tmpdir(),'authority-digest-')),source=join(dir,'source'),executable=join(dir,'fixture');mkdirSync(source);writeFileSync(executable,'#!/bin/sh\nexit 0\n',{mode:0o755});const commandEnv={[executable]:{FORMAL_FIXTURE_VALUE:'one'}};let runtime;
 try{
  runtime=await LocalRuntime.create({dataRoot:join(dir,'data'),workspaceRoot:source,skillRoots:[],acquireServiceLock:false,clock:()=>1,commandEnv,backend:{available:false,async execute(){throw Error('Sandbox not used');}}});
  const context=initialTask(localModelInput()).context;
  assert.equal(context.sourceArtifact,undefined,'Authority:slice:source revisions are outside this model');
  assert(!context.intents.some(w=>w.kind==='interpretation'),'Authority:slice:no interpretation or capacity planning');
  assert.equal(context.discussion,undefined,'Authority:slice:discussion recovery requires a separate model');
  assert(context.intents.every(w=>!w.discussionId),'Authority:slice:no discussion work');
  const work=structuredClone(context.intents[0]);assert.equal(work.kind,'owner','Authority:slice:owner runtime input');work.attempt=1;work.status='inflight';work.deadline=1000;
  const op={id:'op',namespace:'a'.repeat(64),requestHash:'b'.repeat(64),workspaceId:runtime.workspaceId(work,'a'.repeat(64)),sessionId:'preparation',status:'claimed',parentAttempt:1,attempt:1,createdAt:0,action:{type:'runCli',execution:'host',executable,args:[],reason:'formal'}};
  let reachedLaunch=0;const stopBeforeSpawn=()=>{reachedLaunch++;throw Error('Deliberate gate: no fixture command is spawned');};
  const prepared=await runtime.execute(work,op,AbortSignal.timeout(10000),stopBeforeSpawn);assert.equal(prepared.result.code,'HOST_APPROVAL_REQUIRED');assert(prepared.approval);assert.equal(reachedLaunch,0);
  op.approval={...prepared.approval,status:'approved'};op.sessionId='execution';
  if(variant==='args')op.action.args=['changed'];if(variant==='requestHash')op.requestHash='c'.repeat(64);if(variant==='workId')work.id+='other';if(variant==='epoch')work.epoch++;if(variant==='goalVersion')work.goalVersion++;if(variant==='workspace')writeFileSync(join(source,'changed.txt'),'changed');if(variant==='executable')writeFileSync(executable,'#!/bin/sh\nexit 1\n');if(variant==='environment')commandEnv[executable].FORMAL_FIXTURE_VALUE='two';if(variant==='expiry')op.approval.expiresAt=1;
  const result=await runtime.execute(work,op,AbortSignal.timeout(10000),stopBeforeSpawn);
  assert.equal(reachedLaunch,variant==='unchanged'?1:0,`Authority:digest:${variant}:unexpected launch boundary`);
  assert.equal(result.result.code,variant==='unchanged'?'CLI_EXECUTION_FAILED':variant==='expiry'?'HOST_APPROVAL_EXPIRED':'HOST_APPROVAL_STALE',`Authority:digest:${variant}:binding`);
  records.push({variant,reachedLaunch,result:result.result.code,settled:result.settled,effectsKnown:result.effectsKnown});
 }finally{await runtime?.close();rmSync(dir,{recursive:true,force:true});}
}
writeFileSync(output,JSON.stringify({status:'passed',records},null,2));console.log(JSON.stringify({status:'passed',cases:records.length,spawned:0}));
