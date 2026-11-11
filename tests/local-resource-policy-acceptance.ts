import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore, type Store } from '../src/store.js';
import { resolveLocalResourcePolicy, type LocalResourcePolicy, type ResourceLease } from '../src/local-resource-policy.js';
import type { Intent } from '../src/types.js';
import type { LocalOperation } from '../src/local-operation.js';
import { PartitionResilienceEngineFixture } from './partition-resilience-acceptance.js';
import { isolatedPolicyInput } from './local-resource-policy-model-fixture.js';

export function resourceLeaseStoreAcceptance(sqlite: boolean) {
  const directory = sqlite ? mkdtempSync(join(tmpdir(), 'squad-resource-registry-')) : undefined;
  const store: Store = directory ? new SqliteStore(join(directory, 'registry.sqlite')) : new MemoryStore();
  const acquire = (leases: ResourceLease[], owner: string) => store.transact('registry', tx => tx.acquireResources!(leases, owner));
  const release = (keys: string[], owner: string, phase?: ResourceLease['phase']) => store.transact('registry', tx => tx.releaseResources!(keys, owner, phase));
  const read: ResourceLease = { key: 'source', mode: 'read', phase: 'execute' }, write: ResourceLease = { ...read, mode: 'write' };
  try {
    assert(acquire([read], 'a')); assert(acquire([read], 'b'));
    assert.equal(acquire([{ key: 'free-copy', mode: 'write', phase: 'execute' }, write], 'blocked'), false);
    assert(acquire([{ key: 'free-copy', mode: 'write', phase: 'execute' }], 'free-owner'), 'Atomic rejection must not leak the first resource');
    release(['source'], 'intruder'); assert.equal(acquire([write], 'writer'), false);
    release(['source'], 'a'); assert.equal(acquire([write], 'writer'), false);
    release(['source'], 'b'); assert(acquire([write], 'writer')); release(['source'], 'writer');
    assert(acquire([{ key: 'dual', mode: 'read', phase: 'prepare' }, { key: 'dual', mode: 'write', phase: 'execute' }], 'dual-owner'));
    release(['dual'], 'dual-owner', 'prepare');
    assert.equal(acquire([{ key: 'dual', mode: 'read', phase: 'execute' }], 'reader'), false);
    release(['dual'], 'wrong-owner'); assert.equal(acquire([{ key: 'dual', mode: 'read', phase: 'execute' }], 'reader'), false);
    release(['dual'], 'dual-owner'); assert(acquire([{ key: 'dual', mode: 'read', phase: 'execute' }], 'reader'));
    release(['dual'], 'reader'); release(['free-copy'], 'free-owner');
    assert(store.transact('registry', tx => tx.acquireWorkspace('old-source', 'legacy-owner')));
    const copy = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy'), workspaceId: 'different-source' });
    assert.equal(acquire(copy.resourceLeases, 'copy-owner'), false, 'An unknown legacy holder blocks a different workspace global reader');
    store.transact('registry', tx => tx.releaseWorkspace('old-source', 'wrong-owner'));
    assert.equal(acquire(copy.resourceLeases, 'copy-owner'), false);
    store.transact('registry', tx => tx.releaseWorkspace('old-source', 'legacy-owner'));
    assert(acquire(copy.resourceLeases, 'copy-owner'));
    assert.equal(store.transact('registry', tx => tx.acquireWorkspace('another-old-source', 'new-legacy-owner')), false,
      'Legacy unknown acquisition must respect a new global read holder');
    release(copy.resourceLeases.map(lease => lease.key), 'copy-owner');
    assert(store.transact('registry', tx => tx.acquireWorkspace('another-old-source', 'new-legacy-owner')));
    return { store: sqlite ? 'SQLite' : 'MemoryStore', atomic: true, ownerIsolation: true, phaseIsolation: true, legacyBothDirections: true };
  } finally { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); }
}

