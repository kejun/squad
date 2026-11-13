import assert from 'node:assert/strict';
import {After,Given,When,Then} from '@cucumber/cucumber';
import {OpenAICompatibleAdapter,WorkRunner} from '../../src/index.js';
import type {CheckMaterials} from '../../src/delivery-acceptance.js';
import {candidateJudgments,Harness,saveEvidence} from '../helpers.js';
import {modelResponse,regenerationConfig} from '../model-regeneration-fixture.js';
import {originalEvidence,originalReport,revisedReport,regressedReport} from '../delivery-check-delta-fixture.js';
import type {SpecWorld} from './steps.js';
class FullMaterialFixture {
 h=new Harness(regenerationConfig({checks:5,ordinary:30}));requests:CheckMaterials[]=[];mode='repair';sourceId:string;
 constructor(){const w=this.h.claim('owner');this.sourceId=saveEvidence(this.h,w,originalEvidence);assert(this.h.event({type:'DELIVER',workId:w.id,fence:w,attempt:w.attempt,text:'长报告',artifactIds:[],artifacts:[{name:'report.md',content:originalReport}]}).ok);}
 async run(){const adapter=new OpenAICompatibleAdapter(this.h.config,{clock:()=>this.h.now,transport:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));this.requests.push(JSON.parse(body.messages[1].content).context);
  if(this.mode==='technical')return Response.json({error:{code:'temporary'}},{status:503});
  const results=candidateJudgments(this.h.context().candidate);
  if(this.mode==='gap'||this.mode==='regression')results[1]={...results[1]!,status:'unverified',reason:this.mode==='gap'?'新增事实无法核实':'修正后仍遗漏另一项要求'};
  return modelResponse({type:'check',criteriaResults:this.mode==='missing'?results.slice(0,1):results,repair:{text:'检查员直接修正当前报告',artifacts:[{name:'report.md',content:this.mode==='regression'?regressedReport:revisedReport,replacesArtifactId:this.h.context().candidate!.artifactIds[0]}]}});
 }});assert(await new WorkRunner(this.h.engine,adapter,()=>this.h.now).runOne(this.h.room,this.h.task));}
 full(){assert.equal(this.requests[0]!.artifacts[0]!.content,originalReport);assert.equal(this.requests[0]!.evidence[0]!.stdout,originalEvidence);assert.equal(Reflect.get(this.requests[0]!,'delta'),undefined);}
 close(){this.h.store.close();}
}
const runs=new WeakMap<SpecWorld,FullMaterialFixture>();const f=(w:SpecWorld)=>runs.get(w)!;
After(function(this:SpecWorld){runs.get(this)?.close();runs.delete(this);});
Given('当前长报告和完整来源已经单向交给检查员',function(this:SpecWorld){runs.set(this,new FullMaterialFixture());});
When('检查员直接修正原报告中的付款状态',async function(this:SpecWorld){await f(this).run();});
Then('应完整提供报告与来源并发布修正稿且不退回作者',function(this:SpecWorld){const run=f(this);run.full();assert.equal(run.h.context().outcome,'complete');assert.equal(run.requests.length,1);assert(run.h.context().artifacts.some(a=>a.content===revisedReport));assert(!run.h.context().intents.some(w=>w.payload.deliveryRevision));});
When('检查员修正报告但新增事实仍无法核实',async function(this:SpecWorld){f(this).mode='gap';await f(this).run();});
Then('应声明新事实缺口并交付且不追加审核',function(this:SpecWorld){const run=f(this);run.full();assert.equal(run.h.context().outcome,'complete');assert(run.h.context().candidate!.text.includes('新增事实无法核实'));assert.equal(run.requests.length,1);});
When('保存的旧重审基线存在{string}',async function(this:SpecWorld,boundary:string){const run=f(this);run.h.store.transact(run.h.room,tx=>{const c=(tx.room.tasks[run.h.task] as {snapshot:{context:{intents:{kind:string;payload:Record<string,unknown>}[]}}}).snapshot.context;c.intents.find(w=>w.kind==='check')!.payload.baselineCheckId=`retired:${boundary}`;});run.h.reopen();await run.run();});
Then('本次检查应使用完整报告和实际来源',function(this:SpecWorld){f(this).full();assert.equal(f(this).h.context().outcome,'complete');});
When('当前检查响应只包含部分要求',async function(this:SpecWorld){f(this).mode='missing';await f(this).run();});
Then('应保留全部要求并进行一次协议补试且不派发作者',function(this:SpecWorld){const run=f(this);assert.equal(run.h.context().outcome,null);assert.equal(run.h.context().usage.retries,1);assert.equal(run.h.context().intents.filter(w=>w.kind==='owner').length,1);assert.equal(run.h.context().publishedDelivery,undefined);});
When('已冻结来源的捕获哈希发生变化',async function(this:SpecWorld){const run=f(this);run.h.store.transact(run.h.room,tx=>{const c=(tx.room.tasks[run.h.task] as {snapshot:{context:import('../../src/types.js').TaskContext}}).snapshot.context;const op=c.intents.flatMap(w=>w.localOperations??[]).find(o=>o.id===run.sourceId)!;(op.result!.data.capturedEvidence as {stdout:{capturedContentHash:string}}).stdout.capturedContentHash='b'.repeat(64);});run.h.reopen();await run.run();});
Then('应明确记录证据变化且不伪造可信检查',function(this:SpecWorld){assert.equal(f(this).requests.length,0);assert.equal(f(this).h.context().publishedDelivery,undefined);assert(f(this).h.context().candidate!.deliveryIssue);});
When('网络故障后重启并继续本次检查',async function(this:SpecWorld){const run=f(this);run.mode='technical';await run.run();run.h.reopen();run.mode='repair';await run.run();});
Then('应使用原完整材料完成交付且不重开上游',function(this:SpecWorld){const run=f(this);run.full();assert.deepEqual(run.requests[1],run.requests[0]);assert.equal(run.h.context().outcome,'complete');assert.equal(run.h.context().intents.filter(w=>w.kind==='check').length,1);});
When('检查员修正付款状态但仍发现另一项遗漏',async function(this:SpecWorld){f(this).mode='regression';await f(this).run();});
Then('应保留最新遗漏并正常交付且不追加复审',function(this:SpecWorld){const run=f(this);assert.equal(run.h.context().outcome,'complete');assert(run.h.context().candidate!.text.includes('仍遗漏'));assert.equal(run.requests.length,1);});
