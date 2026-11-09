import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [rootArg, graphFile, output, selected = 'both'] = process.argv.slice(2), root = resolve(rootArg);
const { hostRetryDriver } = await import(pathToFileURL(join(root, 'tests/host-retry-formal-driver.mjs')));
const nodes = new Map(), edges = [], initials = [];
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const n = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (n) { nodes.set(n[1], Object.fromEntries([...n[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([,k,v]) => [k,v === 'TRUE' ? true : v === 'FALSE' ? false : Number(v)]))); if(n[3].includes('filled')) initials.push(n[1]); }
  const e = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (e) edges.push({ from: e[1], to: e[2], action: e[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), 'unparsed graph edge');
}
const log = readFileSync(resolve(graphFile, '..', 'tlc.log'), 'utf8');
const count = [...log.matchAll(/([\d,]+) distinct states found/g)].at(-1); assert(count);
assert.equal(nodes.size, Number(count[1].replaceAll(',','')), 'All TLC states parsed');
assert.equal(edges.length, [...readFileSync(graphFile,'utf8').matchAll(/^[-\d]+ -> [-\d]+ \[label=/gm)].length, 'All TLC edges parsed');
assert.equal(initials.length, 4, 'Four public initial prefixes');
const paths = new Map(initials.map(id => [id, []])), source = new Map(initials.map(id => [id,id])), queue = [...initials];
for(let i=0;i<queue.length;i++) for(const edge of edges.filter(e=>e.from===queue[i])) if(!paths.has(edge.to)) { paths.set(edge.to,[...paths.get(edge.from),edge]); source.set(edge.to,source.get(edge.from)); queue.push(edge.to); }
assert.equal(paths.size,nodes.size,'All parsed states reachable');
const report = { status:'running',graphStates:nodes.size, graphEdges:edges.length, initialPrefixes:4, temporalStutters: [...readFileSync(graphFile,'utf8').matchAll(/style="dashed"/g)].length, backends:[] };
writeFileSync(output+'.jsonl','');
try {
 for(const backend of selected === 'both' ? ['memory','sqlite'] : [selected]) {
  let replayed=0;
  for(const edge of edges) {
   const origin=nodes.get(source.get(edge.from));
   report.counterexample={backend,...edge,mode:origin.mode,prefix:paths.get(edge.from).map(step=>step.action)};
   const driver=await hostRetryDriver(root,backend,origin.mode);
   try {
    assert.deepEqual(driver.observe(),origin,'PublicPrefix');
    for(const step of [...paths.get(edge.from),edge]) assert.deepEqual(driver.apply(step.action),nodes.get(step.to),`RetirementProjection:${step.action}`);
    appendFileSync(output+'.jsonl',JSON.stringify({backend,...edge,mode:origin.mode,prefix:paths.get(edge.from).map(step=>step.action),actual:driver.observe()})+'\n');
    replayed++;
   } finally { driver.close(); }
  }
  report.backends.push({name:backend,edgesReplayed:replayed});
 }
 delete report.counterexample; report.status='verified';
} catch(error) {report.status='failed';report.error=error.stack ?? String(error);process.exitCode=1;}
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
