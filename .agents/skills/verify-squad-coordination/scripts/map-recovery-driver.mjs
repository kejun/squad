import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { session } = await import(pathToFileURL(join(sourceRoot, 'tests/coordination-composition-fixture.ts')).href);
const identity = work => ({ workId: work.id, attempt: work.attempt, fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
const sourceId = 'map-recovery-source';
const sourceText = '{"alpha":"alpha完整正文","beta":"beta完整正文"}';
const digest = text => createHash('sha256').update(text).digest('hex');

function interpret(s, decomposition = true) {
  const work = s.claim(s.find('interpretation'));
  assert(s.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
  const spec = { action: work.payload.input.action, objective: '读取甲乙并完整归并', constraints: [], expectedOutputs: ['完整归并报告'],
    acceptanceCriteria: ['保留甲乙内容'], references: [], confidence: .95, clarification: null,
    ...(decomposition ? { decomposition: { kind: 'mapReduce', partitions: [
      { id: 'alpha', objective: '读取alpha', expectedOutput: 'alpha完整正文' },
      { id: 'beta', objective: '读取beta', expectedOutput: 'beta完整正文' }], synthesis: '合并两份正文并保留出处' } } : {}) };
  assert(s.send({ type: 'INTERPRETATION_RESULT', ...identity(work), inputId: work.payload.input.id, spec }).ok);
}
function capture(s, owner, mode = 'complete') {
  assert(s.send({ type: 'CONSUME', intentId: owner.id, attempt: owner.attempt, fence: owner }).ok);
  assert(s.send({ type: 'LOCAL_REQUEST', intentId: owner.id, operationId: sourceId,
    namespace: 'a'.repeat(64), requestHash: 'b'.repeat(64), action: { type: 'runCli', executable: 'formal-reader', args: ['--json'] },
    parentAttempt: owner.attempt, fence: owner, messages: [], workspaceId: 'formal-project' }).ok);
  assert(s.send({ type: 'LOCAL_CLAIM', intentId: owner.id, operationId: sourceId,
    parentAttempt: owner.attempt, fence: owner, sessionId: 'formal-source', leaseAvailable: true }).ok);
  assert(s.send({ type: 'LOCAL_STARTED', intentId: owner.id, operationId: sourceId, sessionId: 'formal-source', workspaceRevision: 'formal-source-revision', isolated: false }).ok);
  assert(s.send({ type: 'LOCAL_RESULT', intentId: owner.id, operationId: sourceId, sessionId: 'formal-source',
    result: { ok: mode !== 'failed', code: mode === 'failed' ? 'failed' : 'succeeded',
      data: { exitCode: mode === 'failed' ? 1 : 0, stdout: sourceText, truncated: mode === 'truncated',
        capturedEvidence: { stdout: { capturedContentHash: digest(sourceText), bytes: Buffer.byteLength(sourceText), chars: [...sourceText].length } } } },
    settled: true, effectsKnown: true }).ok);
}
async function prefix(root, backend, directory, mode = 'complete') {
  const s = await session(root, backend, directory, config => {
    config.inputAnalysis = { enabled: true };
    config.models = { default: 'formal', services: { formal: { baseUrl: 'https://invalid.example/v1', model: 'formal' } } };
    config.limits.retries = 1;
  });
  if (mode === 'stale-epoch') {
    s.submit();
    const previousOwner = s.claim(s.find('owner')); capture(s, previousOwner);
    assert(s.send({ type: 'DELIVER', ...identity(previousOwner), text: '上一执行轮次的完整报告', artifactIds: [] }).ok);
    const previousCheck = s.claim(s.find('check'));
    assert(s.send({ type: 'CONSUME', intentId: previousCheck.id, attempt: previousCheck.attempt, fence: previousCheck }).ok);
    assert(s.send({ type: 'CHECK_RESULT', ...identity(previousCheck), candidateRevision: s.context().candidate.revision,
      resultId: 'previous-pass', criteriaResults: s.context().candidate.acceptance.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) }).ok);
    assert.equal(s.context().outcome, 'complete');
    assert(s.send({ type: 'CONTINUE' }).ok);
    assert(s.send({ type: 'USER_INPUT', text: '分别读取alpha和beta并归并' }).ok);
    interpret(s);
  } else { assert(s.engine().submit(s.room, { id: 'start', text: '分别读取alpha和beta并归并' }).ok); interpret(s); }
  const roundId = s.context().discussion.id;
  const maps = s.context().intents.filter(work => work.discussionId === roundId && work.kind === 'assistance');
  assert.equal(maps.length, 2);
  for (const [index, pending] of maps.entries()) {
    const work = s.claim(pending);
    assert(s.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
    assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(work), discussionId: roundId,
      status: index === 0 ? 'failed' : 'partial', text: `${index === 0 ? 'alpha失败' : 'beta不完整'}` }).ok);
  }
  const summary = s.claim(s.find('discussionSummary'));
  assert(s.send({ type: 'CONSUME', intentId: summary.id, attempt: summary.attempt, fence: summary }).ok);
  assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(summary), discussionId: roundId, status: 'partial', text: '甲乙资料仍未补齐' }).ok);
  const owner = s.claim(s.find('owner'));
  if (mode === 'stale-epoch') assert(s.send({ type: 'CONSUME', intentId: owner.id, attempt: owner.attempt, fence: owner }).ok);
  else capture(s, owner, mode);
  const claims = ['alpha', 'beta'].map(partitionId => ({ discussionId: roundId, partitionId, sourceOperationIds: [sourceId] }));
  return { s, owner, roundId, claims };
}
function delivery(f, claims = f.claims) {
  return f.s.send({ type: 'DELIVER', ...identity(f.owner), text: '已补齐alpha和beta完整正文并归并', artifactIds: [],
    ...(claims.length ? { partitionRecoveries: claims } : {}) });
}
function failedHistory(s) {
  const round = s.context().discussion;
  return JSON.stringify({ results: round.results, queue: round.mapReduce.queue.map(part => ({ partitionId: part.partitionId,
    status: part.status, attempt: part.attempt, workId: part.workId, resultRef: part.resultRef, reason: part.reason })) });
}

