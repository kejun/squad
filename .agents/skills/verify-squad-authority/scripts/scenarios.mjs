import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const [rootArg,graphFile,output,selectedBackend]=process.argv.slice(2),root=resolve(rootArg);
const {TeamEngine,MemoryStore,SqliteStore}=await import(pathToFileURL(join(root,'src/index.ts')));
const {hostSessionMatches}=await import(pathToFileURL(join(root,'src/host-session.ts')));
const {localModelInput}=await import(pathToFileURL(join(root,'tests/local-model-fixture.ts')));
const config=localModelInput().config;const records=[];
function fixture(backend){
 const dir=mkdtempSync(join(tmpdir(),'authority-scope-')),file=join(dir,'state.sqlite');let store=backend==='sqlite'?new SqliteStore(file):new MemoryStore(),engine=new TeamEngine(store,config,()=>1),seq=0;
 const room='r',task='task:s';assert(engine.submit(room,{id:'s',text:'检查宿主'}).ok);let work=engine.claim(room,task,engine.pending(room,task)[0].id);assert(work);let op,session;
 assert.equal(engine.view(room,task).context.sourceArtifact,undefined,'Authority:slice:source revisions are outside this model');
 assert.equal(work.kind,'owner','Authority:slice:already claimed owner intent');
 assert(!engine.view(room,task).context.intents.some(w=>w.kind==='interpretation'),'Authority:slice:no interpretation or capacity planning');
 const send=body=>engine.send(room,task,{id:`scope${++seq}`,at:1,...body});const context=()=>{const c=engine.view(room,task).context;assert.equal(c.discussion,undefined,'Authority:slice:discussion recovery requires a separate model');assert(c.intents.every(w=>!w.discussionId),'Authority:slice:no discussion work');return c;};const actual=()=>context().intents.find(w=>w.id===work.id).localOperations.find(o=>o.id===op.id);
 function prepare(change=()=>{}){op=engine.requestLocal(room,task,work.id,work.attempt,{type:'runCli',executable:'node',args:[`${seq}`],execution:'host',reason:'scope'},[],'workspace');assert(claim());const approval={id:`approval${seq}`,digest:'d'.repeat(64),status:'pending',expiresAt:900,plan:{executable:'/bin/node',args:[`${seq}`],cwd:'/task',workspaceRevision:'b'.repeat(64),executableHash:'c'.repeat(64),environmentHash:'e'.repeat(64),host:'h',account:'a',reason:'scope'}};change(approval);assert(send({type:'LOCAL_APPROVAL_REQUIRED',intentId:work.id,operationId:op.id,sessionId:session,approval,fence:work}).ok);return actual();}
 function claim(){const r=engine.claimLocal(room,task,work.id,op.id,work.attempt);if(r.response.ok)session=r.operation.sessionId;return r.response.ok;}
 const decide=(decision='approveSession',approvalId=actual().approval.id)=>send({type:'LOCAL_APPROVAL_DECISION',intentId:work.id,operationId:op.id,approvalId,decision,fence:work});
 const start=()=>send({type:'LOCAL_STARTED',intentId:work.id,operationId:op.id,sessionId:session});
 const result=(id=session)=>send({type:'LOCAL_RESULT',intentId:work.id,operationId:op.id,sessionId:id,result:{ok:true,code:'ok',data:{}},settled:true,effectsKnown:true});
 function grant(){prepare();assert(decide().ok);assert(claim());assert(start().ok);assert(result().ok);return context().hostSession.id;}
 const revoke=id=>send({type:'REVOKE_HOST_SESSION',grantId:id,fence:work});
 function recover(){if(backend==='sqlite'){store.close();store=new SqliteStore(file);}engine=new TeamEngine(store,config,()=>1);engine.recover(room);}
 function reClaimParent(){work=engine.claim(room,task,work.id);assert(work,'Reclaimed parent after fresh approval');}
 return {prepare,claim,decide,start,result,grant,revoke,context,actual,send,recover,reClaimParent,get work(){return work;},get engine(){return engine;},room,task,get store(){return store;},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const states=[];
for(const line of readFileSync(graphFile,'utf8').split('\n')){const n=/^(-?\d+) \[label="((?:\\.|[^"\\])*)"/.exec(line);if(n){const s=Object.fromEntries([...n[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([,k,v])=>[k,v==='TRUE'?true:v==='FALSE'?false:Number(v)]));states.push(s);}}
assert.equal(states.length,512,'Scope model must explore all 256 assignments and revoked counterparts');
for(const backend of selectedBackend?[selectedBackend]:['memory','sqlite']){
 const base=fixture(backend);try{const grant=base.grant();const op=base.prepare();const c=base.context();const work=c.intents.find(w=>w.id===base.work.id);for(const s of states){const candidate=structuredClone(c),w=structuredClone(work),o=structuredClone(op),a=structuredClone(op.approval);if(s.mask&1)o.namespace='other';if(s.mask&2)o.workspaceId='other';if(s.mask&4)a.plan.host='other';if(s.mask&8)a.plan.account='other';if(s.mask&16)a.plan.environmentHash='f'.repeat(64);if(s.mask&32)candidate.epoch++;if(s.mask&64)candidate.goalVersion++;if(s.mask&128)candidate.stopped=true;if(s.revoked)candidate.hostSession=undefined;assert.equal(hostSessionMatches(candidate,w,o,a),s.allowed,`Authority:session:scope:${backend}:${s.mask}:${s.revoked}`);records.push({backend,kind:'scope',...s});}assert(base.revoke(grant).ok);assert.equal(base.context().hostSession,undefined);assert.equal(base.actual().status,'awaitingApproval');}finally{base.close();}
 for(const invalidator of ['revoke','recover','goal','stop','continue'])for(const claimed of [false,true]){
  const f=fixture(backend);try{const grant=f.grant();const second=f.prepare();assert.equal(second.status,'queued');assert(second.approval.sessionGrantId);const oldId=second.approval.id;const oldWork=structuredClone(f.work);if(claimed)assert(f.claim());
   if(invalidator==='revoke')assert(f.revoke(grant).ok);
   if(invalidator==='recover')f.recover();
   if(invalidator==='goal')assert(f.send({type:'USER_INPUT',text:'new goal',goal:{text:'new',constraints:[],criteria:[],requiredArtifacts:0}}).ok);
   if(invalidator==='stop'||invalidator==='continue'){f.send({type:'STOP'});if(claimed)assert(f.result().ok);f.send({type:'SETTLE',intentId:oldWork.id});if(invalidator==='continue'){assert(f.engine.submit(f.room,{id:'continued',text:'继续',intent:'continue',replyToTaskId:f.task}).ok);assert.equal(f.context().epoch,oldWork.epoch+1);const fresh=f.engine.claim(f.room,f.task,f.engine.pending(f.room,f.task).find(w=>w.kind==='owner').id);assert(fresh);assert(f.engine.beginExecution(f.room,f.task,fresh));assert(!f.engine.beginExecution(f.room,f.task,oldWork));}}
   assert.equal(f.context().hostSession,undefined,`Authority:session:${invalidator}:grant cleared`);assert.equal(f.start().ok,false,`Authority:session:${invalidator}:stale launch`);assert.equal(f.decide('approve',oldId).ok,false,`Authority:session:${invalidator}:old approval`);
   if(invalidator==='goal'){assert.equal(f.context().goalVersion,oldWork.goalVersion+1);assert.equal(f.engine.beginExecution(f.room,f.task,oldWork),false,'Authority:session:goal:old permit');const late=f.send({type:'DELIVER',workId:oldWork.id,fence:oldWork,text:'late old candidate',artifactIds:[]});assert.equal(late.ok,false);assert.notEqual(f.context().candidate?.text,'late old candidate');}
   if(invalidator==='revoke'&&!claimed){assert(f.decide('approve').ok);assert(f.claim());assert(f.start().ok);assert(f.result().ok);assert(f.store.transact('other',tx=>tx.acquireWorkspace('workspace','fresh-owner')),'Authority:session:lease released after receipt');}
   if(invalidator==='recover'&&!claimed){assert(f.decide('approve').ok);f.reClaimParent();assert(f.claim());assert(f.start().ok);assert(f.result().ok);}
   if(invalidator==='recover'&&claimed){assert.equal(f.actual().status,'uncertain');assert.equal(f.result('wrong-session').ok,false);assert(f.result().ok);assert.equal(f.actual().status,'succeeded');assert(f.store.transact('other',tx=>tx.acquireWorkspace('workspace','recovered-owner')),'Authority:session:lease released after recovery receipt');}
   records.push({backend,kind:'lifecycle',invalidator,claimed,passed:true});
  }finally{f.close();}
 }
}
writeFileSync(output,JSON.stringify({status:'passed',scopeStates:states.length,records},null,2));console.log(JSON.stringify({status:'passed',scopeStates:states.length,records:records.length}));