function request(f: PartitionResilienceEngineFixture, work: Intent, policy: LocalResourcePolicy): LocalOperation {
  return f.engine!.requestLocal(f.room, f.task, work.id, work.attempt,
    { type: 'runCli', executable: 'node', args: ['read.mjs', f.url(work)] }, [], 'source', policy);
}
function prepare(f: PartitionResilienceEngineFixture, work: Intent, operation: LocalOperation, sessionId = operation.sessionId!) {
  return f.send({ type: 'LOCAL_PREPARED', intentId: work.id, operationId: operation.id, sessionId,
    workspaceRevision: 'a'.repeat(64), isolated: true });
}
function settle(f: PartitionResilienceEngineFixture, work: Intent, operation: LocalOperation) {
  assert(f.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: operation.id, sessionId: operation.sessionId!,
    result: { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: 'controlled settled', truncated: false } }, settled: true, effectsKnown: true }).ok);
}

export function independentResourceEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const works = fixture.pending('assistance').map(work => fixture.start(work));
    const [a, b, writer, sameCopy] = works as [Intent, Intent, Intent, Intent];
    const policyA = resolveLocalResourcePolicy(isolatedPolicyInput('copy-a')),
      policyB = resolveLocalResourcePolicy(isolatedPolicyInput('copy-b'));
    const opA = request(fixture, a, policyA), opB = request(fixture, b, policyB);
    const claimA = fixture.engine!.claimLocal(fixture.room, fixture.task, a.id, opA.id, a.attempt);
    const claimB = fixture.engine!.claimLocal(fixture.room, fixture.task, b.id, opB.id, b.attempt);
    assert(claimA.response.ok && claimB.response.ok, 'Different copies must both claim through SQLite read/read source preparation');
    const writerPolicy = resolveLocalResourcePolicy({ ...isolatedPolicyInput('ignored'), isolatedWork: false });
    const writerOp = request(fixture, writer, writerPolicy);
    const writerClaim = () => fixture.engine!.claimLocal(fixture.room, fixture.task, writer.id, writerOp.id, writer.attempt);
    assert.equal(writerClaim().response.code, 'WORKSPACE_BUSY');
    assert.equal(prepare(fixture, a, claimA.operation!, 'wrong-session').code, 'LOCAL_SESSION_MISMATCH');
    assert.equal(writerClaim().response.code, 'WORKSPACE_BUSY');
    assert(prepare(fixture, a, claimA.operation!).ok);
    assert.equal(writerClaim().response.code, 'WORKSPACE_BUSY', 'The other source preparation owner must remain protected');
    assert(prepare(fixture, b, claimB.operation!).ok);
    assert(fixture.send({ type: 'LOCAL_STARTED', intentId: a.id, operationId: opA.id, sessionId: claimA.operation!.sessionId! }).ok);
    assert(fixture.send({ type: 'LOCAL_STARTED', intentId: b.id, operationId: opB.id, sessionId: claimB.operation!.sessionId! }).ok);
    const sameCopyOp = request(fixture, sameCopy, policyA);
    assert.equal(fixture.engine!.claimLocal(fixture.room, fixture.task, sameCopy.id, sameCopyOp.id, sameCopy.attempt).response.code, 'WORKSPACE_BUSY',
      'Copy execution protection must survive source preparation release');
    const activeWriter = writerClaim(); assert(activeWriter.response.ok, 'Source writer can claim after both source copies are prepared');
    settle(fixture, a, claimA.operation!); settle(fixture, b, claimB.operation!);
    assert.equal(fixture.engine!.claimLocal(fixture.room, fixture.task, sameCopy.id, sameCopyOp.id, sameCopy.attempt).response.code, 'WORKSPACE_BUSY');
    settle(fixture, writer, activeWriter.operation!);
    const afterAll = fixture.engine!.claimLocal(fixture.room, fixture.task, sameCopy.id, sameCopyOp.id, sameCopy.attempt);
    assert(afterAll.response.ok);
    return { concurrentCopies: 2, realStore: 'SQLite', preparationReleasedBeforeCommandSettlement: true,
      sameCopyAndSourceWriterProtected: true, scope: 'Actual Engine and SQLite leases, controlled operation receipts; no OS isolation claim' };
  } finally { fixture.close(); }
}

