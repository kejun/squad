#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [target, graphPath, output, backend = 'both'] = process.argv.slice(2);
assert(target && graphPath && output);
assert(['both', 'memory', 'sqlite'].includes(backend));
const { LocalEffectsFixture } = await import(pathToFileURL(join(resolve(target), 'tests/local-effects-formal-fixture.ts')).href);
const nodes = new Map(), edges = []; let initial;
for (const line of readFileSync(graphPath, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    nodes.set(node[1], Object.fromEntries([...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([, key, value]) => [key, value === 'TRUE' ? true : value === 'FALSE' ? false : Number(value)])));
    if (node[3].includes('filled')) initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), `Unparsed graph edge: ${line}`);
}
assert(initial && nodes.size && edges.length, 'LocalEffects:NonemptyGraph');
const paths = new Map([[initial, []]]), queue = [initial];
for (let index = 0; index < queue.length; index++) {
  for (const edge of edges.filter(edge => edge.from === queue[index])) if (!paths.has(edge.to)) {
    paths.set(edge.to, [...paths.get(edge.from), edge]); queue.push(edge.to);
  }
}
assert.equal(paths.size, nodes.size, 'LocalEffects:AllStatesReachable');
assert.deepEqual([...new Set(edges.map(edge => edge.action))].sort(),
  ['Start', 'SaveReceipt', 'UnknownResult', 'Stop', 'Crash', 'Reopen', 'Commit', 'Rollback', 'UnknownProbe', 'WrongSession', 'Duplicate', 'Compete', 'BusyProbe'].sort());
const report = { status: 'running', graphStates: nodes.size, graphEdges: edges.length, backends: [] };
try {
  for (const kind of backend === 'both' ? ['memory', 'sqlite'] : [backend]) {
    let count = 0;
    for (const edge of edges) {
      const fixture = await new LocalEffectsFixture(kind).open();
      const prefix = paths.get(edge.from);
      try {
        assert.deepEqual(await fixture.state(), nodes.get(initial), 'LocalEffects:ReachableInitialPrefix');
        for (const prior of prefix) await fixture.apply(prior.action);
        assert.deepEqual(await fixture.state(), nodes.get(edge.from), 'LocalEffects:SourceProjection');
        await fixture.apply(edge.action);
        const actual = await fixture.state();
        assert.deepEqual(actual, nodes.get(edge.to), 'LocalEffects:TargetProjection');
        appendFileSync(output + '.jsonl', JSON.stringify({ backend: kind, ...edge, prefix: prefix.map(step => step.action), actual }) + '\n');
        count++;
      } catch (error) {
        report.counterexample = { backend: kind, ...edge, prefix: prefix.map(step => step.action), actual: await fixture.state(), expected: nodes.get(edge.to) };
        throw error;
      } finally { await fixture.close(); }
    }
    report.backends.push({ backend: kind, edges: count });
  }
  report.status = 'verified';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally { writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ status: report.status, states: nodes.size, edges: edges.length, stores: report.backends }));
