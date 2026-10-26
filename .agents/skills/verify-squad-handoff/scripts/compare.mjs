#!/usr/bin/env node
// Run with the repository's tsx loader. This file observes production modules;
// it never patches a live store or imports a hand-written implementation model.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const [target, graphFile, output, selectedBackend = 'both'] = process.argv.slice(2);
assert(target && graphFile && output, 'Usage: node --import tsx compare.mjs ROOT GRAPH.dot OUTPUT.json');
assert(['both', 'memory', 'sqlite'].includes(selectedBackend), 'Unknown storage backend');
const root = resolve(target);
const { TeamEngine, MemoryStore, SqliteStore, WorkRunner } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href);
const config = createTeamConfig({});
const room = 'formal-room', task = 'task:formal-start', resultId = 'R1';
mkdirSync(dirname(resolve(output)), { recursive: true });
const observations = output + '.jsonl';
const graph = { nodes: new Map(), edges: [], initial: null };
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    const fields = [...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)];
    graph.nodes.set(node[1], Object.fromEntries(fields.map(([, name, value]) => [name, value === 'TRUE' ? true : value === 'FALSE' ? false : Number(value)])));
    if (node[3].includes('filled')) graph.initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) graph.edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), `Unparsed labeled TLC edge: ${line}`);
}
assert(graph.initial && graph.nodes.size > 0 && graph.edges.length > 0, 'Missing TLC graph; never accept an empty comparison');
const paths = new Map([[graph.initial, []]]);
const queue = [graph.initial];
for (let i = 0; i < queue.length; i++) {
  for (const edge of graph.edges.filter(e => e.from === queue[i])) if (!paths.has(edge.to)) {
    paths.set(edge.to, [...paths.get(edge.from), edge]); queue.push(edge.to);
  }
}
assert.equal(paths.size, graph.nodes.size, 'Every TLC state must have a reachable replay prefix');
assert.deepEqual([...new Set(graph.edges.map(e => e.action))].sort(),
  ['Flush', 'Direct', 'RetrySaved', 'DuplicateRecord', 'Stop', 'Continue', 'ChangeGoal', 'Crash', 'Rollback', 'Reopen'].sort(),
  'Every declared action must be reachable and parsed');

function setup(backend, base) {
  const path = join(base, 'state.sqlite');
  let store = backend === 'sqlite' ? new SqliteStore(path) : new MemoryStore();
  let engine = new TeamEngine(store, config, () => 0);
  let online = true, crashed = false, rolledBack = false, sequence = 0;
  const event = value => engine.send(room, task, { id: `formal:${++sequence}`, at: 0, ...value });
  assert.equal(engine.submit(room, { id: 'formal-start', text: '形成可核查方案' }).ok, true);
  const owner = engine.claim(room, task, engine.pending(room, task)[0].id);
  assert(owner);
  assert.equal(event({ type: 'HELP', workId: owner.id, fence: { epoch: 1, goalVersion: 1 }, caller: 'A', target: 'B',
    requestId: 'H1', question: '核查依据', expected: '事实与来源' }).ok, true);
  const helper = engine.claim(room, task, engine.pending(room, task)[0].id);
  assert(helper && helper.kind === 'assistance');
  const delivery = { type: 'RECORD_RESULT', workId: helper.id, fence: { epoch: 1, goalVersion: 1 },
    requestId: 'H1', resultId, answer: '依据已核查', status: 'success' };
  assert.equal(event(delivery).ok, true);

  function observe() {
    // Reading the persistent snapshot remains possible while the engine is down.
    const reader = online ? engine : new TeamEngine(store, config, () => 0);
    const c = reader.view(room, task).context;
    const result = c.results.find(r => r.resultId === resultId);
    const successors = c.intents.filter(i => i.kind === 'owner' && i.payload.resultId === resultId);
    return { online, marker: result.consumed, consumed: c.consumedResults.includes(resultId),
      resumes: successors.length, live: successors.some(i => ['pending', 'inflight'].includes(i.status)),
      answers: c.messages.filter(m => m.kind === 'answer' && m.requestId === 'H1').length,
      helpLive: ['pending', 'running', 'answered'].includes(c.assists.find(h => h.id === 'H1').status),
      stopped: c.stopped, epoch: c.epoch, goalVersion: c.goalVersion, crashed, rolledBack };
  }
  function apply(action) {
    switch (action) {
      case 'Flush': engine.flushResults(room, task); break;
      case 'Direct': event({ type: 'HELP_RESULT', fence: { epoch: 1, goalVersion: 1 }, requestId: 'H1', resultId, answer: '依据已核查', status: 'success' }); break;
      case 'RetrySaved': engine.submit(room, { id: `retry:${++sequence}`, text: '重试 B 的这次协助', intent: 'retry', replyToTaskId: task, retryAssistanceId: 'H1' }); break;
      case 'DuplicateRecord': event(delivery); break;
      case 'Stop': event({ type: 'STOP' }); break;
      case 'Continue': engine.submit(room, { id: `continue:${++sequence}`, text: '继续', intent: 'continue', replyToTaskId: task }); break;
      case 'ChangeGoal': event({ type: 'USER_INPUT', text: '更新目标', goal: { text: '新目标', constraints: [], criteria: ['可检查结果'], requiredArtifacts: 0 } }); break;
      case 'Crash': online = false; crashed = true; engine = undefined; break;
      case 'Rollback': {
        const before = JSON.stringify(store.read(room));
        store.failNextCommit = true;
        assert.throws(() => engine.flushResults(room, task), /Injected commit failure/, 'Rollback precondition must execute a transaction');
        assert.equal(JSON.stringify(store.read(room)), before, 'ROLLBACK: persistent result and successor changed after an aborted commit');
        online = false; rolledBack = true; engine = undefined;
        break;
      }
      case 'Reopen':
        if (backend === 'sqlite') { store.close(); store = new SqliteStore(path); }
        engine = new TeamEngine(store, config, () => 0); online = true;
        // Split TeamEngine.recover's RECOVER transaction from its flush loop.
        event({ type: 'RECOVER', config });
        break;
      default: throw new Error(`Unknown graph action ${action}`);
    }
    return observe();
  }
  return { observe, apply, engine: () => engine, close: () => store.close() };
}
function properties(state) {
  assert(state.resumes <= 1 && state.answers <= 1, 'AtMostOnce: one saved result scheduled or published twice');
  assert.equal(state.consumed, state.resumes > 0, 'AtomicHandoff: result consumption and owner resumption disagree');
  assert(!state.consumed || state.marker, 'AtomicHandoff: durable result marker missing');
  assert(!state.stopped || !state.live, 'StopCancelsResume: stopped task retains live successor');
}

