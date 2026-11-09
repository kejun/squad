import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine, MemoryStore, SqliteStore } from '../src/index.js';
import { localModelInput } from './local-model-fixture.js';

/** Public, reachable prefix; no store snapshot rewrite and no actual CLI process. */
export function authorityCompositionFixture(backend: string) {
  const area = mkdtempSync(join(tmpdir(), 'authority-composition-')); const file = join(area, 'state.sqlite');
  const config = localModelInput().config; config.limits.ordinary = 30;
  let store = backend === 'sqlite' ? new SqliteStore(file) : new MemoryStore();
  let engine = new TeamEngine(store, config, () => 1); let sequence = 0;
  const room = 'authority-composition', task = 'task:begin';
  assert(engine.submit(room, { id: 'begin', text: '验证宿主授权组合' }).ok);
  let work = engine.claim(room, task, engine.pending(room, task)[0]!.id)!; assert(work);
  const oldWork = structuredClone(work); assert(engine.beginExecution(room, task, oldWork));
  const operation = engine.requestLocal(room, task, work.id, work.attempt, { type: 'runCli', executable: 'node', args: [], execution: 'host', reason: 'composition' }, [], 'workspace');
  const preparation = engine.claimLocal(room, task, work.id, operation.id, work.attempt); assert(preparation.response.ok);
  const oldSession = preparation.operation!.sessionId!;
  const send = (body: Record<string, unknown>) => engine.send(room, task, { id: `event:${++sequence}`, at: 1, ...body } as never);
  assert(send({ type: 'LOCAL_APPROVAL_REQUIRED', intentId: work.id, operationId: operation.id, sessionId: oldSession, fence: work,
    approval: { id: 'approval:0', digest: 'd'.repeat(64), status: 'pending', expiresAt: 900,
      plan: { executable: '/bin/node', args: [], cwd: '/workspace', workspaceRevision: 'a'.repeat(64), executableHash: 'b'.repeat(64), environmentHash: 'c'.repeat(64), host: 'host', account: 'account', reason: 'composition' } } }).ok);
  const approvals = ['approval:0']; let revoked = false, recovered = false, initialApproved = false;
  const context = () => engine.view(room, task)!.context;
  const currentWork = () => context().intents.find(item => item.id === work.id)!;
  const current = () => currentWork().localOperations!.find(item => item.id === operation.id)!;
  const relevant = () => ({ work: currentWork(), grant: context().hostSession, permits: [engine.executionPhase(room, task, oldWork),
    engine.executionPhase(room, task, { id: work.id, attempt: 2 })], usage: context().usage, candidate: context().candidate });
  function unchanged(before: unknown, property: string) { assert.deepEqual(relevant(), before, property); }
  const decide = (approvalId: string, commandId: string) => engine.decideHostApproval(room, task, work.id, operation.id, approvalId, 'approveSession', commandId);
  const recordApproval = () => { const id = current().approval!.id; assert(!approvals.includes(id), 'FreshApprovalIdentity'); approvals.push(id); };
  function observe() {
    const c = context(), op = current(), parent = currentWork();
    assert.equal(c.discussion, undefined); assert.equal(c.hostRetryBatch, undefined); assert.equal(c.sourceArtifact, undefined);
    assert(!c.intents.some(item => item.discussionId || item.kind === 'check' || item.kind === 'interpretation'));
    const stage = ['awaitingApproval', 'queued', 'claimed', 'running'].indexOf(op.status); assert(stage >= 0);
    assert.equal(!!c.hostSession, stage > 0, 'SessionRevocation: only current approved stages retain a grant');
    return { attempt: parent.attempt, stage, approval: approvals.indexOf(op.approval!.id), revoked, recovered,
      parentPending: parent.status === 'pending', permit2: engine.executionPhase(room, task, { id: work.id, attempt: 2 }) === 'running',
      initialApproved, starts: c.trace.filter(item => item.event === 'LOCAL_STARTED' && item.detail.startsWith('event:')).length };
  }
  function apply(action: string) {
    switch (action) {
      case 'Approve': {
        const revision = approvals.indexOf(current().approval!.id);
        assert(decide(current().approval!.id, `approve:${revision}`).ok, 'FreshApprovalProgress');
        if (revision === 0) initialApproved = true;
        break;
      }
      case 'Revoke': assert(engine.revokeHostSession(room, task, context().hostSession!.id, `revoke:${++sequence}`).ok); revoked = true; recordApproval(); assert.equal(context().hostSession, undefined, 'SessionRevocation'); break;
      case 'Recover':
        if (backend === 'sqlite') { store.close(); store = new SqliteStore(file); }
        engine = new TeamEngine(store, config, () => 1); engine.recover(room); recovered = true; recordApproval();
        assert.equal(context().hostSession, undefined, 'SessionRevocation'); break;
      case 'ReclaimParent': work = engine.claim(room, task, work.id)!; assert(work && work.attempt === 2, 'FreshAttemptProgress'); break;
      case 'NewPermit': assert(engine.beginExecution(room, task, work), 'FreshPermitProgress'); break;
      case 'Claim': { const result = engine.claimLocal(room, task, work.id, operation.id, work.attempt); assert(result.response.ok, 'FreshClaimProgress'); break; }
      case 'Start': assert(send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: operation.id, sessionId: current().sessionId }).ok, 'FreshStartProgress'); break;
      case 'LateDecision': { const before = relevant(); assert.equal(decide(approvals[0]!, `late-decision:${++sequence}`).ok, false, 'OldApprovalIsolation'); unchanged(before, 'OldApprovalIsolation'); break; }
      case 'LateClaim': { const before = relevant(); assert.equal(engine.claimLocal(room, task, work.id, operation.id, 1).response.ok, false, 'OldParentIsolation'); unchanged(before, 'OldParentIsolation'); break; }
      case 'ReplayDecision': { const before = relevant(); assert(decide(approvals[0]!, 'approve:0').ok, 'SuccessfulCommandReceipt: an exact old command may return its saved success'); unchanged(before, 'CommandReceiptNoNewEffect'); break; }
      case 'OldPermit': { const before = relevant(); assert.equal(engine.beginExecution(room, task, oldWork), false, 'OldPermitIsolation'); unchanged(before, 'OldPermitIsolation'); break; }
      case 'DuplicatePermit': { const before = relevant(); assert.equal(engine.beginExecution(room, task, work), false, 'OneUsePermit'); unchanged(before, 'OneUsePermit'); break; }
      case 'LateStart': { const before = relevant(); assert.equal(send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: operation.id, sessionId: oldSession }).ok, false, 'OldSessionIsolation'); unchanged(before, 'OldSessionIsolation'); break; }
      default: throw new Error(`Unknown authority composition action: ${action}`);
    }
    observe();
  }
  return { observe, apply, close() { store.close(); rmSync(area, { recursive: true, force: true }); } };
}

