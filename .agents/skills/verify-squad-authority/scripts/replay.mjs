import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const [rootArg,graphFile,domain,output,selectedBackend]=process.argv.slice(2), root=resolve(rootArg);
const {TeamEngine,MemoryStore,SqliteStore}=await import(pathToFileURL(join(root,'src/index.ts')));
const {localModelInput}=await import(pathToFileURL(join(root,'tests/local-model-fixture.ts')));
const config=localModelInput().config;
const nodes=new Map(), edges=[]; let initial;
for(const line of readFileSync(graphFile,'utf8').split('\n')) {
 const n=/^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
 if(n){nodes.set(n[1],Object.fromEntries([...n[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([,k,v])=>[k,v==='TRUE'?true:v==='FALSE'?false:Number(v)])));if(n[3].includes('filled'))initial=n[1];}
 const e=/^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);if(e)edges.push({from:e[1],to:e[2],action:e[3]});
}
assert(initial&&edges.length,'Nonempty model graph');
const rawGraph=readFileSync(graphFile,'utf8');assert.equal(edges.length,[...rawGraph.matchAll(/^[-\d]+ -> [-\d]+ /gm)].length,'Every graph edge parsed');
const rawLog=readFileSync(join(resolve(graphFile,'..'),'tlc.log'),'utf8');const count=[...rawLog.matchAll(/([\d,]+) distinct states found/g)].at(-1);assert(count);assert.equal(nodes.size,Number(count[1].replaceAll(',','')),'All TLC states parsed');
const paths=new Map([[initial,[]]]),queue=[initial];
for(let i=0;i<queue.length;i++)for(const e of edges.filter(e=>e.from===queue[i]))if(!paths.has(e.to)){paths.set(e.to,[...paths.get(e.from),e.action]);queue.push(e.to);}
assert.equal(paths.size,nodes.size);
function fixture(backend){
 const dir=mkdtempSync(join(tmpdir(),'authority-')), file=join(dir,'state.sqlite');
 let store=backend==='sqlite'?new SqliteStore(file):new MemoryStore(),time=1,seq=0;
 let engine=new TeamEngine(store,config,()=>time);
 const room='room',task='task:begin';
 assert(engine.submit(room,{id:'begin',text:'验证授权'}).ok);
 const work=engine.claim(room,task,engine.pending(room,task)[0].id);assert(work);
 assert.equal(engine.view(room,task).context.sourceArtifact,undefined,'Authority:slice:source revisions are outside this model');
 assert.equal(work.kind,'owner','Authority:slice:already claimed owner intent');
 assert(!engine.view(room,task).context.intents.some(w=>w.kind==='interpretation'),'Authority:slice:no interpretation or capacity planning');
 assert.equal(engine.view(room,task).context.discussion,undefined,'Authority:slice:discussion recovery requires a separate model');
 assert(engine.view(room,task).context.intents.every(w=>!w.discussionId),'Authority:slice:no discussion work');
 let operation,session,stage=0,starts=0,recovered=false,busy=false,unsafe=false;
 const send=body=>engine.send(room,task,{id:`event${++seq}`,at:time,...body});
 const current=()=>engine.view(room,task).context.intents.find(w=>w.id===work.id).localOperations?.find(o=>o.id===operation.id);
 if(domain==='host'){
  operation=engine.requestLocal(room,task,work.id,work.attempt,{type:'runCli',executable:'node',args:[],execution:'host',reason:'验证授权'},[],'workspace');
  const claim=engine.claimLocal(room,task,work.id,operation.id,work.attempt);assert(claim.response.ok);session=claim.operation.sessionId;
  assert(send({type:'LOCAL_APPROVAL_REQUIRED',intentId:work.id,operationId:operation.id,sessionId:session,fence:work,approval:{id:'approval',digest:'d'.repeat(64),status:'pending',expiresAt:900,plan:{executable:'/bin/node',args:[],cwd:'/task',workspaceRevision:'b'.repeat(64),executableHash:'c'.repeat(64),environmentHash:'e'.repeat(64),host:'host',account:'account',reason:'验证授权'}}}).ok);
 }
 function apply(action){
  switch(action){
   case 'Approve':{const accepted=send({type:'LOCAL_APPROVAL_DECISION',intentId:work.id,operationId:operation.id,approvalId:'approval',decision:'approve',fence:work}).ok;if(accepted){assert.equal(current().approval.status,'approved');assert.equal(current().status,'queued');stage=1;}return accepted;}
   case 'WrongApproval':return send({type:'LOCAL_APPROVAL_DECISION',intentId:work.id,operationId:operation.id,approvalId:'wrong',decision:'approve',fence:work}).ok;
   case 'Claim':{const r=engine.claimLocal(room,task,work.id,operation.id,work.attempt);if(r.response.ok){session=r.operation.sessionId;assert.equal(current().status,'claimed');stage=2;}return r.response.ok;}
   case 'StartDenied':case 'Start':{const invalid=engine.view(room,task).context.stopped||time>=900||recovered;const accepted=domain==='execution'?engine.beginExecution(room,task,work):send({type:'LOCAL_STARTED',intentId:work.id,operationId:operation.id,sessionId:session}).ok;if(accepted){if(domain==='host'){assert.equal(current().status,'running');assert.equal(current().startedAt,time);}else assert.equal(engine.executionPhase(room,task,work),'running');stage=3;starts++;unsafe ||= invalid;}return accepted;}
   case 'RollbackStart':{const before=JSON.stringify(store.read(room));store.failNextCommit=true;assert.throws(()=>engine.beginExecution(room,task,work),/Injected commit failure/);assert.equal(JSON.stringify(store.read(room)),before,'Authority:rollback changed persisted permit');return;}
   case 'Stop':send({type:'STOP'});return;
   case 'Expire':time=900;return;
   case 'Recover':if(backend==='sqlite'){store.close();store=new SqliteStore(file);}engine=new TeamEngine(store,config,()=>time);engine.recover(room);recovered=true;return;
   case 'LeaseBusy':assert(store.transact('other',tx=>tx.acquireWorkspace('workspace','other-owner')),'Foreign lease fixture');busy=true;return;
   default:throw Error(action);
  }
 }
 return {apply,observe(){const c=engine.view(room,task).context;assert.equal(c.discussion,undefined,'Authority:slice:discussion recovery requires a separate model');assert(c.intents.every(w=>!w.discussionId),'Authority:slice:no discussion work');return {stage,starts,stopped:c.stopped,expired:time>=900,recovered,busy,unsafe};},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function expected(s,a){const valid=!s.stopped&&!s.expired&&!s.recovered;if(a==='Start')return valid&&s.stage===(domain==='host'?2:0);if(a==='Claim')return valid&&s.stage===1&&!s.busy;if(a==='Approve')return valid&&s.stage===0;return false;}
const observations=[];
for(const backend of selectedBackend?[selectedBackend]:['memory','sqlite']){
 if(domain==='execution'){const f=fixture(backend);try{f.apply('RollbackStart');observations.push({backend,kind:'rollback',passed:true});}finally{f.close();}}
 for(const edge of edges){const f=fixture(backend);try{for(const action of paths.get(edge.from)){const result=f.apply(action);if(['Start','Approve','Claim'].includes(action))assert.equal(result,true,`Authority:${domain}:accepted prefix transition`);}assert.deepEqual(f.observe(),nodes.get(edge.from),`Authority:${domain}:source projection`);const result=f.apply(edge.action);if(['Start','Approve','Claim'].includes(edge.action))assert.equal(result,true,`Authority:${domain}:accepted edge`);if(edge.action==='StartDenied')assert.equal(result,false,`Authority:${domain}:rejected edge`);assert.deepEqual(f.observe(),nodes.get(edge.to),`Authority:${domain}:destination projection`);observations.push({backend,kind:'edge',...edge,actual:f.observe()});}finally{f.close();}}
 for(const [id,state]of nodes)for(const action of domain==='host'?['Start','Claim','Approve','WrongApproval']:['Start']){
  const f=fixture(backend);try{for(const a of paths.get(id))f.apply(a);const actual=f.apply(action);assert.equal(actual,expected(state,action),`Authority:${domain}:${action}:${backend}:${JSON.stringify(state)}:${paths.get(id)}`);observations.push({backend,kind:'probe',id,state,action,actual});}finally{f.close();}
 }
}
writeFileSync(output,JSON.stringify({domain,states:nodes.size,edges:edges.length,observations},null,2));
console.log(JSON.stringify({domain,states:nodes.size,edges:edges.length,probes:observations.filter(o=>o.kind==='probe').length,status:'passed'}));
