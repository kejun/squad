import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { canAcquireResourceLeases, localExecutionLeases, localResourceLeasesConflict, resolveLocalResourcePolicy,
  unconfinedEffectsKey, type LocalResourcePolicy, type LocalResourcePolicyInput, type ResourceLeaseRow } from '../src/local-resource-policy.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';
import { heldLocalResourceLeases } from '../src/local-operation.js';
import type { Intent } from '../src/types.js';

export const isolatedPolicyInput = (copyId: string): LocalResourcePolicyInput => ({ workspaceId: 'source', copyId,
  isolatedWork: true, execution: 'sandbox', sandboxConfinesWorkspace: true, action: 'runCli' });

function requestModelOperation(model: ResilientPartitionModel, work: Intent, id: string, policy?: LocalResourcePolicy) {
  assert(model.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: id, namespace: 'c'.repeat(64),
    requestHash: 'a'.repeat(64), action: { type: 'runCli', executable: 'node', args: ['read.mjs', model.url(work)] },
    parentAttempt: work.attempt, workspaceId: 'source', messages: [], fence: work,
    ...(policy ? { conflictKey: policy.conflictKey, resourceLeases: policy.resourceLeases } : {}) }).ok);
}
function claimModelOperation(model: ResilientPartitionModel, work: Intent, id: string, leaseAvailable: boolean) {
  return model.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: id, sessionId: `session:${id}`,
    parentAttempt: work.attempt, leaseAvailable, fence: work });
}

export function isolatedPolicyGate() {
  const a = resolveLocalResourcePolicy(isolatedPolicyInput('copy-a')), b = resolveLocalResourcePolicy(isolatedPolicyInput('copy-b'));
  assert.equal(a.conflictKey, 'copy-a'); assert.equal(a.preparationKey, 'source');
  assert.equal(localResourceLeasesConflict(a.resourceLeases, b.resourceLeases), false);
  assert.equal(localResourceLeasesConflict(a.resourceLeases, a.resourceLeases), true);
  const model = new ResilientPartitionModel(), works = model.pending('assistance').slice(0, 2).map(work => model.start(work));
  requestModelOperation(model, works[0]!, 'copy-a-op', a); requestModelOperation(model, works[1]!, 'copy-b-op', b);
  const rows: ResourceLeaseRow[] = a.resourceLeases.map(lease => ({ ...lease, owner: 'a' }));
  assert(claimModelOperation(model, works[0]!, 'copy-a-op', canAcquireResourceLeases([], a.resourceLeases, 'a')).ok);
  assert(claimModelOperation(model, works[1]!, 'copy-b-op', canAcquireResourceLeases(rows, b.resourceLeases, 'b')).ok);
  assert.equal(model.context.intents.flatMap(work => work.localOperations ?? []).filter(op => op.status === 'claimed').length, 2);
  return { a, b, model };
}

export function conservativePolicyGate(boundary: string) {
  const input = isolatedPolicyInput('copy-a');
  if (boundary === '宿主命令') input.execution = 'host';
  else if (boundary === '可用但未声明实际隔离的后端') input.sandboxConfinesWorkspace = false;
  else if (boundary === '直接修改权威源工作区') input.isolatedWork = false;
  else if (boundary === '旧快照未声明隔离') input.sandboxConfinesWorkspace = false;
  else assert.fail(`Unknown execution boundary: ${boundary}`);
  const a = resolveLocalResourcePolicy(input), b = resolveLocalResourcePolicy({ ...input, copyId: 'copy-b' });
  assert.equal(a.conflictKey, 'source'); assert.equal(localResourceLeasesConflict(a.resourceLeases, b.resourceLeases), true);
  const model = new ResilientPartitionModel(), works = model.pending('assistance').slice(0, 2).map(work => model.start(work));
  requestModelOperation(model, works[0]!, 'shared-a'); requestModelOperation(model, works[1]!, 'shared-b');
  assert(claimModelOperation(model, works[0]!, 'shared-a', true).ok);
  const before = structuredClone(model.context.usage);
  const leaseAvailable = canAcquireResourceLeases(a.resourceLeases.map(lease => ({ ...lease, owner: 'a' })), b.resourceLeases, 'b');
  assert.equal(claimModelOperation(model, works[1]!, 'shared-b', leaseAvailable).code, 'WORKSPACE_BUSY');
  assert.deepEqual(model.context.usage, before);
  assert.equal(model.context.intents.find(work => work.id === works[1]!.id)!.localOperations![0]!.status, 'queued');
  return { a, b, model };
}

