import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,openSync,closeSync,existsSync,unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
const evidence = resolve(process.argv[2] ?? `reports/core-contract-negative/${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(evidence, {recursive:true});
const targets = { local:'BT_L70',coordination:'BT_M33',search:'BT_M36',artifact:'BT_A60',protocol:'BT_A70',capacity:'BT_M32',sandbox:'BT_L76' };
const sourceFiles=['src/local-operation.ts','src/task/reducer.ts','src/task/budget.ts','src/task/delivery.ts','src/task/protocol.ts','src/local-cli.ts'];
const hashes=()=>Object.fromEntries(sourceFiles.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')]));
const before=hashes();const results=[];
for(const [mode,tag] of Object.entries(targets)){
 const path=evidence+'/negative-'+mode;
 const command=['--import','tsx','--import',fileURLToPath(new URL('./core-contract-fault-loader.mjs',import.meta.url)),'node_modules/@cucumber/cucumber/bin/cucumber.js','features','--import','tests/bdd/*.ts','--tags','@'+tag,'--format','progress','--format','json:'+path+'.json'];
 if(existsSync(path+'.applied.jsonl'))unlinkSync(path+'.applied.jsonl');
 const fd=openSync(path+'.log','w');
 const run=spawnSync(process.execPath,command,{stdio:['ignore',fd,fd],encoding:'utf8',timeout:15000,env:{...process.env,MODEL_BASE_URL:'http://127.0.0.1:9/v1',MODEL_NAME:'fixture',CORE_CONTRACT_FAULT:mode,CORE_CONTRACT_EVIDENCE:evidence,TSX_TSCONFIG_PATH:'tests/bdd/tsconfig.json'}});
 closeSync(fd);
 let errorMessages=[];try{const report=JSON.parse(readFileSync(path+'.json','utf8'));errorMessages=report.flatMap(f=>f.elements??[]).flatMap(s=>s.steps??[]).filter(step=>step.result?.status==='failed').map(step=>step.result.error_message);}catch{}
 const detected=run.status===1 && existsSync(path+'.applied.jsonl') && errorMessages.some(message=>/AssertionError|strictly equal|deeply equal/.test(message)) && !run.error;
 const result={mode,tag,status:run.status,detected,assertions:errorMessages.map(m=>m.split('\n').slice(0,8).join('\n')),log:path+'.log'};
 console.log(JSON.stringify(result));results.push(result);
}
const after=hashes();const unchanged=JSON.stringify(before)===JSON.stringify(after);
writeFileSync(evidence+'/negative-results.json',JSON.stringify({before,after,unchanged,results},null,2));
if(!unchanged||results.some(r=>!r.detected))process.exitCode=1;
