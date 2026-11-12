import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TeamEngine, Intent, TaskEvent } from '../src/index.js';

type EventBody = Record<string, unknown> & { type: string };
export type DeliveryBackend = 'memory' | 'sqlite';
export async function deliveryHost(root: string, backend: DeliveryBackend, directory: string, engineering = false) {
  const api = await import(pathToFileURL(join(root, 'src/index.ts')).href) as typeof import('../src/index.js');
  const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href) as typeof import('../team.config.js');
  const config = createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'false' });
  config.limits = { ...config.limits, ordinary: 100, checks: 20 };
  const database = join(directory, 'state.sqlite');
  let store = backend === 'memory' ? new api.MemoryStore() : new api.SqliteStore(database);
  let engine: TeamEngine = new api.TeamEngine(store, config, () => 0);
  let sequence = 0;
  const room = 'composition', task = 'task:composition';
  const text = engineering ? 'run npm test' : 'Write the report';
  assert(engine.submit(room, { id: 'composition', text, goal: { text, constraints: [], criteria: ['Report is correct'], requiredArtifacts: 1 } }).ok);
  const context = () => engine.view(room, task)!.context;
  const send = (body: EventBody) => engine.send(room, task, { id: 'composition:' + ++sequence, at: 0, ...body } as TaskEvent);
  const claim = (kind: Intent['kind']) => {
    const pending = engine.pending(room, task).find(work => work.kind === kind);
    assert(pending, `ReachablePrefix: ${kind} must be eligible`);
    const work = engine.claim(room, task, pending.id);
    assert(work, `ReachablePrefix: ${kind} claim must commit`);
    return work;
  };
  const submitDraft = (work: Intent, replacesArtifactId?: string) => {
    assert(send({ type: 'DELIVER', workId: work.id, fence: work, text: 'Current report', artifactIds: [],
      artifacts: [{ name: 'report.md', content: `Report ${context().artifacts.length + 1}`, ...(replacesArtifactId ? { replacesArtifactId } : {}) }] }).ok);
  };
  const deliver = (replacesArtifactId?: string) => {
    submitDraft(claim('owner'), replacesArtifactId); return claim('check');
  };
  const bodyFor = (work: Intent) => {
    const candidate = context().candidate!;
    return { type: 'CHECK_RESULT', workId: work.id, fence: work, attempt: work.attempt,
      candidateRevision: candidate.revision, resultId: 'result:' + work.id,
      criteriaResults: candidate.acceptance!.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed' })) };
  };
  const consume = (work: Intent) => send({ type: 'CONSUME', intentId: work.id, fence: work, attempt: work.attempt });
  const local = (work: Intent, action: Record<string, unknown>, result: Record<string, unknown>, revision?: string) => {
    const op = engine.requestLocal(room, task, work.id, work.attempt, action as Parameters<TeamEngine['requestLocal']>[4], [], 'workspace');
    const claim = engine.claimLocal(room, task, work.id, op.id, work.attempt);
    assert(claim.response.ok && claim.operation?.sessionId, 'ReachablePrefix: local claim must commit');
    const sessionId = claim.operation.sessionId;
    assert(send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId,
      ...(revision ? { isolated: true, workspaceRevision: revision } : {}) }).ok);
    assert(send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId,
      result, settled: true, effectsKnown: true }).ok);
  };
  return {
    room, task, config, context, send, claim, deliver, submitDraft, bodyFor, consume, local,
    get engine() { return engine; }, get store() { return store; },
    reopen() {
      if (backend === 'sqlite') { store.close(); store = new api.SqliteStore(database); }
      engine = new api.TeamEngine(store, config, () => 0);
    },
    close() { store.close(); },
  };
}