const sequences = {
  撤销再批准: ['Approve', 'Revoke', 'ReplayDecision', 'LateDecision', 'Approve', 'Claim', 'LateStart', 'Start'],
  恢复后新轮次: ['Approve', 'Recover', 'ReplayDecision', 'LateDecision', 'Approve', 'ReclaimParent', 'OldPermit', 'NewPermit', 'DuplicatePermit', 'LateClaim', 'Claim', 'LateStart', 'Start'],
  恢复后再撤销: ['Recover', 'Approve', 'ReclaimParent', 'NewPermit', 'Revoke', 'LateDecision', 'Approve', 'LateClaim', 'OldPermit', 'DuplicatePermit', 'Claim', 'Start'],
} as const;
export type AuthorityCompositionCase = keyof typeof sequences;
export function authorityCompositionSequence(scenario: AuthorityCompositionCase) {
  assert(Object.hasOwn(sequences, scenario));
  return ['memory', 'sqlite'].map(backend => {
    const fixture = authorityCompositionFixture(backend);
    try {
      for (const action of sequences[scenario]) fixture.apply(action);
      const final = fixture.observe(); assert.equal(final.stage, 3); assert.equal(final.starts, 1);
      assert.equal(final.attempt, scenario === '撤销再批准' ? 1 : 2);
      return { backend, actions: [...sequences[scenario]], final, status: 'passed' };
    } finally { fixture.close(); }
  });
}
