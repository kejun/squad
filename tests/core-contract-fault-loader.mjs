import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const mode = process.env.CORE_CONTRACT_FAULT;
const faults = {
 local: ['/src/local-operation.ts', /c\.usage\.ordinary\+\+/g, 'c.usage.ordinary+=2'],
 coordination: ['/src/task/reducer.ts', /work\.payload\.owner\s*===\s*(?:void 0|undefined)/g, 'true'],
 search: ['/src/task/budget.ts', /function requestBudgetProblem\([^)]*\)\s*\{/, '$& if(work.kind==="owner") return null;'],
 artifact: ['/src/task/delivery.ts', /function artifactForWork\([^)]*\)\s*\{/, '$& return c.artifacts[0];'],
 protocol: ['/src/task/protocol.ts', /function legacyTaskSettled\([^)]*\)\s*\{/, '$& return true;'],
 capacity: ['/src/task/budget.ts', /function canRetryWork\([^)]*\)\s*\{/, '$& if(e.type==="WORK_FAILED" && isBoundedCheck(c.intents.find(work=>work.id===e.intentId))) return true;'],
 sandbox: ['/src/local-cli.ts', /allowNestedUserNamespaces:\s*false/g, 'allowNestedUserNamespaces:true'],
};
if (!faults[mode]) throw new Error('unknown diagnostic fault');
let applied = false;
registerHooks({ load(url, context, nextLoad) {
 const loaded = nextLoad(url, context);
 const [suffix, pattern, replacement] = faults[mode];
 if (new URL(url).pathname.endsWith(suffix)) {
  const original = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  const changed = original.replace(pattern,replacement);
  if(changed === original) throw new Error('diagnostic mutation did not match');
  applied = true;
  appendFileSync(`${process.env.CORE_CONTRACT_EVIDENCE}/negative-${mode}.applied.jsonl`, JSON.stringify({mode,suffix,originalHash:createHash("sha256").update(original).digest("hex"),mutatedHash:createHash("sha256").update(changed).digest("hex")})+"\n");
  process.stderr.write('[core-negative] applied '+mode+' '+suffix+'\n');
  return {...loaded,source:changed};
 }
 return loaded;
} });
process.on('exit',()=>{ if(!applied) process.stderr.write('[core-negative] NOT_APPLIED\n'); });