export function resourceRecoveryEngineAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const works = fixture.pending('assistance').map(work => fixture.start(work));
    const first = works[0]!, second = works[1]!, contender = works[2]!;
    const policy = resolveLocalResourcePolicy(isolatedPolicyInput('copy-a'));
    const original = request(fixture, first, policy);
    const claimed = fixture.engine!.claimLocal(fixture.room, fixture.task, first.id, original.id, first.attempt); assert(claimed.response.ok);
    assert(prepare(fixture, first, claimed.operation!).ok);
    assert(fixture.send({ type: 'LOCAL_STARTED', intentId: first.id, operationId: original.id, sessionId: claimed.operation!.sessionId! }).ok);
    fixture.reopen(); fixture.reopen();
    const old = fixture.context.intents.find(work => work.id === first.id)!.localOperations!.find(operation => operation.id === original.id)!;
    assert.equal(old.status, 'uncertain'); assert(old.preparedAt !== undefined);
    const resumed = fixture.start(fixture.pending('assistance').find(work => work.id === contender.id)!);
    const competing = request(fixture, resumed, policy);
    assert.equal(fixture.engine!.claimLocal(fixture.room, fixture.task, resumed.id, competing.id, resumed.attempt).response.code, 'WORKSPACE_BUSY');
    const freeMember = fixture.start(fixture.pending('assistance').find(work => work.id === second.id)!);
    const independentPolicy = resolveLocalResourcePolicy(isolatedPolicyInput('copy-b'));
    const independent = request(fixture, freeMember, independentPolicy);
    const parallel = fixture.engine!.claimLocal(fixture.room, fixture.task, freeMember.id, independent.id, freeMember.attempt); assert(parallel.response.ok);
    return { unknownPreservedAcrossReopen: true, sameCopyBlocked: true, independentCopyClaimed: true };
  } finally { fixture.close(); }
}

export function conservativeResourceEngineAcceptance(boundary: string) {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const [first, second] = fixture.pending('assistance').slice(0, 2).map(work => fixture.start(work)) as [Intent, Intent];
    const input = isolatedPolicyInput('copy-a');
    if (boundary === '宿主命令') input.execution = 'host';
    else if (boundary === '可用但未声明实际隔离的后端') input.sandboxConfinesWorkspace = false;
    else if (boundary === '直接修改权威源工作区') input.isolatedWork = false;
    else assert.equal(boundary, '旧快照未声明隔离');
    const action = { type: 'runCli' as const, executable: 'node', args: ['read.mjs'], ...(input.execution === 'host' ? { execution: 'host' as const, reason: 'Explicit test host preparation' } : {}) };
    const legacy = boundary === '旧快照未声明隔离';
    const a = fixture.engine!.requestLocal(fixture.room, fixture.task, first.id, first.attempt, action, [], legacy ? 'old-source' : 'source',
      legacy ? undefined : resolveLocalResourcePolicy(input));
    const claimed = fixture.engine!.claimLocal(fixture.room, fixture.task, first.id, a.id, first.attempt); assert(claimed.response.ok);
    const policyB = resolveLocalResourcePolicy(legacy ? { ...isolatedPolicyInput('copy-b'), workspaceId: 'different-source' } : { ...input, copyId: 'copy-b' });
    const b = fixture.engine!.requestLocal(fixture.room, fixture.task, second.id, second.attempt, action, [], legacy ? 'different-source' : 'source', policyB);
    assert.equal(fixture.engine!.claimLocal(fixture.room, fixture.task, second.id, b.id, second.attempt).response.code, 'WORKSPACE_BUSY');
    settle(fixture, first, claimed.operation!);
    assert(fixture.engine!.claimLocal(fixture.room, fixture.task, second.id, b.id, second.attempt).response.ok);
    return { boundary, secondWaitedForConfirmedSettlement: true, scope: 'Actual SQLite/Engine contention; no backend execution or OS confinement claim' };
  } finally { fixture.close(); }
}
