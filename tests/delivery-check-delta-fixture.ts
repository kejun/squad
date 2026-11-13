import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import { claimCheck } from './host-retry-model-fixture.js';
import { deliveryCheckMaterials } from '../src/delivery-check-delta.js';
export const originalEvidence = `${'完整来源正文。\n'.repeat(2000)}\n付款已经完成。`;
export const originalReport = `${'需要保留的长报告。\n'.repeat(1500)}\n测试执行记录尚未取得。\n付款尚未完成。`;
export const revisedReport = originalReport.replace('付款尚未完成。','付款已经完成。');
export const removedRequirement = '测试执行记录尚未取得。';
export const regressedReport = revisedReport.replace(removedRequirement,'');
export function prepareDeltaModel() {
 const m=new LocalModel();assert(m.request().ok);assert(m.claim().ok);
 assert(m.result({result:{ok:true,code:'succeeded',data:{stdout:originalEvidence,truncated:false,capturedEvidence:{stdout:{capturedContentHash:'a'.repeat(64),bytes:Buffer.byteLength(originalEvidence),chars:[...originalEvidence].length}}}}}).ok);
 assert(m.send({type:'DELIVER',workId:m.work.id,fence:m.work,attempt:m.work.attempt,text:'长报告',artifactIds:[],artifacts:[{name:'report.md',content:originalReport}]}).ok);
 const first=claimCheck(m);return {m,first,original:m.c.artifacts[0]!};
}
export function changedHash(run:ReturnType<typeof prepareDeltaModel>) {
 const op=run.m.c.intents.flatMap(w=>w.localOperations??[]).find(op=>op.id==='op1')!;
 (op.result!.data.capturedEvidence as {stdout:{capturedContentHash:string}}).stdout.capturedContentHash='b'.repeat(64);
}
export function deltaGate() {
 const run=prepareDeltaModel();const material=deliveryCheckMaterials(run.m.c,run.first)!;
 assert.equal(material.artifacts[0]!.content,originalReport);assert.equal(material.evidence[0]!.stdout,originalEvidence);assert.equal(Reflect.get(material,'delta'),undefined);
 run.first.payload.baselineCheckId='retired-check';assert.deepEqual(deliveryCheckMaterials(run.m.c,run.first),material);
 changedHash(run);assert.equal(deliveryCheckMaterials(run.m.c,run.first),undefined);
 return {boundary:'full downstream materials; frozen evidence identity; retired baseline ignored'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(deltaGate()));