export async function createVerification(root: string, backend: DeliveryBackend, directory: string) {
  const host = await deliveryHost(root, backend, directory, true);
  const check = host.deliver(), body = host.bodyFor(check), revision = 'a'.repeat(64);
  let stage = 0, changed = false, online = true, rolledBack = false, earlyCheckAllowed = false;
  let validationId: string | undefined, validationSession: string | undefined, versionId: string | undefined, versionSession: string | undefined;
  const request = (action: Parameters<TeamEngine['requestLocal']>[4]) => host.engine.requestLocal(host.room, host.task, check.id, check.attempt, action, [], 'workspace');
  const claim = (id: string) => {
    const claimed = host.engine.claimLocal(host.room, host.task, check.id, id, check.attempt);
    assert(claimed.response.ok && claimed.operation?.sessionId); return claimed.operation.sessionId;
  };
  const start = (id: string, sessionId: string, cli = false) => assert(host.send({ type: 'LOCAL_STARTED', intentId: check.id, operationId: id, sessionId,
    ...(cli ? { isolated: true, workspaceRevision: revision } : {}) }).ok);
  const result = (id: string, sessionId: string, value: Record<string, unknown>) => assert(host.send({ type: 'LOCAL_RESULT', intentId: check.id, operationId: id,
    sessionId, result: value, settled: true, effectsKnown: true }).ok);
  const observe = () => {
    const c = host.context(), publication = c.publishedDelivery;
    const versioned = !!c.intents.find(work => work.id === check.id)?.localOperations?.some(op => op.action.type === 'verifyWorkspace' && op.status === 'succeeded');
    if (publication) {
      assert(!c.stopped, 'Stopped work cannot publish');
      if(!versioned||changed)assert(c.candidate!.text.includes('实际验证未完成'));
      assert.equal(c.outcome, 'complete', 'AtomicPublication: publication and completion must commit together');
      assert.equal(c.messages.filter(message => message.kind === 'final').length, 1, 'AtomicPublication: exactly one final');
      assert.deepEqual(c.messages.find(message => message.kind === 'final')?.artifactIds, publication.artifactIds, 'AtomicPublication: final selection');
    }
    const versionRejected = !!c.intents.find(work => work.id === check.id)?.localOperations?.some(op => op.action.type === 'verifyWorkspace' && op.status === 'failed');
    return { gapsDeclared: c.candidate?.text.includes('实际验证未完成') ?? false, stage, changed, versionRejected, published: !!publication, stopped: c.stopped, online, rolledBack, earlyCheckAllowed, versioned, validated: !!c.intents.find(work => work.id === check.id)?.localOperations?.some(op => op.action.type === 'runCli' && op.status === 'succeeded') };
  };
  const apply = (action: string) => {
    switch (action) {
      case 'ConsumeEarly': {
        const reply = host.consume(check); earlyCheckAllowed = reply.ok;
        assert(reply.ok, 'The downstream worker may inspect and remedy before validation');
        assert.equal(host.context().intents.find(work => work.id === check.id)?.requestCount, 1, 'The authorized request is counted');
        break;
      }
      case 'RequestValidation': validationId = request({ type: 'runCli', executable: 'npm', args: ['test'], execution: 'sandbox' }).id; stage = 1; break;
      case 'ClaimValidation': assert(validationId); validationSession = claim(validationId); stage = 2; break;
      case 'StartValidation': assert(validationId && validationSession); start(validationId, validationSession, true); stage = 3; break;
      case 'ValidationPassed': case 'ValidationFailed': {
        assert(validationId && validationSession); const ok = action === 'ValidationPassed';
        result(validationId, validationSession, { ok, code: ok ? 'succeeded' : 'CLI_FAILED', data: { exitCode: ok ? 0 : 1, stdout: 'test receipt', stderr: '', truncated: false } }); stage = 4; break;
      }
      case 'FailWork': assert(host.send({ type: 'WORK_FAILED', intentId: check.id, fence: check, reason: 'CLI_FAILED', transient: false }).ok); stage = 11; break;
      case 'Consume': assert(host.consume(check).ok); stage = 5; break;
      // This is the adapter's local output carrier, not an invented persisted task state.
      case 'ModelResult': stage = 6; break;
      // External workspace fact represented by an unequal revision in the later public receipt.
      case 'ChangeWorkspace': changed = true; break;
      case 'RequestVersion': versionId = request({ type: 'verifyWorkspace', expectedRevision: revision }).id; stage = 7; break;
      case 'ClaimVersion': assert(versionId); versionSession = claim(versionId); stage = 8; break;
      case 'StartVersion': assert(versionId && versionSession); start(versionId, versionSession); stage = 9; break;
      case 'VersionResult':
        assert(versionId && versionSession);
        result(versionId, versionSession, { ok: true, code: 'succeeded', data: { expectedRevision: revision, currentRevision: changed ? 'b'.repeat(64) : revision, copyRevision: revision } });
        stage = 10; break;
      case 'VersionFailure':
        assert(versionId && versionSession);
        result(versionId, versionSession, { ok: false, code: 'WORKSPACE_REVISION_CHANGED', data: { expectedRevision: revision, currentRevision: 'b'.repeat(64), copyRevision: revision } });
        stage = 10; break;
      case 'FailVersionWork': assert(host.send(body).ok); stage=11; break;
      case 'Publish': case 'PublishWithoutVersion': {
        assert(host.send(body).ok); stage = 11;
        if (action === 'PublishWithoutVersion' || changed) {
          assert(host.context().publishedDelivery, 'Content is delivered with an explicit verification gap');
          assert.equal(host.context().outcome, 'complete');
          assert(host.context().candidate!.text.includes(observe().versionRejected ? 'WORKSPACE_REVISION_CHANGED' : 'WORKSPACE_VERIFICATION_REQUIRED'));
        }
        break;
      }
      case 'Stop':
        assert(host.send({ type: 'STOP' }).ok);
        stage = 11; break;
      case 'Late': host.send({ ...body, resultId: 'late:' + body.resultId }); break;
      case 'Rollback': {
        const before = JSON.stringify(host.store.read(host.room)); host.store.failNextCommit = true;
        assert.throws(() => host.send(body), /Injected commit failure/);
        assert.equal(JSON.stringify(host.store.read(host.room)), before, 'AtomicPublication: rollback changed persisted state');
        online = false; rolledBack = true; break;
      }
      case 'Reopen': host.reopen(); online = true; break;
      default: throw new Error('Unknown verification action: ' + action);
    }
    return observe();
  };
  return { observe, apply, close: host.close };
}

