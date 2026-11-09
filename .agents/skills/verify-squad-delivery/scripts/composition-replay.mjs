#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createVerification, createCycles } from '../../../../tests/delivery-composition-fixture.ts';
import { createSourceLineage } from '../../../../tests/source-lineage-formal-fixture.ts';
const [target, graphFile, output, selection = 'both', model = 'Verification'] = process.argv.slice(2);
assert(target && graphFile && output, 'ROOT GRAPH OUTPUT [both|memory|sqlite] [Verification|Cycles]');
assert(['both', 'memory', 'sqlite'].includes(selection));
const factory = model === 'Verification' ? createVerification : model === 'Cycles' ? createCycles : model === 'SourceLineage' ? createSourceLineage : undefined;
assert(factory, 'Unknown composition model');
const graph = { nodes: new Map(), edges: [], initial: undefined };
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    graph.nodes.set(node[1], Object.fromEntries([...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([,key,v]) => [key, v === 'TRUE' ? true : v === 'FALSE' ? false : Number(v)])));
    if (node[3].includes('filled')) graph.initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) graph.edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), 'Unparsed labeled TLC successor');
}
assert(graph.initial && graph.nodes.size && graph.edges.length, 'TLC graph must be complete and nonempty');
const paths = new Map([[graph.initial, []]]), queue = [graph.initial];
for (const state of queue) for (const edge of graph.edges.filter(edge => edge.from === state)) if (!paths.has(edge.to)) {
  paths.set(edge.to, [...paths.get(edge.from), edge]); queue.push(edge.to);
}
assert.equal(paths.size, graph.nodes.size, 'Every TLC node must have a replay prefix');
const scratch = mkdtempSync(join(tmpdir(), 'squad-composition-replay-'));
const report = { status: 'running', model, graphStates: graph.nodes.size, graphEdges: graph.edges.length, actions: [...new Set(graph.edges.map(edge => edge.action))].sort(), backends: [] };
try {
  for (const backend of selection === 'both' ? ['memory', 'sqlite'] : [selection]) {
    let replayed = 0;
    for (const edge of graph.edges) {
      const directory = join(scratch, backend); mkdirSync(directory);
      const instance = await factory(resolve(target), backend, directory), path = [...paths.get(edge.from), edge];
      try {
        assert.deepEqual(instance.observe(), graph.nodes.get(graph.initial), 'Conformance: initial reachable prefix');
        for (const step of path) assert.deepEqual(instance.apply(step.action), graph.nodes.get(step.to), `Conformance: ${path.map(item => item.action).join(' → ')}`);
        appendFileSync(output + '.jsonl', JSON.stringify({ backend, from: edge.from, to: edge.to, path: path.map(item => item.action), actual: instance.observe() }) + '\n');
        replayed++;
      } catch (error) { report.counterexample = { backend, path: path.map(item => item.action) }; throw error; }
      finally { instance.close(); rmSync(directory, { recursive: true }); }
    }
    report.backends.push({ backend, edgesReplayed: replayed });
  }
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { rmSync(scratch, { recursive: true, force: true }); report.scratchRemoved = true; writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