const work = mkdtempSync(join(tmpdir(), 'squad-formal-replay-'));
const summary = { status: 'running', graphStates: graph.nodes.size, graphEdges: graph.edges.length, backends: [], probes: [] };
try {
  for (const backend of selectedBackend === 'both' ? ['memory', 'sqlite'] : [selectedBackend]) {
    const flushDir = join(work, `${backend}-flush-probe`); mkdirSync(flushDir);
    const flushProbe = setup(backend, flushDir);
    try {
      const before = flushProbe.observe();
      const after = flushProbe.apply('Flush');
      appendFileSync(observations, JSON.stringify({ backend, probe: 'FlushAtomic', before, after }) + '\n');
      properties(after);
      summary.probes.push({ backend, name: 'FlushAtomic', calls: 1, consumed: after.consumed });
    } finally { flushProbe.close(); }
    const retryDir = join(work, `${backend}-retry-probe`); mkdirSync(retryDir);
    const retryProbe = setup(backend, retryDir);
    try {
      const before = retryProbe.observe();
      const after = retryProbe.apply('RetrySaved');
      appendFileSync(observations, JSON.stringify({ backend, probe: 'RetrySavedAtomic', before, after }) + '\n');
      properties(after);
      assert(after.consumed && after.resumes === 1, 'RetrySavedAtomic: saved-result retry did not hand off');
      summary.probes.push({ backend, name: 'RetrySavedAtomic', calls: 1 });
    } finally { retryProbe.close(); }
    // Concrete scheduling witness. This is not a code-level liveness proof:
    // TLC separately checks Progress under the documented fairness assumptions.
    const probeDir = join(work, `${backend}-probe`); mkdirSync(probeDir);
    const probe = setup(backend, probeDir);
    try {
      const runner = new WorkRunner(probe.engine(), { execute: async () => { throw new Error('Probe must consume R1 before calling any adapter'); } }, () => 0);
      const before = probe.observe();
      const outcomes = [];
      for (let n = 0; n < 5 && !probe.observe().consumed; n++) outcomes.push(await runner.runOne(room, task));
      appendFileSync(observations, JSON.stringify({ backend, probe: 'RunnerProgress', before, after: probe.observe(), outcomes }) + '\n');
      properties(probe.observe());
      assert(probe.observe().consumed && probe.observe().resumes === 1, 'RunnerProgress: repeated runOne left an eligible saved result without an owner successor');
      summary.probes.push({ backend, name: 'RunnerProgress', calls: outcomes.length });
    } finally { probe.close(); }
    let replayed = 0;
    for (const edge of graph.edges) {
      const dir = join(work, `${backend}-${replayed}`); mkdirSync(dir);
      const instance = setup(backend, dir);
      const path = [...paths.get(edge.from), edge];
      try {
        assert.deepEqual(instance.observe(), graph.nodes.get(graph.initial), 'Reachable RECORD_RESULT prefix must match Init');
        for (const step of path) {
          const actual = instance.apply(step.action);
          properties(actual);
          assert.deepEqual(actual, graph.nodes.get(step.to), `Conformance: ${path.map(x => x.action).join(' → ')} at ${step.action}`);
        }
        appendFileSync(observations, JSON.stringify({ backend, from: edge.from, to: edge.to, path: path.map(x => x.action), observed: instance.observe() }) + '\n');
        replayed++;
      } catch (error) {
        summary.counterexample = { backend, path: path.map(x => x.action), expected: graph.nodes.get(edge.to), actual: instance.observe() };
        throw error;
      } finally { instance.close(); rmSync(dir, { recursive: true, force: true }); }
    }
    summary.backends.push({ name: backend, edgesReplayed: replayed });
  }
  summary.status = 'verified';
} catch (error) {
  summary.status = 'failed'; summary.error = error.stack; process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
  summary.scratchRemoved = true;
  writeFileSync(output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