export async function createCycles(root: string, backend: DeliveryBackend, directory: string) {
  const host = await deliveryHost(root, backend, directory);
  let check = host.deliver(), body = host.bodyFor(check);
  assert(host.consume(check).ok); assert(host.send(body).ok);
  let previous = structuredClone(body), owner: Intent | undefined;
  let cycle = 1, mode = 0, revised = false, online = true, rolledBack = false, oldAccepted = false;
  const savedArtifacts = new Map(host.context().artifacts.map(item => [item.id, structuredClone(item)]));
  const savedFinals = new Map(host.context().messages.filter(item => item.kind === 'final').map(item => [item.id, structuredClone(item)]));
  const observe = () => {
    const c = host.context(), publication = c.publishedDelivery;
    assert(publication?.artifactIds.length, 'RetainedPublication: continuing or failed check erased the previous publication');
    for (const [id, saved] of savedArtifacts) assert.deepEqual(c.artifacts.find(item => item.id === id), saved, 'ImmutableHistory: old artifact changed');
    for (const [id, saved] of savedFinals) assert.deepEqual(c.messages.find(item => item.id === id), saved, 'ImmutableHistory: old final selection changed');
    assert.deepEqual(publication.artifactIds, [c.artifacts.find(item => item.id === publication.artifactIds[0])!.id]);
    return { cycle, mode, candidate: c.artifacts.length,
      publication: c.artifacts.find(item => item.id === publication.artifactIds[0])!.revision!,
      finals: c.messages.filter(item => item.kind === 'final').length, revised, stopped: c.stopped, online, rolledBack, oldAccepted };
  };
  const apply = (action: string) => {
    switch (action) {
      case 'Continue':
        previous = structuredClone(body);
        assert(host.send({ type: 'CONTINUE' }).ok); cycle++; mode = 1; break;
      case 'ClaimOwner': owner = host.claim('owner'); mode = 2; break;
      case 'Draft': assert(owner); host.submitDraft(owner, host.context().artifacts.at(-1)!.id); mode = 3; break;
      case 'ClaimCheck': check = host.claim('check'); body = host.bodyFor(check); mode = 4; break;
      case 'Consume': assert(host.consume(check).ok); mode = 5; break;
      case 'Pass': {
        assert(host.send(body).ok); assert.equal(host.context().outcome, 'complete'); mode = 0;
        for (const item of host.context().artifacts) savedArtifacts.set(item.id, structuredClone(item));
        for (const item of host.context().messages.filter(item => item.kind === 'final')) savedFinals.set(item.id, structuredClone(item));
        break;
      }
      case 'Fail':
        assert(host.send({ ...body, resultId: 'failed:' + body.resultId,
          criteriaResults: body.criteriaResults.map(item => ({ ...item, status: 'failed', reason: 'Needs revision' })) }).ok);
        assert.equal(host.context().outcome, null); revised = true; mode = 1; break;
      case 'OldReceipt': {
        const before = structuredClone(host.context().publishedDelivery);
        const result = host.send({ ...body, resultId: 'stale:' + body.resultId, candidateRevision: previous.candidateRevision });
        oldAccepted = result.ok;
        assert(!result.ok, 'CurrentCandidate: a previous candidate judgment authorized the new check');
        assert.deepEqual(host.context().publishedDelivery, before, 'RetainedPublication: stale judgment altered publication'); break;
      }
      case 'LateReceipt': {
        const before = structuredClone(host.context().publishedDelivery), finals = host.context().messages.filter(item => item.kind === 'final').length;
        host.send({ ...previous, resultId: 'old-work:' + previous.resultId });
        assert.deepEqual(host.context().publishedDelivery, before, 'CurrentCandidate: old work altered publication');
        assert.equal(host.context().messages.filter(item => item.kind === 'final').length, finals, 'OneFinalPerCycle: old work appended final'); break;
      }
      case 'Duplicate': {
        const before = structuredClone(host.context().publishedDelivery), finals = host.context().messages.filter(item => item.kind === 'final').length;
        host.send(body);
        assert.deepEqual(host.context().publishedDelivery, before);
        assert.equal(host.context().messages.filter(item => item.kind === 'final').length, finals, 'OneFinalPerCycle: duplicate appended final'); break;
      }
      case 'Stop': assert(host.send({ type: 'STOP' }).ok); mode = 6; break;
      case 'Rollback': {
        const before = JSON.stringify(host.store.read(host.room)); host.store.failNextCommit = true;
        assert.throws(() => host.send(body), /Injected commit failure/);
        assert.equal(JSON.stringify(host.store.read(host.room)), before, 'AtomicPublication: cycle rollback persisted partial state');
        online = false; rolledBack = true; break;
      }
      case 'Reopen': host.reopen(); online = true; break;
      default: throw new Error('Unknown publication cycle action: ' + action);
    }
    return observe();
  };
  return { observe, apply, close: host.close };
}
