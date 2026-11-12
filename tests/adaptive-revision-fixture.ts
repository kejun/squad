import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { claimHandoff, submitHandoff, reportHandoff } from './downstream-handoff-model-fixture.js';
import { persistTask,restoreTask } from '../src/task.machine.js';
export function forwardDelivery(gaps=1,boundary='') {
 const m=new LocalModel(input=>{input.goal.criteria=['要求甲','要求乙','要求丙'];if(boundary==='检查总额度仅剩本次')input.config.limits.checks=1;});
 assert(m.send({type:'CONSUME',intentId:m.work.id,fence:m.work,attempt:m.work.attempt}).ok);
 submitHandoff(m);if(boundary==='普通请求额度耗尽')m.c.config.limits.ordinary=m.c.usage.ordinary;
 const check=claimHandoff(m,'check');
 const receipt={type:'CHECK_RESULT',workId:check.id,fence:check,attempt:check.attempt,resultId:'final-findings',candidateRevision:m.c.candidate!.revision!,criteriaResults:m.c.candidate!.acceptance!.criteria.map((c,i)=>i<gaps?{criterionId:c.id,status:'unverified',reason:`未解决事项${i+1}：${boundary||'资料无法核实'}`}:{criterionId:c.id,status:'passed'})};
 return {m,check,receipt};
}
export type ForwardRun=ReturnType<typeof forwardDelivery>;
export function legacyRevisionForward() {
 const run=forwardDelivery();
 const saved=structuredClone(persistTask(run.m.snapshot)) as {context:LocalModel['c']};
 const spent=structuredClone(saved.context.usage);
 Reflect.set(saved.context.deliveryCycle!,'stage',{kind:'revising',baseRevision:saved.context.candidate!.revision,ownerWorkId:run.m.work.id});
 Reflect.set(saved.context.deliveryCycle!,'revisionUsed',true);
 Reflect.set(saved.context.deliveryCycle!,'revisions',{used:2,limit:2});
 Reflect.set(saved.context.intents.find(work=>work.kind==='owner')!.payload,'deliveryRevision',true);
 run.m.snapshot=restoreTask(saved);
 assert.deepEqual(run.m.c.deliveryCycle!.stage,{kind:'checking',candidateRevision:run.m.c.candidate!.revision,checkWorkId:run.check.id});
 assert.deepEqual(run.m.c.usage,spent);
 assert(run.m.c.intents.every(work=>!Reflect.has(work.payload,'deliveryRevision')));
 return run;
}
export function finishForward(run:ForwardRun) {
 assert(run.m.send(run.receipt).ok);assert.equal(run.m.c.outcome,'complete');
 assert.equal(run.m.c.intents.filter(w=>w.kind==='owner').length,1);assert.equal(run.m.c.intents.filter(w=>w.kind==='check').length,1);
 assert(!run.m.c.intents.some(w=>w.status==='pending'));assert(run.m.c.candidate!.text.includes('未解决事项'));
}
export function restoreForward(run:ForwardRun) {
 run.m.snapshot=restoreTask(structuredClone(persistTask(run.m.snapshot)));
 assert.equal(run.m.send(run.receipt).ok,false);assert.equal(run.m.c.messages.filter(m=>m.kind==='final').length,1);
 assert(!run.m.c.intents.some(w=>w.status==='pending'));
}
