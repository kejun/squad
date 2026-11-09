import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { replayGraph } from '../../verify-squad-handoff/scripts/composition-graph.mjs';
const [target, graph, output, domain, backend = 'both'] = process.argv.slice(2);
const { authorityCompositionFixture } = await import(pathToFileURL(join(resolve(target), 'tests/authority-composition-fixture.ts')).href);
const runs = [];
for (const name of backend === 'both' ? ['memory', 'sqlite'] : [backend]) {
  const result = await replayGraph(graph, `${output}-${name}.json`, name, selected => authorityCompositionFixture(selected));
  runs.push({ name, result });
}
const report = { status: runs.every(run => run.result.status === 'verified') ? 'verified' : 'failed',
  graphStates: runs[0].result.graphStates, graphEdges: runs[0].result.graphEdges,
  backends: runs.map(run => ({ name: run.name, replayedEdges: run.result.backends[0]?.replayedEdges ?? 0, status: run.result.status,
    ...(run.result.error ? { error: run.result.error } : {}) })),
  ...(runs.some(run => run.result.error) ? { error: runs.map(run => run.result.error ?? '').join('\n') } : {}) };
writeFileSync(output, JSON.stringify(report, null, 2));
