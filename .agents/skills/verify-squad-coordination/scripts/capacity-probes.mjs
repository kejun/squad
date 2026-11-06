import assert from 'node:assert/strict';
import { join } from 'node:path';

// Finite implementation examples, separate from the two-shard TLC graph.
export function capacityProbes({ TeamEngine, MemoryStore, SqliteStore, createTeamConfig, validInputIntent }, backend, directory) {
  const reports = [];
  for (const fixture of [
    { name: 'zero', ordinary: 3, capacity: 0, partitions: 2, dispatched: 0 },
    { name: 'one', ordinary: 4, capacity: 1, partitions: 2, dispatched: 0 },
    { name: 'two', ordinary: 5, capacity: 2, partitions: 2, dispatched: 2 },
    { name: 'four', ordinary: 7, capacity: 4, partitions: 4, dispatched: 4 },
    { name: 'refreshed-recovery', ordinary: 7, capacity: 4, partitions: 4, dispatched: 0, recover: true },
    { name: 'legacy-recovery', ordinary: 7, capacity: 4, partitions: 4, dispatched: 0, recover: true, legacy: true },
  ]) {
    const config = createTeamConfig({});
    config.inputAnalysis = { enabled: true };
    config.models = { default: 'fixture', services: { fixture: { baseUrl: 'https://invalid.example/v1', model: 'fixture' } } };
    config.limits.ordinary = fixture.ordinary;
    const room = `capacity-${fixture.name}`, task = 'task:start', path = join(directory, `${fixture.name}.sqlite`);
    let store = backend === 'memory' ? new MemoryStore() : new SqliteStore(path);
    let engine = new TeamEngine(store, config, () => 0);
    const context = () => {
      const c = engine.view(room, task).context;
      assert.equal(c.sourceArtifact, undefined, 'Scope: finite capacity examples require a source-free public prefix');
      return c;
    };
    try {
      assert(engine.submit(room, { id: 'start', text: '分别研究全部来源，并行汇总，保留全部证据和约束' }).ok);
      const pending = context().intents.find(work => work.kind === 'interpretation');
      assert.equal(pending.payload.maxPartitions, fixture.capacity, 'CapacitySnapshot: pending work must reserve its unpaid interpretation request');
      assert.equal(context().usage.ordinary, 0, 'CapacitySnapshot: preparing an interpretation must not charge it');
      let work = engine.claim(room, task, pending.id); assert(work);
      assert.equal(work.payload.maxPartitions, fixture.capacity, 'CapacitySnapshot: claim must not double-reserve interpretation');
      assert.equal(context().usage.ordinary, 1, 'CapacitySnapshot: interpretation claim must charge once');
      if (fixture.legacy) {
        // Only remove the additive hint from an otherwise public, reachable snapshot.
        // This is an old-format compatibility fixture, not a TLC state injection.
        store.transact(room, tx => { delete tx.room.tasks[task].snapshot.context.intents.find(item => item.id === work.id).payload.maxPartitions; });
      }
      if (fixture.recover) {
        if (backend === 'sqlite') { store.close(); store = new SqliteStore(path); }
        engine = new TeamEngine(store, config, () => 0); engine.recover(room);
        work = engine.claim(room, task, work.id); assert(work);
        assert.equal(context().usage.ordinary, 2, 'CapacityRefresh: recovered interpretation must retain and add charges');
        if (fixture.legacy) assert(!Object.hasOwn(work.payload, 'maxPartitions'), 'LegacyCapacity: missing historical hint must remain absent');
        else assert.equal(work.payload.maxPartitions, 3, 'CapacityRefresh: re-claim must refresh from the charged current budget');
      }
      const spec = { action: 'request', objective: '保留全部来源并形成比较', constraints: ['仅公开资料'], expectedOutputs: ['完整比较'],
        acceptanceCriteria: ['保留全部证据'], references: [], confidence: .95, clarification: null,
        decomposition: { kind: 'mapReduce', partitions: Array.from({ length: fixture.partitions }, (_, index) =>
          ({ id: `part-${index}`, objective: `研究来源${index}`, expectedOutput: `来源${index}完整证据` })), synthesis: '归并全部来源和未完成项' } };
      const currentCapacity = work.payload.maxPartitions;
      assert.equal(validInputIntent(spec, 'request', [], currentCapacity), currentCapacity === undefined || currentCapacity >= fixture.partitions,
        'CapacityValidation: the adapter-facing validator must reject plans above the fixed host ceiling');
      assert(validInputIntent(spec, 'request', []), 'LegacyCapacity: absent hint retains the static two-to-eight protocol');
      // TeamEngine intentionally uses schema-only validation; dispatch independently
      // rechecks current resources, including changed resources after a recovery.
      assert(engine.send(room, task, { type: 'INTERPRETATION_RESULT', id: 'result', at: 0, workId: work.id,
        attempt: work.attempt, fence: work, inputId: work.payload.input.id, spec }).ok);
      const c = context(), maps = c.intents.filter(item => item.kind === 'assistance' && item.status === 'pending');
      assert.equal(maps.length, fixture.dispatched, 'CapacityDispatch: dispatch must accept the complete plan or fall back without truncation');
      assert.equal(c.usage.assists, fixture.dispatched, 'CapacityDispatch: rejected plans must not spend assists');
      assert.deepEqual(c.inputAnalyses[0].spec.decomposition, spec.decomposition, 'CapacityDispatch: fallback must retain the whole plan');
      if (!fixture.dispatched) {
        const owners = c.intents.filter(item => item.kind === 'owner' && item.status === 'pending');
        assert.equal(owners.length, 1, 'CapacityDispatch: fallback must resume the original owner once');
        assert.deepEqual(owners[0].payload.inputIntents[0].spec.decomposition, spec.decomposition, 'CapacityDispatch: the owner must receive every partition');
      }
      reports.push({ backend, name: fixture.name, preparedCapacity: fixture.capacity,
        claimedCapacity: work.payload.maxPartitions ?? null, ordinaryCharges: c.usage.ordinary,
        partitions: fixture.partitions, dispatched: maps.length, legacy: !!fixture.legacy, verified: true });
    } finally { store.close(); }
  }
  return reports;
}
