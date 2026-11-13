#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [rootArg, model, variant, graphFile, output, selected = 'both'] = process.argv.slice(2);
const root = resolve(rootArg);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { createCompositionDriver } = await import(pathToFileURL(join(sourceRoot, 'tests/coordination-composition-fixture.ts')).href);
const { createToolRecoveryDriver } = await import('./tool-recovery-driver.mjs');
const { createForwardDeliveryDriver, forwardDeliveryProbes } = await import('./forward-delivery-driver.mjs');
const nodes = new Map(), edges = []; let initial;
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    nodes.set(node[1], Object.fromEntries([...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([, key, value]) => [key,
      value === 'TRUE' ? true : value === 'FALSE' ? false : Number(value)])));
    if (node[3].includes('filled')) initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), `Unparsed edge ${line}`);
}
assert(initial && edges.length && nodes.size, 'Empty TLC graph');
const paths = new Map([[initial, []]]), queue = [initial];
const outgoing = new Map();
for (const edge of edges) { const list = outgoing.get(edge.from) ?? []; list.push(edge); outgoing.set(edge.from, list); }
for (let index = 0; index < queue.length; index++) for (const edge of outgoing.get(queue[index]) ?? []) if (!paths.has(edge.to)) {
  paths.set(edge.to, [...paths.get(edge.from), edge]); queue.push(edge.to);
}
assert.equal(paths.size, nodes.size, 'All parsed states must be reachable');
const scratch = mkdtempSync(join(tmpdir(), 'squad-composition-replay-'));
const report = { status: 'running', model, variant, graphStates: nodes.size, graphEdges: edges.length, backends: [], probes: [] };
mkdirSync(dirname(output), { recursive: true });
try {
  for (const backend of selected === 'both' ? ['memory', 'sqlite'] : [selected]) {
    if (model === 'ForwardDelivery') {
      const directory = join(scratch, `${backend}-latest-verdict-probes`); mkdirSync(directory);
      try { report.probes.push(...await forwardDeliveryProbes(root, backend, directory)); }
      catch (error) {
        report.failedBackend = backend;
        report.counterexample = { backend, actions: ['LatestVerdictProbe'], actual: {}, expected: {} };
        throw error;
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
    let count = 0;
    for (const edge of edges) {
      const directory = join(scratch, `${backend}-${count}`); mkdirSync(directory);
      const driver = model === 'ToolRecovery' ? await createToolRecoveryDriver(root, variant, backend, directory)
        : model === 'ForwardDelivery' ? await createForwardDeliveryDriver(root, variant, backend, directory)
        : await createCompositionDriver(root, model, variant, backend, directory);
      const path = [...paths.get(edge.from), edge];
      const executed = []; let expected = nodes.get(initial);
      try {
        driver.properties();
        assert.deepEqual(driver.observe(), nodes.get(initial), 'Reachable public prefix must match Init');
        for (const step of path) {
          executed.push(step.action); expected = nodes.get(step.to);
          const actual = driver.apply(step.action);
          assert.deepEqual(actual, nodes.get(step.to), `Conformance/${model}: ${path.map(item => item.action).join(' → ')}`);
        }
        appendFileSync(output + '.jsonl', JSON.stringify({ backend, from: edge.from, to: edge.to, actions: path.map(item => item.action), actual: driver.observe() }) + '\n');
        count++;
      } catch (error) {
        report.failedBackend = backend;
        report.counterexample = { backend, actions: executed, actual: driver.observe(), expected };
        throw error;
      } finally { driver.close(); rmSync(directory, { recursive: true, force: true }); }
    }
    report.backends.push({ name: backend, edgesReplayed: count });
    if (model === 'CancelledDiscussion' && variant.endsWith('-physical') && !variant.includes('-goal-')) {
      const directory = join(scratch, `${backend}-custody-lease-probe`); mkdirSync(directory);
      const driver = await createCompositionDriver(root, model, variant, backend, directory);
      try { report.probes.push(driver.custodyLeaseProbe()); }
      catch (error) {
        report.failedBackend = backend;
        report.counterexample = { backend, actions: ['CleanupContentResourceConflictProbe'], actual: driver.observe(), expected: {} };
        throw error;
      } finally { driver.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  }
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { rmSync(scratch, { recursive: true, force: true }); report.scratchRemoved = true; report.exitCode = process.exitCode ?? 0; writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
