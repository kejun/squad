import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayGraph } from './composition-graph.mjs';
const [target, graph, output, domain, backend = 'both'] = process.argv.slice(2);
const { RetryComposition } = await import(pathToFileURL(join(resolve(target), 'tests/handoff-composition-fixture.ts')).href);
await replayGraph(graph, output, backend, name => new RetryComposition(name, domain));
