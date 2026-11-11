import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
export async function hostRetryDriver(root, backend, mode = 0) {
  const { TeamEngine, MemoryStore, SqliteStore } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
  const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href);
  const directory = mkdtempSync(join(tmpdir(), 'host-retry-formal-'));
  const file = join(directory, 'store.sqlite');
  const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
  config.limits.ordinary = 40; config.limits.checks = 5; config.limits.workTimeoutMs = 1000;
  let store = backend === 'sqlite' ? new SqliteStore(file) : new MemoryStore();
  let now = 1, sequence = 0, online = true, recovered = false;
  let engine = new TeamEngine(store, config, () => now);
  const room = 'formal-host-retry', task = 'task:start';
  const c = () => engine.view(room, task).context;
  const send = body => engine.send(room, task, { id: `formal:${++sequence}`, at: now, ...body });
  assert(engine.submit(room, { id: 'start', text: '核查两条命令' }).ok);
  const source = engine.claim(room, task, engine.pending(room, task)[0].id); assert(source);
  const sourceOps = [];
  for (const name of ['first', 'second']) {
    const op = engine.requestLocal(room, task, source.id, source.attempt, { type: 'runCli', executable: 'node', args: [name] }, [], 'formal-project');
    const claim = engine.claimLocal(room, task, source.id, op.id, source.attempt); assert(claim.response.ok);
    assert(send({ type: 'LOCAL_RESULT', intentId: source.id, operationId: op.id, sessionId: claim.operation.sessionId,
      result: { ok: false, code: 'failed', data: { execution: 'sandbox', exitCode: 1 } }, settled: true, effectsKnown: true }).ok);
    sourceOps.push(c().intents.find(w => w.id === source.id).localOperations.find(o => o.id === op.id));
  }
  assert(engine.requestHostRetry(room, task, source.id, sourceOps[0].id, sourceOps[0].requestHash, 'retry:first').ok);
  assert(send({ type: 'DELIVER', workId: source.id, attempt: source.attempt, fence: source, text: '保存已有候选', artifactIds: [] }).ok);
  const oldBatch = c().hostRetryBatch.id;
  let oldWork = engine.claim(room, task, c().hostRetryBatch.workId); assert(oldWork);
  const oldOperationId = c().intents.find(w => w.id === oldWork.id).localOperations[0].id;
  now = 2;
  assert(engine.requestHostRetry(room, task, source.id, sourceOps[1].id, sourceOps[1].requestHash, 'retry:second').ok);
  const work = () => c().intents.find(w => w.id === oldWork.id);
  const op = () => work().localOperations.find(o => o.id === oldOperationId);
  const local = (type, fields = {}) => send({ type, intentId: oldWork.id, operationId: oldOperationId, sessionId: op().sessionId, ...fields });
  if (mode > 0) {
    const claim = engine.claimLocal(room, task, oldWork.id, oldOperationId, work().attempt); assert(claim.response.ok);
    if (mode === 2) {
      const approval = { id: 'formal-approval', digest: 'd'.repeat(64), status: 'pending', expiresAt: 999,
        plan: { executable: '/usr/bin/node', args: op().action.args, cwd: '/task', workspaceRevision: 'b'.repeat(64), executableHash: 'c'.repeat(64), environmentHash: 'e'.repeat(64), host: 'host', account: 'account', reason: op().action.reason } };
      assert(local('LOCAL_APPROVAL_REQUIRED', { approval, fence: work() }).ok);
      assert(local('LOCAL_APPROVAL_DECISION', { approvalId: approval.id, decision: 'deny', fence: work() }).ok);
    } else {
      assert(local('LOCAL_RESULT', { result: { ok: mode === 1, code: mode === 1 ? 'succeeded' : 'cancelled', data: { execution: 'host', stdout: 'fixed-receipt' } }, settled: mode === 1, effectsKnown: mode === 1 }).ok);
    }
  }
  const savedCandidate = JSON.stringify(c().candidate);
  const receipt = op().finishedAt === undefined ? null : JSON.stringify(op().result);
  function observe() {
    const value = c();
    assert.equal(value.sourceArtifact, undefined, 'Scope:no source revision');
    assert.equal(value.discussion, undefined, 'Scope:no discussion');
    assert.equal(value.review, undefined, 'Scope:no review');
    assert.equal(value.hostRetryRequests.length, 2, 'UniqueSourceRequest: duplicate source request');
    const batch = value.hostRetryBatch?.id === oldBatch ? 1 : value.hostRetryBatch ? 2 : 0;
    const retirement = value.trace.filter(e => e.event === 'HOST_RETRY_BATCH_RETIRED' && JSON.parse(e.detail).batchId === oldBatch).length;
    const successors = value.intents.flatMap(w => w.localOperations ?? []).filter(o => o.hostRetryOf === sourceOps[1].id).length;
    if (op().status === 'uncertain') assert(batch === 1 && retirement === 0 && successors === 0, 'NoUnknownAdvance: uncertain effects lost their batch barrier');
    assert(retirement <= 1, 'UniqueRetirement: duplicate old-batch retirement');
    assert(successors <= 1, 'UniqueSuccessor: duplicate next source operation');
    assert.equal(JSON.stringify(value.candidate), savedCandidate, 'PreserveCandidate: retirement replaced candidate');
    if (receipt !== null) assert.equal(JSON.stringify(op().result), receipt, 'PreserveReceipt: changed a known operation receipt');
    return { mode, stage: ['queued', 'succeeded', 'failed', 'uncertain', 'cancelled'].indexOf(op().status),
      parent: ['inflight', 'uncertain', 'pending', 'done', 'cancelled'].indexOf(work().status), batch, retirement, successors,
      request: ['active', 'settled', 'uncertain', 'cancelled', 'expired'].indexOf(value.hostRetryRequests[0].status),
      online, recovered, expired: now > 2 };
  }
  function recoverySlice() {
    const value=c();
    assert.equal(Object.keys(store.read(room).tasks).length,1,'Scope:one original task');
    assert.equal(value.results.length,0,'Scope:no result flush transactions');
    assert(value.nextCheckAt>now,'Scope:tick not due');
    assert(value.intents.every(w=>w.deadline===null||w.deadline>now),'Scope:no work deadline sweep');
    assert(value.hostRetryRequests.every(r=>r.deadline>now),'Scope:no retry expiry sweep');
  }
  function apply(action) {
    if (action === 'Crash') { online = false; }
    else if (action === 'Reopen') {
      recoverySlice();
      if (backend === 'sqlite') { store.close(); store = new SqliteStore(file); }
      engine = new TeamEngine(store, config, () => now); engine.recover(room); online = true; recovered = true;
    } else if (action === 'Reconcile') {
      assert(local('LOCAL_RECONCILE', { resolution: 'receipt', result: { ok: true, code: 'succeeded', data: { execution: 'host', stdout: 'fixed-receipt' } }, detail: 'matching settled receipt' }).ok);
    } else if (action === 'ClaimParent') { oldWork = engine.claim(room, task, oldWork.id); assert(oldWork); }
    else if (action === 'DeniedEnd') { assert.equal(send({ type: 'SETTLE', intentId: oldWork.id }).ok, false); }
    else if (action === 'EndOwner') { assert(send({ type: 'SETTLE', intentId: oldWork.id }).ok); }
    else if (action === 'RejectOwner') {
      const expected = work().deadline !== null && now >= work().deadline ? 'WORK_EXPIRED' : 'SELF_DEPENDENCY';
      const saved = structuredClone({ candidate: c().candidate, artifacts: c().artifacts, assists: c().assists, receipt: op().result });
      const result = send({ type: 'HELP', workId: oldWork.id, fence: work(), caller: work().target, target: work().target,
        requestId: 'self-help', question: '核对', expected: '证据' });
      assert.equal(result.ok, false); assert.equal(result.code, expected);
      assert.deepEqual({ candidate: c().candidate, artifacts: c().artifacts, assists: c().assists, receipt: op().result }, saved,
        'Rejected HELP cannot create assistance or change the saved candidate, artifacts or original receipt');
    }
    else if (action === 'Expire') { now = c().hostRetryRequests[0].deadline; }
    else if (action === 'Sweep') { recoverySlice(); engine.tick(room); }
    else if (action === 'Duplicate') { assert(engine.requestHostRetry(room, task, source.id, sourceOps[0].id, sourceOps[0].requestHash, `retry:first:duplicate:${++sequence}`).ok); }
    else throw Error(`Unknown host retry action: ${action}`);
    return observe();
  }
  return { observe, apply, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