export async function createMapRecoveryDriver(root, _variant, backend, directory) {
  const f = await prefix(root, backend, directory), { s } = f;
  const history = failedHistory(s);
  let reopened = false;
  const check = () => s.context().intents.find(work => work.kind === 'check');
  const fixed = () => check()?.payload.candidate;
  const judgments = () => fixed().acceptance.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed',
    ...(criterion.requiredSourceIds ? { source: { id: sourceId, quote: criterion.id.endsWith(':alpha') ? 'alpha完整正文' : 'beta完整正文' } } : {}) }));
  const result = (changes = {}, results = judgments()) => ({ type: 'CHECK_RESULT', ...identity(check()),
    candidateRevision: fixed().revision, resultId: `map-result:${check().id}:${check().attempt}:${s.context().consumedResults.length}`,
    criteriaResults: results, ...changes });
  const observe = () => {
    const c = s.context(), work = check(), claims = fixed()?.partitionRecoveries?.length ?? 0;
    const proofs = c.discussion.mapReduce.queue.filter(part => part.resolution).map(part => part.resolution);
    const binding = proofs.every(proof => proof.candidateRevision === fixed()?.revision && proof.checkWorkId === work?.id
      && proof.discussionId === f.roundId && proof.epoch === 1 && proof.goalVersion === 1 && proof.owner === f.owner.target
      && JSON.stringify(proof.sourceOperationIds) === JSON.stringify([sourceId])
      && work.criteriaResults?.some(item => item.criterionId === proof.criterionId && item.status === 'passed'
        && item.source?.id === sourceId && sourceText.includes(item.source.quote)));
    return { phase: !work ? 0 : work.status === 'pending' ? 1 : work.status === 'inflight' ? 2 : 3,
      claims, requests: c.usage.checks, retry: c.deliveryCycle?.retry?.status === 'reserved' ? 1 : c.deliveryCycle?.retry ? 2 : 0,
      accepted: !!work?.criteriaResults, resolved: proofs.length, published: !!c.publishedDelivery,
      incomplete: !!c.discussion.incomplete, history: failedHistory(s) === history, binding,
      stopped: c.stopped, goal: c.goalVersion, reopened };
  };
  const properties = () => {
    const o = observe();
    assert(!o.published || o.claims === 2 && o.resolved === 2 && o.accepted && !o.incomplete,
      'NoUnresolvedPublication: every unresolved partition must be proved before publication');
    assert(!o.resolved || o.published && o.accepted && o.claims === 2,
      'NoUnverifiedRecovery: declaration or a non-passing check must not resolve failed work');
    assert(o.history, 'RecoveryHistoryImmutable: original failed/partial attempts were rewritten');
    assert(o.binding, 'VerifiedRecoveryEvidence: every resolution must bind current candidate/check and an exact specified-source quote');
    assert(!(o.stopped || o.goal !== 1) || !o.published && !o.resolved,
      'RecoveryIsolation: stopped or old-goal check must not publish or resolve');
    assert.equal(o.incomplete, o.resolved < 2, 'OutstandingRecoveryDebt: incomplete flag must reflect remaining original debt');
  };
  const apply = action => {
    switch (action) {
      case 'SubmitNone': assert(delivery(f, []).ok); break;
      case 'SubmitPartial': assert(delivery(f, f.claims.slice(0, 1)).ok); break;
      case 'SubmitFull': assert(delivery(f).ok); break;
      case 'ClaimCheck': s.claim(check()); break;
      case 'ConsumeCheck': { const w = check(); assert(s.send({ type: 'CONSUME', intentId: w.id, attempt: w.attempt, fence: w }).ok); break; }
      case 'PassCheck': assert(s.send(result()).ok); break;
      case 'FailedCheck': case 'UnverifiedCheck': {
        const results = judgments();
        const index = results.findIndex(item => item.source);
        const at = index < 0 ? 0 : index;
        results[at] = { ...results[at], status: action === 'FailedCheck' ? 'failed' : 'unverified', reason: '指定来源未证明原分片已完整补齐' };
        assert(s.send(result({}, results)).ok); break;
      }
      case 'MissingQuote': case 'WrongQuote': {
        const results = judgments(), at = results.findIndex(item => item.source); assert(at >= 0);
        if (action === 'MissingQuote') delete results[at].source;
        else results[at].source.quote = '并不在指定原文中的引用';
        assert(s.send(result({}, results)).ok);
        assert(s.context().deliveryCycle?.retry?.status === 'reserved' && !check().criteriaResults,
          'VerifiedRecoveryEvidence: a recovery pass without an exact specified-source quote must be rejected before accepting judgments');
        break;
      }
      case 'UnrequestedResult': assert.equal(s.send(result()).ok, false, 'NoUnverifiedRecovery: check must consume a paid request first'); break;
      case 'StaleRevision': assert.equal(s.send(result({ candidateRevision: 'not-current-candidate' })).ok, false,
        'RecoveryIsolation: a stale candidate must be rejected'); break;
      case 'StaleAttempt': assert.equal(s.send(result({ attempt: check().attempt + 1 })).ok, false,
        'RecoveryIsolation: a mismatched attempt must be rejected'); break;
      case 'DuplicateResult': assert.equal(s.send(result()).ok, false, 'NoUnverifiedRecovery: a retired check must not settle twice'); break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'ChangeGoal': assert(s.send({ type: 'USER_INPUT', text: '改为核对新目标', goal: { ...s.context().goal, text: '新目标' } }).ok); break;
      case 'LateResult': assert.equal(s.send(result()).ok, false, 'RecoveryIsolation: stopped or stale checks must be rejected'); break;
      case 'Reopen': s.reopen(); reopened = true; break;
      default: throw new Error(`Unknown MapRecovery action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

/** Separate finite public-input probes; not graph states or arbitrary corrupt-input proof. */
export async function mapRecoveryProbes(root, backend, directory) {
  const { mkdirSync, rmSync } = await import('node:fs');
  const rows = [];
  for (const mode of ['failed', 'truncated', 'unknown', 'duplicate', 'wrong-round', 'stale-epoch', 'independent-review']) {
    const target = join(directory, `recovery-${mode}`); mkdirSync(target, { recursive: true });
    const f = await prefix(root, backend, target, ['failed', 'truncated', 'stale-epoch'].includes(mode) ? mode : 'complete');
    try {
      const claims = structuredClone(f.claims);
      let input;
      if (mode === 'independent-review') {
        // Deliberate finite snapshot input, not a claim this review/map combination
        // was reached by the public prefix above. ReviewQueue covers its own lifecycle.
        input = { id: 'bounded-review-input', request: '独立成员审查', targets: ['B'], completed: [],
          status: 'summarizing', epoch: f.s.context().epoch, goalVersion: f.s.context().goalVersion,
          incomplete: '原独立审查仍有缺口' };
        f.s.engine().store.transact(f.s.room, tx => { tx.room.tasks[f.s.task].snapshot.context.review = structuredClone(input); });
      }
      if (mode === 'unknown') claims[0].sourceOperationIds = ['not-saved'];
      if (mode === 'duplicate') claims.push(structuredClone(claims[0]));
      if (mode === 'wrong-round') claims[0].discussionId = 'old-round';
      const previousChecks = f.s.context().intents.filter(work => work.kind === 'check').length;
      assert(delivery(f, claims).ok);
      if (mode === 'independent-review') {
        const check = f.s.claim(f.s.find('check'));
        assert(f.s.send({ type: 'CONSUME', intentId: check.id, attempt: check.attempt, fence: check }).ok);
        assert(f.s.send({ type: 'CHECK_RESULT', ...identity(check), candidateRevision: f.s.context().candidate.revision,
          resultId: 'bounded-review-all-pass', criteriaResults: f.s.context().candidate.acceptance.criteria.map(criterion => ({ criterionId: criterion.id, status: 'passed',
            ...(criterion.requiredSourceIds ? { source: { id: sourceId, quote: criterion.id.endsWith(':alpha') ? 'alpha完整正文' : 'beta完整正文' } } : {}) })) }).ok);
        assert.equal(f.s.context().outcome, 'partial', 'IndependentReviewRetained: owner collection cannot replace an independent reviewer');
        assert.equal(f.s.context().publishedDelivery, undefined, 'IndependentReviewRetained: map recovery must not publish over an independent review gap');
      } else assert.equal(f.s.context().intents.filter(work => work.kind === 'check').length, previousChecks,
        'RecoveryEvidenceEligibility: invalid, incomplete or unbound evidence must not authorize a recovery check');
      assert.equal(f.s.context().discussion.mapReduce.queue.filter(part => part.resolution).length, 0,
        'NoUnverifiedRecovery: an invalid declaration must not resolve original failed work');
      rows.push({ backend, family: 'map-recovery-evidence', name: mode, origin: input ? 'bounded-snapshot-input' : 'public-prefix', ...(input ? { input } : {}), verified: true });
    } finally { f.s.close(); rmSync(target, { recursive: true, force: true }); }
  }
  return rows;
}