export function preparationReleasePolicyGate() {
  const copy = resolveLocalResourcePolicy(isolatedPolicyInput('copy-a'));
  const sourceWrite = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy-b'), isolatedWork: false });
  assert(localResourceLeasesConflict(copy.resourceLeases, sourceWrite.resourceLeases));
  const executing = localExecutionLeases(copy.resourceLeases);
  assert.equal(localResourceLeasesConflict(executing, sourceWrite.resourceLeases), false);
  assert(executing.some(lease => lease.key === 'copy-a' && lease.mode === 'write'));
  assert(executing.some(lease => lease.key === unconfinedEffectsKey && lease.mode === 'read'));
  const repeatedKey = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy-a'), sharedResources: [{ key: 'source', mode: 'write' }] });
  assert.equal(repeatedKey.resourceLeases.filter(lease => lease.key === 'source').length, 2);
  assert(localExecutionLeases(repeatedKey.resourceLeases).some(lease => lease.key === 'source' && lease.mode === 'write'));
  return { copy, sourceWrite, executing };
}

export function readonlyVerificationPolicyGate() {
  const a = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy-a'), action: 'verifyWorkspace' });
  const b = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy-b'), action: 'verifyWorkspace' });
  const writer = resolveLocalResourcePolicy({ ...isolatedPolicyInput('copy-c'), isolatedWork: false });
  assert.equal(localResourceLeasesConflict(a.resourceLeases, b.resourceLeases), false);
  assert(localResourceLeasesConflict(a.resourceLeases, writer.resourceLeases));
  assert.deepEqual(localExecutionLeases(a.resourceLeases), a.resourceLeases);
  return { a, b, writer };
}

export function resourceRegistryPolicyGate() {
  const reader = { key: 'source', mode: 'read' as const, phase: 'execute' as const };
  const writer = { key: 'source', mode: 'write' as const, phase: 'execute' as const };
  const rows: ResourceLeaseRow[] = [{ ...reader, owner: 'reader-a' }];
  assert(canAcquireResourceLeases(rows, [reader], 'reader-b'));
  assert.equal(canAcquireResourceLeases(rows, [writer], 'writer'), false);
  assert.equal(canAcquireResourceLeases(rows, [{ key: 'free-copy', mode: 'write', phase: 'execute' }, writer], 'writer'), false);
  assert.deepEqual(rows, [{ key: 'source', mode: 'read', phase: 'execute', owner: 'reader-a' }]);
  assert(canAcquireResourceLeases(rows, [writer], 'reader-a'));
  assert.equal(canAcquireResourceLeases([], [reader], 'new-reader', [{ key: 'source', owner: 'legacy-unknown' }]), false);
  assert.equal(canAcquireResourceLeases([], [writer], 'new-writer', [{ key: 'source', owner: 'legacy-unknown' }]), false);
  const unrelatedCopy = resolveLocalResourcePolicy({ ...isolatedPolicyInput('new-copy'), workspaceId: 'unrelated-source' });
  assert.equal(canAcquireResourceLeases([], unrelatedCopy.resourceLeases, 'new-copy-owner', [{ key: 'old-source', owner: 'legacy-unknown' }]), false,
    'Unknown legacy confinement must block a new global reader even across different workspace IDs');
  const host = resolveLocalResourcePolicy({ ...isolatedPolicyInput('host-copy'), execution: 'host', workspaceId: 'different-source' });
  assert(localResourceLeasesConflict(resolveLocalResourcePolicy(isolatedPolicyInput('sandbox-copy')).resourceLeases, host.resourceLeases));
  return { rows, legacyProtected: true };
}

