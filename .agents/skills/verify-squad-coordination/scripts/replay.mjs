#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { capacityProbes } from './capacity-probes.mjs';
import { discussionRecoveryProbes } from './discussion-recovery-probes.mjs';
const [rootArg, model, graphFile, output, selected = 'both'] = process.argv.slice(2);
assert(rootArg && ['Budget', 'Shards', 'CheckBudget'].includes(model) && output, 'ROOT Budget|Shards GRAPH OUTPUT [BACKEND]');
const root = resolve(rootArg);
const { TeamEngine, MemoryStore, SqliteStore } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href);
const { validInputIntent } = await import(pathToFileURL(join(root, 'src/input-intent.ts')).href);
const nodes = new Map(), edges = []; let initial;
for (const line of readFileSync(graphFile, 'utf8').split('\n')) {
  const node = /^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)/.exec(line);
  if (node) {
    nodes.set(node[1], Object.fromEntries([...node[2].matchAll(/(\w+) = (TRUE|FALSE|\d+)/g)].map(([, k, v]) => [k, v === 'TRUE' ? true : v === 'FALSE' ? false : Number(v)])));
    if (node[3].includes('filled')) initial = node[1];
  }
  const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
  if (edge) edges.push({ from: edge[1], to: edge[2], action: edge[3] });
  else assert(!line.includes(' -> ') || !line.includes('[label='), `Unparsed edge ${line}`);
}
assert(initial && edges.length && nodes.size, 'Empty TLC graph');
const paths = new Map([[initial, []]]), queue = [initial];
const outgoing = new Map();
for (const e of edges) { if (!outgoing.has(e.from)) outgoing.set(e.from, []); outgoing.get(e.from).push(e); }
for (let n = 0; n < queue.length; n++) for (const e of outgoing.get(queue[n]) ?? []) if (!paths.has(e.to)) {
  paths.set(e.to, [...paths.get(e.from), e]); queue.push(e.to);
}
assert.equal(paths.size, nodes.size, 'Unreachable parsed states');
function session(backend, directory, kind) {
  const config = createTeamConfig({});
  config.inputAnalysis = { enabled: kind === 'Shards' };
  config.limits.ordinary = kind === 'Budget' ? 3 : 20;
  config.limits.retries = 1;
  if (kind === 'Shards') config.models = { default: 'test', services: { test: { baseUrl: 'https://invalid.example/v1', model: 'test' } } };
  const path = join(directory, 'store.sqlite');
  let store = backend === 'memory' ? new MemoryStore() : new SqliteStore(path);
  let engine = new TeamEngine(store, config, () => 0), seq = 0;
  const room = 'formal-coordination', task = 'task:start';
  const context = () => {
    const c = engine.view(room, task).context;
    assert.equal(c.sourceArtifact, undefined, 'Scope: all three TLC slices require a source-free public prefix');
    if (kind !== 'Shards') {
      assert.equal(c.discussion, undefined, 'Scope: budget/check slices exclude discussion rounds');
      assert(c.intents.every(work => !work.discussionId), 'Scope: budget/check slices exclude discussion work');
    }
    return c;
  };
  const send = body => engine.send(room, task, { id: `event:${++seq}`, at: 0, ...body });
  const submit = engine.submit(room, { id: 'start', text: kind !== 'Shards' ? '形成可核查方案' : '分别研究甲乙两个来源，必须仅使用公开资料并汇总',
    ...(kind !== 'Shards' ? { goal: { text: '形成可核查方案', constraints: [], criteria: ['完整'], requiredArtifacts: 0 } } : {}) });
  assert(submit.ok, 'Public submission must initialize task');
  const reopen = () => { if (backend === 'sqlite') { store.close(); store = new SqliteStore(path); }
    engine = new TeamEngine(store, config, () => 0); engine.recover(room); };
  const rewriteSavedWork = (id, change) => store.transact(room, tx => change(tx.room.tasks[task].snapshot.context.intents.find(work => work.id === id)));
  return { context, send, reopen, engine: () => engine, close: () => store.close(), room, task, config, rewriteSavedWork };
}
function budget(backend, directory) {
  const s = session(backend, directory, 'Budget');
  let workId = s.context().intents.find(w => w.kind === 'owner').id, recovered = false, charges = 0;
  const work = () => s.context().intents.find(w => w.id === workId);
  const observe = () => { const c = s.context(), w = work(); return { work: w.status === 'cancelled' ? 2 : ['pending', 'inflight', 'done', 'uncertain'].indexOf(w.status),
    used: c.usage.ordinary, retries: c.usage.retries, requests: w.requestCount, attempt: w.attempt, epoch: c.epoch, recovered, charges }; };
  function apply(action) {
    const w = structuredClone(work());
    switch (action) {
      case 'Claim': { const claimed = s.engine().claim(s.room, s.task, w.id); assert(claimed, 'Claim must be reachable'); charges++; break; }
      case 'Consume': assert(s.send({ type: 'CONSUME', intentId: w.id, attempt: w.attempt, fence: w }).ok, 'Consume must be allowed'); if (w.requestCount > 0) charges++; break;
      case 'Fail': assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: true, reason: 'synthetic transient' }).ok); break;
      case 'Uncertain': assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: true, resultUncertain: true, reason: 'unknown external result' }).ok); break;
      case 'Recover': s.reopen(); recovered = true; break;
      case 'Continue': assert(s.send({ type: 'CONTINUE', extraOrdinary: 2, text: '用户明确追加两次额度继续' }).ok); workId = s.context().intents.filter(x => x.kind === 'owner').at(-1).id; break;
      case 'StaleAttempt': assert.equal(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt - 1, fence: w, transient: true, reason: 'late attempt' }).ok, false); break;
      case 'DeniedClaim': assert.equal(s.engine().claim(s.room, s.task, w.id), null, 'PaidBudget: exhausted claim must be denied'); break;
      case 'DeniedConsume': assert.equal(s.send({ type: 'CONSUME', intentId: w.id, attempt: w.attempt, fence: w }).ok, false, 'PaidBudget: exhausted request must be denied'); break;
      default: throw new Error(`Unknown budget action ${action}`);
    }
    return observe();
  }
  return { observe, apply, close: s.close };
}
function shards(backend, directory, kind = 'map') {
  const s = session(backend, directory, 'Shards');
  const interpretation = s.context().intents.find(w => w.kind === 'interpretation');
  assert(interpretation, 'Interpretation prefix must be reached');
  const claimed = s.engine().claim(s.room, s.task, interpretation.id); assert(claimed);
  assert.equal(interpretation.payload.maxPartitions, 8, 'CapacitySnapshot: two-shard graph prefix must have sufficient prepared capacity');
  assert.equal(claimed.payload.maxPartitions, 8, 'CapacitySnapshot: charged interpretation must preserve the sufficient host ceiling');
  assert.equal(claimed.payload.maxConcurrentPartitions, 4, 'CapacitySnapshot: concurrency remains distinct from total partitions');
  const spec = { action: 'request', objective: '比较甲乙来源', constraints: ['仅使用公开资料'],
      expectedOutputs: ['比较报告'], acceptanceCriteria: ['保留出处'], references: [], confidence: .95, clarification: null,
      decomposition: { kind: 'mapReduce', partitions: [{ id: 'alpha', objective: '研究甲', expectedOutput: '甲证据' },
        { id: 'beta', objective: '研究乙', expectedOutput: '乙证据' }], synthesis: '归并证据和未知' } };
  if (kind === 'discussion') delete spec.decomposition;
  assert(s.send({ type: 'INTERPRETATION_RESULT', workId: claimed.id, attempt: claimed.attempt, fence: claimed,
    inputId: claimed.payload.input.id, spec }).ok);
  if (kind === 'discussion') {
    assert(s.engine().claim(s.room, s.task, s.context().intents.find(w => w.kind === 'owner' && w.status === 'pending').id));
    assert(s.send({ type: 'USER_INPUT', text: '请成员核对来源', reviewTargets: ['B', 'builder-1'] }).ok);
    const planner = s.engine().claim(s.room, s.task, s.context().intents.find(w => w.kind === 'facilitator' && w.status === 'pending').id);
    assert(planner);
    assert(s.send({ type: 'DISCUSSION_PLAN', workId: planner.id, attempt: planner.attempt, fence: planner, discussionId: planner.discussionId,
      decision: { action: 'review', question: '核对来源', expected: '原始依据', reason: '直接邀请' } }).ok);
  }
  const roundId = s.context().discussion.id;
  const maps = s.context().intents.filter(w => w.kind === 'assistance' && w.discussionId === roundId).map(w => w.id);
  assert.equal(maps.length, 2, 'Exactly two map shards must be scheduled');
  let reopened = false, interrupted = false;
  const work = i => s.context().intents.find(w => w.id === maps[i - 1]);
  const summary = () => s.context().intents.find(w => w.kind === 'discussionSummary' && w.discussionId === roundId);
  const result = (w, status = 'success') => ({ type: 'DISCUSSION_RESULT', workId: w.id, attempt: w.attempt,
    fence: { epoch: w.epoch, goalVersion: w.goalVersion }, discussionId: roundId, text: `${w.target} 原始证据`, status });
  const observe = () => {
    const c = s.context(), round = c.discussion, sum = summary();
    const handoffs = c.intents.filter(w => w.kind === 'owner' && w.payload.discussion?.id === roundId && w.payload.discussion.status === 'delivered').length;
    return { w1: ['pending', 'inflight', 'done', 'cancelled'].indexOf(work(1).status), w2: ['pending', 'inflight', 'done', 'cancelled'].indexOf(work(2).status),
      r1: ['success', 'partial', 'failed'].indexOf(round.results.find(r => r.target === work(1).target)?.status) + 1,
      r2: ['success', 'partial', 'failed'].indexOf(round.results.find(r => r.target === work(2).target)?.status) + 1,
      summary: sum ? ['absent', 'pending', 'inflight', 'done', 'cancelled'].indexOf(sum.status) : 0,
      handoffs, incomplete: !!round.incomplete, stopped: c.stopped, goal: c.goalVersion, reopened, interrupted,
      round: ['collecting', 'summarizing', 'delivered', 'cancelled'].indexOf(round.status) };
  };
  function apply(action) {
    const match = /^(Claim|Success|Partial|Failure|Duplicate|Late)([12])$/.exec(action);
    if (match) {
      const w = work(Number(match[2]));
      if (match[1] === 'Claim') assert(s.engine().claim(s.room, s.task, w.id), 'Shard claim must be reachable');
      else if (match[1] === 'Failure') assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: false, reason: 'synthetic shard failure' }).ok);
      else if (['Duplicate', 'Late'].includes(match[1])) assert.equal(s.send(result(w)).ok, false, 'NoStaleHandoff: duplicate or stale shard result must be rejected');
      else assert(s.send(result(w, match[1] === 'Partial' ? 'partial' : 'success')).ok);
    } else switch (action) {
      case 'ClaimSummary': assert(s.engine().claim(s.room, s.task, summary().id)); break;
      case 'SummaryResult': assert(s.send(result(summary())).ok); break;
      case 'SummaryFailure': { const w = summary(); assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: false, reason: 'synthetic reducer failure' }).ok); break; }
      case 'LateSummary':
      case 'DuplicateSummary': assert.equal(s.send(result(summary())).ok, false, 'UniqueHandoff: repeated reducer result must be rejected'); break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'ChangeGoal': assert(s.send({ type: 'USER_INPUT', text: '新目标', goal: { ...s.context().goal, text: '新目标' } }).ok); break;
      case 'Reopen': interrupted = [work(1), work(2), summary()].some(w => w?.status === 'inflight'); s.reopen(); reopened = true; break;
      default: throw new Error(`Unknown shard action ${action}`);
    }
    return observe();
  }
  function recoveryProbe() {
    apply('Claim1');
    const old = structuredClone(work(1));
    apply('Reopen'); apply('Claim1');
    const before = observe();
    const response = s.send(result(old));
    assert.equal(response.ok, false, 'NoStaleAttempt: recovered old attempt must be rejected');
    assert.deepEqual(observe(), before, 'NoStaleAttempt: old result must not settle or consume the new attempt');
    return { name: 'RecoveredStaleAttempt', oldAttempt: old.attempt, currentAttempt: work(1).attempt, rejected: true, stateUnchanged: true };
  }
  return { observe, apply, close: s.close, recoveryProbe, session: s, work, summary, result };
}
function checkBudget(backend, directory) {
  const s = session(backend, directory, 'CheckBudget');
  const owner = s.context().intents.find(w => w.kind === 'owner');
  const first = s.engine().claim(s.room, s.task, owner.id); assert(first);
  assert(s.send({ type: 'DELIVER', workId: first.id, attempt: first.attempt, fence: first, text: '完整可检查方案', artifactIds: [] }).ok);
  let recoveries = 0;
  const check = () => s.context().intents.filter(w => w.kind === 'check').at(-1);
  const revisionWork = () => s.context().intents.filter(w => w.kind === 'owner' && w.payload.deliveryRevision).at(-1);
  const observe = () => {
    const c = s.context(), w = check(), rw = revisionWork(), d = c.deliveryCycle;
    let stage;
    if (c.outcome !== null) stage = 4;
    else if (w.status === 'uncertain') stage = 5;
    else if (w.status === 'pending') stage = 0;
    else if (w.status === 'inflight') stage = 1;
    else stage = rw?.status === 'pending' ? 2 : rw?.status === 'inflight' ? 3 : -1;
    return { stage, requests: d.requests, currentRequests: w.requestCount, retry: d.retry ? (d.retry.status === 'reserved' ? 1 : 2) : 0,
      revision: d.revisionUsed, revisions: c.intents.filter(i => i.kind === 'owner' && i.payload.deliveryRevision).length,
      recoveries, checks: c.usage.checks, retries: c.usage.retries };
  };
  const judgment = (w, status) => ({ type: 'CHECK_RESULT', workId: w.id, attempt: w.attempt, fence: w,
    candidateRevision: w.payload.candidate.revision, resultId: `check-result:${w.id}:${w.attempt}:${status}`,
    criteriaResults: status === 'bad' ? [] : w.payload.candidate.acceptance.criteria.map(c => ({ criterionId: c.id, status, reason: 'synthetic criterion judgment' })) });
  function apply(action) {
    const w = structuredClone(check());
    switch (action) {
      case 'ClaimCheck': assert(s.engine().claim(s.room, s.task, w.id)); break;
      case 'Consume': assert(s.send({ type: 'CONSUME', intentId: w.id, attempt: w.attempt, fence: w }).ok); break;
      case 'DeniedConsume': assert.equal(s.send({ type: 'CONSUME', intentId: w.id, attempt: w.attempt, fence: w }).ok, false, 'BoundedChecks: unreserved second request must be denied'); break;
      case 'Failure': assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: true, reason: 'synthetic transient' }).ok); break;
      case 'Uncertain': assert(s.send({ type: 'WORK_FAILED', intentId: w.id, attempt: w.attempt, fence: w, transient: true, resultUncertain: true, reason: 'unknown request outcome' }).ok); break;
      case 'BadProtocol': assert(s.send(judgment(w, 'bad')).ok); break;
      case 'FailedJudgment': assert(s.send(judgment(w, 'failed')).ok); break;
      case 'PassedJudgment': assert(s.send(judgment(w, 'passed')).ok); break;
      case 'ClaimRevision': assert(s.engine().claim(s.room, s.task, revisionWork().id)); break;
      case 'DeliverRevision': { const rw = revisionWork(); assert(s.send({ type: 'DELIVER', workId: rw.id, attempt: rw.attempt, fence: rw, text: '修订后的完整可检查方案', artifactIds: [] }).ok); break; }
      case 'Recover': s.reopen(); recoveries++; break;
      case 'DuplicateResult': assert.equal(s.send(judgment(w, 'passed')).ok, false); break;
      default: throw new Error(`Unknown check-budget action ${action}`);
    }
    return observe();
  }
  return { observe, apply, close: s.close };
}

