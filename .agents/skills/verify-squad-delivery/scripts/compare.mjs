#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const [target, graphFile, output, backendSelection = 'both'] = process.argv.slice(2);
assert(target && graphFile && output, 'Usage: compare.mjs ROOT GRAPH OUTPUT [both|memory|sqlite]');
assert(['both', 'memory', 'sqlite'].includes(backendSelection), 'Unknown backend');
const root = resolve(target);
const { TeamEngine, MemoryStore, SqliteStore } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href);
const { deliveryEvidence } = await import(pathToFileURL(join(root, 'src/task/evidence.ts')).href);
const config = createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'false' });
const graph = { nodes: new Map(), edges: [], initial: null };
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    graph.nodes.set(node[1], Object.fromEntries([...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([, k, v]) => [k, v === 'TRUE' ? true : v === 'FALSE' ? false : +v])));
    if (node[3].includes('filled')) graph.initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) graph.edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), 'Unparsed edge');
}
assert(graph.initial && graph.nodes.size && graph.edges.length, 'Empty model graph');
const paths = new Map([[graph.initial, []]]), queue = [graph.initial];
for (let i = 0; i < queue.length; i++) for (const edge of graph.edges.filter(e => e.from === queue[i])) if (!paths.has(edge.to)) {
  paths.set(edge.to, [...paths.get(edge.from), edge]); queue.push(edge.to);
}
assert.equal(paths.size, graph.nodes.size);
assert.deepEqual([...new Set(graph.edges.map(e => e.action))].sort(), ['Publish','StaleRevision','Duplicate','Stop','ChangeGoal','LateCheck','Crash','Rollback','Reopen'].sort());
function setup(backend, directory) {
  const db = join(directory, 'state.sqlite');
  let store = backend === 'sqlite' ? new SqliteStore(db) : new MemoryStore();
  let engine = new TeamEngine(store, config, () => 0);
  let seq = 0, online = true, crashed = false, rolledBack = false, staleAccepted = false;
  const room = 'delivery', task = 'task:start';
  const send = body => engine.send(room, task, { at: 0, id: `e:${++seq}`, ...body });
  const context = () => (engine ?? new TeamEngine(store, config, () => 0)).view(room, task).context;
  assert(engine.submit(room, { id: 'start', text: 'Prepare report', goal: { text: 'Prepare report', constraints: [], criteria: ['Complete report'], requiredArtifacts: 1 } }).ok);
  const owner = engine.claim(room, task, engine.pending(room, task)[0].id);
  assert(owner);
  const action = { type: 'readSkillResource', skillId: 'local:source', path: 'references/report.txt' };
  const op = engine.requestLocal(room, task, owner.id, owner.attempt, action, [], 'workspace');
  const claimed = engine.claimLocal(room, task, owner.id, op.id, owner.attempt);
  assert(claimed.response.ok && claimed.operation.sessionId);
  assert(send({ type: 'LOCAL_RESULT', intentId: owner.id, operationId: op.id, sessionId: claimed.operation.sessionId,
    settled: true, effectsKnown: true, result: { ok: true, code: 'succeeded', data: { content: 'saved source', hash: 'a'.repeat(64), skillVersion: 'v1', nextOffset: null } } }).ok);
  assert(send({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'Report', artifactIds: [], artifacts: [{ name: 'report.md', content: 'Report with source' }] }).ok);
  const check = engine.claim(room, task, engine.pending(room, task).find(w => w.kind === 'check').id);
  assert(check);
  assert(send({ type: 'CONSUME', intentId: check.id, fence: check, attempt: check.attempt }).ok);
  const candidate = context().candidate;
  const body = { type: 'CHECK_RESULT', workId: check.id, fence: check, attempt: check.attempt, candidateRevision: candidate.revision,
    resultId: 'check-result', criteriaResults: candidate.acceptance.criteria.map(c => ({ criterionId: c.id, status: 'passed' })) };
  const observe = () => {
    const c = context(), publication = c.publishedDelivery;
    assert.equal(c.sourceArtifact, undefined, 'ModelScope: cross-task source revisions require a separate model');
    assert.equal(c.discussion, undefined, 'ModelScope: discussion recovery requires a separate model');
    assert(c.intents.every(work => !work.discussionId), 'ModelScope: no discussion work in this publication slice');
    assert(c.intents.every(work => work.kind !== 'interpretation'), 'ModelScope: interpretation requests are outside this publication slice');
    if (publication) {
      assert.equal(publication.revision, candidate.revision, 'CurrentCandidate: publication changed candidate');
      assert.equal(publication.goalVersion, candidate.goalVersion, 'VersionIsolation: publication changed goal version');
      assert.deepEqual(publication.artifactIds, candidate.artifactIds, 'AtomicPublication: publication selection changed');
      assert.equal(c.outcome, 'complete', 'AtomicPublication: publication without completion');
      const final = c.messages.filter(m => m.kind === 'final');
      assert.equal(final.length, 1, 'AtomicPublication: published delivery lacks exactly one final message');
      assert.deepEqual(final[0].artifactIds, publication.artifactIds, 'AtomicPublication: final and publication differ');
    }
    return { online, published: !!publication, finals: c.messages.filter(m => m.kind === 'final').length,
      stopped: c.stopped, goalVersion: c.goalVersion, crashed, rolledBack, staleAccepted };
  };
  const apply = action => {
    switch (action) {
      case 'Publish': assert(send(body).ok); break;
      case 'StaleRevision': {
        const response = send({ ...body, resultId: `stale:${seq}`, candidateRevision: 'superseded-candidate' });
        if (response.ok && context().publishedDelivery) staleAccepted = true;
        assert(!staleAccepted, 'CurrentCandidate: stale candidate judgment published'); break;
      }
      case 'Duplicate': case 'LateCheck': send(body); break;
      case 'Stop': assert(send({ type: 'STOP' }).ok); break;
      case 'ChangeGoal': assert(send({ type: 'USER_INPUT', text: 'New goal', goal: { text: 'New goal', criteria: ['New result'], constraints: [], requiredArtifacts: 1 } }).ok); break;
      case 'Crash': online = false; crashed = true; engine = undefined; break;
      case 'Rollback': {
        const before = JSON.stringify(store.read(room)); store.failNextCommit = true;
        assert.throws(() => send(body), /Injected commit failure/);
        assert.equal(JSON.stringify(store.read(room)), before, 'AtomicPublication: rollback persisted a partial delivery');
        online = false; rolledBack = true; engine = undefined; break;
      }
      case 'Reopen':
        if (backend === 'sqlite') { store.close(); store = new SqliteStore(db); }
        engine = new TeamEngine(store, config, () => 0); online = true; break;
      default: throw new Error(action);
    }
    return observe();
  };
  return { observe, apply, context, check, close: () => store.close() };
}
function snapshotProbe(instance) {
  const c = instance.context(), check = c.intents.find(w => w.id === instance.check.id);
  const frozen = c.deliveryCycle.evidence;
  const baseline = deliveryEvidence(c, check, frozen);
  assert.equal(baseline.sources[0].stdout, 'saved source', 'SnapshotBinding: missing exact saved text');
  let count = 0;
  // These are explicit receipt-corruption/legacy-input tests, not normal engine events.
  for (const field of ['content', 'hash', 'skillVersion', 'nextOffset', 'status', 'ok', 'code', 'offset']) {
    const copy = structuredClone(c), operation = copy.intents.flatMap(w => w.localOperations ?? []).find(o => o.action.type === 'readSkillResource');
    if (field === 'status') operation.status = 'failed';
    else if (field === 'ok') operation.result.ok = false;
    else if (field === 'code') operation.result.code = 'different';
    else if (field === 'offset') operation.action.offset = 1;
    else operation.result.data[field] = field === 'nextOffset' ? 4 : field === 'hash' ? 'b'.repeat(64) : 'changed';
    assert.equal(deliveryEvidence(copy, check, frozen), undefined, `SnapshotBinding: ${field} changed without invalidating frozen evidence`); count++;
  }
  const legacy = frozen.map(({ resourceSnapshot, ...ref }) => ref);
  assert.equal(deliveryEvidence(c, check, legacy), undefined, 'SnapshotBinding: legacy resource receipt missing snapshot accepted');
  return count + 1;
}
const scratch = mkdtempSync(join(tmpdir(), 'squad-delivery-replay-'));
const report = { status: 'running', graphStates: graph.nodes.size, graphEdges: graph.edges.length, backends: [] };
try {
  for (const backend of backendSelection === 'both' ? ['memory', 'sqlite'] : [backendSelection]) {
    const dir = join(scratch, backend); mkdirSync(dir);
    const probe = setup(backend, dir);
    let snapshotCases;
    try { snapshotCases = snapshotProbe(probe); } finally { probe.close(); rmSync(dir, { recursive: true }); }
    let replayed = 0;
    for (const edge of graph.edges) {
      mkdirSync(dir);
      const instance = setup(backend, dir), path = [...paths.get(edge.from), edge];
      try {
        assert.deepEqual(instance.observe(), graph.nodes.get(graph.initial));
        for (const step of path) assert.deepEqual(instance.apply(step.action), graph.nodes.get(step.to), `Conformance: ${path.map(e => e.action).join(' -> ')}`);
        appendFileSync(output + '.jsonl', JSON.stringify({ backend, from: edge.from, to: edge.to, path: path.map(e => e.action), actual: instance.observe() }) + '\n');
        replayed++;
      } catch (error) { report.counterexample = { backend, path: path.map(e => e.action) }; throw error; }
      finally { instance.close(); rmSync(dir, { recursive: true }); }
    }
    report.backends.push({ backend, edgesReplayed: replayed, snapshotCases });
  }
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { rmSync(scratch, { recursive: true, force: true }); report.scratchRemoved = true; writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