export function preparedReceiptModelGate(boundary = '成功') {
  const { model, a, b } = isolatedPolicyGate();
  const works = model.context.intents.filter(work => work.kind === 'assistance' && work.status === 'inflight');
  const first = works.find(work => work.localOperations?.some(operation => operation.id === 'copy-a-op'))!;
  const second = works.find(work => work.localOperations?.some(operation => operation.id === 'copy-b-op'))!;
  const op = () => model.context.intents.find(work => work.id === first.id)!.localOperations!.find(operation => operation.id === 'copy-a-op')!;
  const other = () => model.context.intents.find(work => work.id === second.id)!.localOperations!.find(operation => operation.id === 'copy-b-op')!;
  const initialHeld = structuredClone(heldLocalResourceLeases(op())), otherHeld = structuredClone(heldLocalResourceLeases(other()));
  const prepared = { type: 'LOCAL_PREPARED' as const, intentId: first.id, operationId: 'copy-a-op',
    sessionId: boundary === '会话不匹配' ? 'wrong-session' : 'session:copy-a-op', workspaceRevision: 'a'.repeat(64), isolated: true };
  assert.equal(model.send({ type: 'LOCAL_STARTED', intentId: first.id, operationId: 'copy-a-op', sessionId: 'session:copy-a-op' }).code,
    'LOCAL_PREPARATION_REQUIRED');
  if (boundary === '用户已停止') assert(model.send({ type: 'STOP' }).ok);
  if (boundary === '已过截止时间') model.sequence = first.deadline!;
  const result = model.send(prepared);
  if (boundary !== '成功') {
    assert.equal(result.code, boundary === '会话不匹配' ? 'LOCAL_SESSION_MISMATCH' : boundary === '用户已停止' ? 'STOPPED' : 'WORK_EXPIRED');
    assert.deepEqual(heldLocalResourceLeases(op()), initialHeld);
  } else {
    assert(result.ok);
    assert.deepEqual(heldLocalResourceLeases(op()), localExecutionLeases(a.resourceLeases));
    assert.deepEqual(heldLocalResourceLeases(other()), otherHeld, 'Preparation receipt must not release another owner');
    assert.equal(model.send(prepared).code, 'LOCAL_PREPARATION_NOT_EXPECTED');
    const writer = resolveLocalResourcePolicy({ ...isolatedPolicyInput('writer'), isolatedWork: false });
    const heldRows = [...heldLocalResourceLeases(op()).map(lease => ({ ...lease, owner: 'a' })),
      ...heldLocalResourceLeases(other()).map(lease => ({ ...lease, owner: 'b' }))];
    assert.equal(canAcquireResourceLeases(heldRows, writer.resourceLeases, 'writer'), false,
      'The other copy still owns its source preparation read');
    assert(model.send({ ...prepared, intentId: second.id, operationId: 'copy-b-op', sessionId: 'session:copy-b-op' }).ok);
    const afterBoth = [...heldLocalResourceLeases(op()).map(lease => ({ ...lease, owner: 'a' })),
      ...heldLocalResourceLeases(other()).map(lease => ({ ...lease, owner: 'b' }))];
    assert(canAcquireResourceLeases(afterBoth, writer.resourceLeases, 'writer'));
    assert(model.send({ type: 'LOCAL_STARTED', intentId: first.id, operationId: 'copy-a-op', sessionId: 'session:copy-a-op' }).ok);
  }
  return { model, result, a, b };
}

export function localResourcePolicyModelGate() {
  isolatedPolicyGate();
  for (const boundary of ['宿主命令', '可用但未声明实际隔离的后端', '直接修改权威源工作区']) conservativePolicyGate(boundary);
  preparationReleasePolicyGate(); readonlyVerificationPolicyGate(); resourceRegistryPolicyGate();
  for (const boundary of ['成功', '会话不匹配', '用户已停止', '已过截止时间']) preparedReceiptModelGate(boundary);
  return { paths: 11, model: 'real taskMachine plus pure host conflict policy', persistence: 'each public event',
    scope: 'No backend availability or synthetic receipt is treated as OS isolation proof' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(localResourcePolicyModelGate()));