function properties(s) {
  if (model === 'Budget') {
    assert.equal(s.used, s.charges, 'PaidBudget: persisted charges diverge from authorized claims/additional requests');
    assert(s.used <= (s.epoch === 1 ? 3 : 5), 'PaidBudget: ordinary limit exceeded');
    assert(s.retries <= 1, 'RetryBound: automatic retry limit exceeded');
  } else if (model === 'CheckBudget') {
    assert.equal(s.checks, s.requests, 'CheckAccounting: cycle requests and persistent charges diverge');
    assert(s.requests <= 3 && s.requests - Number(s.retry === 2) <= 2, 'BoundedChecks: more than two ordinary or three total checks');
    assert.equal(s.retries, Number(s.retry > 0), 'OneTechnicalRetry: repeated reservation spends retry more than once');
    assert(s.revisions <= 1 && s.revision === (s.revisions === 1), 'OneRevision: automatic revision repeated or marker lost');
  } else {
    assert(!s.summary || s.r1 > 0 && s.r2 > 0, 'AllSettledBeforeReduce: reducer scheduled before all shards settled');
    assert(s.handoffs <= 1, 'UniqueHandoff: multiple owner resumptions');
    assert(!(s.round === 0 && s.r1 > 0 && s.r2 > 0) || s.summary > 0, 'ProgressHandoff: final settled shard failed to enable reducer');
    assert(!(s.r1 > 1 || s.r2 > 1) || s.incomplete, 'PreserveIncomplete: partial/failure evidence erased');
    assert(!(s.stopped || s.goal === 2) || !s.handoffs, 'NoStaleHandoff: cancelled round resumed owner');
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'squad-coordination-replay-'));
const report = { status: 'running', model, graphStates: nodes.size, graphEdges: edges.length, backends: [], probes: [] };
mkdirSync(dirname(output), { recursive: true });
try {
  for (const backend of selected === 'both' ? ['memory', 'sqlite'] : [selected]) {
    if (model === 'Shards') {
      report.probes.push(...discussionRecoveryProbes(shards, backend, scratch));
      for (const probe of report.probes.filter(p => p.backend === backend && p.family === 'discussion-recovery'))
        appendFileSync(output + '.jsonl', JSON.stringify(probe) + '\n');
      const capacityDirectory = join(scratch, `${backend}-capacity-probes`); mkdirSync(capacityDirectory);
      try {
        const probes = capacityProbes({ TeamEngine, MemoryStore, SqliteStore, createTeamConfig, validInputIntent }, backend, capacityDirectory);
        report.probes.push(...probes);
        for (const probe of probes) appendFileSync(output + '.jsonl', JSON.stringify(probe) + '\n');
      } finally { rmSync(capacityDirectory, { recursive: true, force: true }); }
      const directory = join(scratch, `${backend}-recovery-probe`); mkdirSync(directory);
      const instance = shards(backend, directory);
      try { const probe = { backend, ...instance.recoveryProbe() }; report.probes.push(probe); appendFileSync(output + '.jsonl', JSON.stringify(probe) + '\n'); }
      finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
    }
    let count = 0;
    for (const edge of edges) {
      const directory = join(scratch, `${backend}-${count}`); mkdirSync(directory);
      const instance = ({ Budget: budget, Shards: shards, CheckBudget: checkBudget }[model])(backend, directory);
      const path = [...paths.get(edge.from), edge];
      try {
        assert.deepEqual(instance.observe(), nodes.get(initial), 'Public prefix must match model Init');
        for (const step of path) {
          const actual = instance.apply(step.action); properties(actual);
          assert.deepEqual(actual, nodes.get(step.to), `Conformance: ${path.map(s => s.action).join(' → ')}`);
        }
        appendFileSync(output + '.jsonl', JSON.stringify({ backend, from: edge.from, to: edge.to, actions: path.map(s => s.action), actual: instance.observe() }) + '\n');
        count++;
      } catch (error) {
        report.counterexample = { backend, actions: path.map(s => s.action), actual: instance.observe(), expected: nodes.get(edge.to) }; throw error;
      } finally { instance.close(); rmSync(directory, { recursive: true, force: true }); }
    }
    report.backends.push({ name: backend, edgesReplayed: count });
  }
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { rmSync(scratch, { recursive: true, force: true }); report.scratchRemoved = true; writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
