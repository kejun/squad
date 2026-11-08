import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Finite implementation examples. They reuse replay.mjs's public prefix and do
// not add a state or edge to Shards.tla. No adapter or process is executed.
export function discussionRecoveryProbes(make, backend, directory) {
  const reports = [];
  function example(name, kind, body, fixture = 'public-entry-history') {
    const path = join(directory, `${backend}-discussion-${name}`); mkdirSync(path);
    const driver = make(backend, path, kind);
    try {
      body(driver);
      reports.push({ family: 'discussion-recovery', backend, name, fixture, verified: true });
    } finally { driver.close(); rmSync(path, { recursive: true, force: true }); }
  }
  const claimPair = driver => { driver.apply('Claim1'); driver.apply('Claim2'); };
  const cancel = (driver, change = 'goal') => driver.apply(change === 'stop' ? 'Stop' : 'ChangeGoal');
  const retired = driver => assert([driver.work(1), driver.work(2)].every(work => ['done', 'cancelled'].includes(work.status)),
    'CancelledRecovery: obsolete safe discussion work must settle, never requeue');
  function recoverTwice(driver) {
    const s = driver.session, usage = structuredClone(s.context().usage);
    s.reopen(); s.reopen();
    assert.deepEqual(s.context().usage, usage, 'CancelledRecovery: recovery must preserve all prior charges');
    assert.equal(driver.summary(), undefined, 'CancelledRecovery: an abandoned round must not schedule a reducer');
  }
  for (const kind of ['map', 'discussion']) for (const change of ['goal', 'stop']) {
    example(`${kind}-${change}`, kind, driver => {
      claimPair(driver); const old = structuredClone(driver.work(1)); cancel(driver, change);
      assert.equal(driver.work(1).status, 'inflight', 'CancelledRecovery: sending cancel is not physical settlement');
      recoverTwice(driver); retired(driver);
      const s = driver.session;
      if (change === 'stop') assert(s.send({ type: 'CONTINUE' }).ok);
      const owner = s.context().intents.find(w => w.kind === 'owner' && w.status === 'pending');
      assert(owner && s.engine().claim(s.room, s.task, owner.id), 'CancelledRecovery: the current owner must remain executable');
      const targets = [old.target, driver.work(2).target];
      assert(s.send({ type: 'USER_INPUT', text: '请成员重新核对', reviewTargets: targets }).ok);
      assert.deepEqual(s.context().discussion.targets, targets, 'CancelledRecovery: retired work must not occupy its old members');
      const planner = s.context().intents.find(w => w.kind === 'facilitator' && w.status === 'pending');
      const ticket = s.engine().claim(s.room, s.task, planner.id); assert(ticket);
      assert(s.send({ type: 'DISCUSSION_PLAN', workId: ticket.id, attempt: ticket.attempt, fence: ticket, discussionId: ticket.discussionId,
        decision: { action: 'review', question: '重新核对', expected: '当前依据', reason: '当前目标邀请' } }).ok);
      const current = s.context().intents.filter(w => w.discussionId === s.context().discussion.id && w.kind === 'assistance');
      assert.equal(current.length, 2, 'CancelledRecovery: all freed members must receive current work');
      for (const work of current) assert(s.engine().claim(s.room, s.task, work.id), 'CancelledRecovery: the new work must be claimable');
      const before = structuredClone(s.context().discussion), usage = structuredClone(s.context().usage);
      assert.equal(s.send(driver.result(old)).ok, false, 'CancelledRecovery: the old reply must be rejected');
      assert.deepEqual(s.context().discussion, before, 'CancelledRecovery: an old reply must not change the current round');
      assert.deepEqual(s.context().usage, usage);
    });
  }
  example('active-safe', 'map', driver => {
    driver.apply('Claim1'); driver.session.reopen();
    assert.equal(driver.work(1).status, 'pending', 'ActiveDiscussionRecovery: current safe work must remain resumable');
    assert.equal(driver.session.context().discussion.status, 'collecting', 'ActiveDiscussionRecovery: recovery must retain the current round');
    assert(driver.session.engine().claim(driver.session.room, driver.session.task, driver.work(1).id),
      'ActiveDiscussionRecovery: current safe work must be claimable again');
  });
  example('historical-pending', 'map', driver => {
    claimPair(driver); cancel(driver);
    for (const work of [driver.work(1), driver.work(2)]) driver.session.rewriteSavedWork(work.id, old => { old.status = 'pending'; });
    recoverTwice(driver); retired(driver);
  }, 'old-format-regression-snapshot: public cancelled prefix with pre-KEJ-106 recovery status');
  example('removed-member', 'map', driver => {
    claimPair(driver); cancel(driver);
    const s = driver.session, removed = driver.work(1).target;
    s.config.bots = s.config.bots.filter(bot => bot.id !== removed); s.reopen();
    assert(!s.context().reason.includes('unavailable'), 'ObsoleteMemberRecovery: retired safe work must not invalidate current configuration');
    retired(driver);
    assert(s.context().intents.some(w => w.kind === 'owner' && w.status === 'pending'), 'ObsoleteMemberRecovery: current owner remains scheduled');
  });
  function local(driver, stage) {
    claimPair(driver);
    const s = driver.session, work = driver.work(1);
    const op = s.engine().requestLocal(s.room, s.task, work.id, work.attempt,
      { type: 'runCli', executable: 'node', args: ['--version'] }, [], 'workspace:formal-discussion');
    const claim = s.engine().claimLocal(s.room, s.task, work.id, op.id, work.attempt); assert(claim.response.ok);
    const identity = { intentId: work.id, operationId: op.id, sessionId: claim.operation.sessionId };
    if (stage !== 'claimed') assert(s.send({ type: 'LOCAL_STARTED', ...identity, workspaceRevision: 'formal-revision', isolated: true }).ok);
    if (stage === 'unknown') assert(s.send({ type: 'LOCAL_RESULT', ...identity,
      result: { ok: false, code: 'cancelled', data: {} }, settled: true, effectsKnown: false }).ok);
    return identity;
  }
  for (const stage of ['claimed', 'started', 'unknown']) example(`physical-${stage}`, 'map', driver => {
    const identity = local(driver, stage); cancel(driver); driver.session.reopen(); driver.session.reopen();
    assert.equal(driver.work(1).status, 'uncertain', 'PhysicalRetention: unknown effects must retain the member');
    assert.equal(driver.work(1).localOperations.find(op => op.id === identity.operationId).status, 'uncertain', 'PhysicalRetention: local operation must remain uncertain');
    assert(!driver.session.engine().pending(driver.session.room, driver.session.task).some(work => work.kind !== 'cancel' && work.target === driver.work(1).target),
      'PhysicalRetention: the occupied member must not receive new physical work');
  });
  for (const entry of ['LOCAL_RESULT', 'LOCAL_RECONCILE']) example(`known-${entry}`, 'map', driver => {
    const identity = local(driver, 'started'), s = driver.session;
    assert(s.send({ type: 'EXHAUSTED', reason: '任务结束，保留待核对效果' }).ok);
    if (entry === 'LOCAL_RECONCILE') {
      assert(s.send({ type: 'LOCAL_RESULT', ...identity, result: { ok: false, code: 'cancelled', data: {} },
        settled: true, effectsKnown: false }).ok);
      s.reopen(); // Ended tasks are not automatically RECOVERed; the unknown receipt persists.
    }
    const receipt = { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: 'known effects' } };
    const response = s.send({ type: entry, ...identity, result: receipt, ...(entry === 'LOCAL_RESULT'
      ? { settled: true, effectsKnown: true } : { resolution: 'receipt', detail: 'formal host receipt' }) });
    assert(response.ok, `SettledDiscussionRecovery: known receipt must be accepted: ${JSON.stringify(response)}`);
    assert.equal(driver.work(1).status, 'done', 'SettledDiscussionRecovery: known receipt must retire abandoned logical work');
    assert.deepEqual(driver.work(1).localOperations[0].result, receipt, 'SettledDiscussionRecovery: retirement must retain the receipt');
    assert.equal(s.context().discussion.status, 'cancelled'); assert.equal(driver.summary(), undefined);
  });
  example('unsafe-compatibility', 'map', driver => {
    claimPair(driver);
    driver.session.rewriteSavedWork(driver.work(1).id, work => { work.replay = 'unsafe'; });
    cancel(driver); driver.session.reopen(); driver.session.reopen();
    assert.equal(driver.work(1).status, 'uncertain', 'UnsafeRetention: unsafe historical work must not be retired or replayed');
  }, 'guard-input snapshot: public inflight prefix with replay classified unsafe; not a public reachable discussion history');
  return reports;
}
