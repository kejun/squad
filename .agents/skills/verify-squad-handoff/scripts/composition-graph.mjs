import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

/** Every labeled edge is replayed from one shortest reachable public prefix. */
export function loadGraph(file) {
  const nodes = new Map(), edges = [];
  let initial;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
    if (node) {
      const fields = [...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)];
      nodes.set(node[1], Object.fromEntries(fields.map(([, key, value]) => [key, value === 'TRUE' ? true : value === 'FALSE' ? false : +value])));
      if (node[3].includes('filled')) initial = node[1];
    }
    const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
    if (edge) edges.push({ from: edge[1], to: edge[2], action: edge[3] });
    else assert(!line.includes(' -> ') || !line.includes('[label='), 'Unparsed labeled transition');
  }
  assert(initial && nodes.size && edges.length, 'Nonempty, single-initial finite graph');
  const paths = new Map([[initial, []]]), queue = [initial];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of edges.filter(item => item.from === queue[index])) {
      if (!paths.has(edge.to)) { paths.set(edge.to, [...paths.get(edge.from), edge.action]); queue.push(edge.to); }
    }
  }
  assert.equal(paths.size, nodes.size, 'Every TLC state has a reachable prefix');
  return { nodes, edges, initial, paths };
}

export async function replayGraph(graphFile, output, backend, fixture) {
  const graph = loadGraph(graphFile);
  const report = { status: 'running', graphStates: graph.nodes.size, graphEdges: graph.edges.length, backends: [] };
  let activeBackend;
  try {
    for (const name of backend === 'both' ? ['memory', 'sqlite'] : [backend]) {
      activeBackend = name;
      let checked = 0;
      for (const edge of graph.edges) {
        const run = await fixture(name);
        try {
          assert.deepEqual(run.observe(), graph.nodes.get(graph.initial), 'Initial public prefix projection');
          for (const action of graph.paths.get(edge.from)) await run.apply(action);
          assert.deepEqual(run.observe(), graph.nodes.get(edge.from), `Source projection: ${edge.action}`);
          await run.apply(edge.action);
          assert.deepEqual(run.observe(), graph.nodes.get(edge.to), `Destination projection: ${edge.action}`);
          appendFileSync(output + '.jsonl', JSON.stringify({ backend: name, ...edge, prefix: graph.paths.get(edge.from), actual: run.observe() }) + '\n');
          checked++;
        } finally { await run.close(); }
      }
      report.backends.push({ name, replayedEdges: checked });
    }
    report.status = 'verified';
  } catch (error) { report.status = 'failed'; report.failedBackend = activeBackend; report.error = error instanceof Error ? error.stack : String(error); console.error(report.error); process.exitCode = 1; }
  writeFileSync(output, JSON.stringify(report, null, 2));
  return report;
}
