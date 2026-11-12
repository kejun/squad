import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { session } = await import(pathToFileURL(join(sourceRoot, 'tests/coordination-composition-fixture.ts')).href);
const identity = work => ({ workId: work.id, attempt: work.attempt, fence: { epoch: work.epoch, goalVersion: work.goalVersion } });

export async function createForwardDeliveryDriver(root, _variant, backend, directory) {
  const s = await session(root, backend, directory, config => {
    config.inputAnalysis = { enabled: true };
    config.models = { default: 'formal', services: { formal: { baseUrl: 'https://invalid.example/v1', model: 'formal' } } };
  });
  assert(s.engine().submit(s.room, { id: 'start', text: '分别读取甲乙资料并归并' }).ok);
  const interpretation = s.claim(s.find('interpretation'));
  assert(s.send({ type: 'CONSUME', intentId: interpretation.id, ...identity(interpretation) }).ok);
  assert(s.send({ type: 'INTERPRETATION_RESULT', ...identity(interpretation), inputId: interpretation.payload.input.id,
    spec: { action: 'request', objective: '归并甲乙资料', constraints: [], expectedOutputs: ['报告'], acceptanceCriteria: ['明确缺口'],
      references: [], confidence: 1, clarification: null, decomposition: { kind: 'mapReduce', partitions: [
        { id: 'alpha', objective: '读取甲', expectedOutput: '甲正文' }, { id: 'beta', objective: '读取乙', expectedOutput: '乙正文' }], synthesis: '归并原始结果和缺口' } } }).ok);
  const round = s.context().discussion.id;
  const children = s.context().intents.filter(work => work.kind === 'assistance' && work.discussionId === round);
  assert.equal(children.length, 2);
  for (const [index, child] of children.entries()) {
    const work = s.claim(child);
    assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(work), discussionId: round,
      status: index === 0 ? 'success' : 'failed', text: index === 0 ? '甲正文' : '失败诊断不作为交付正文' }).ok);
  }
  const summary = s.claim(s.find('discussionSummary'));
  assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(summary), discussionId: round, status: 'partial', text: '乙资料暂缺' }).ok);
  const owner = s.claim(s.find('owner'));
  const history = () => JSON.stringify({ results: s.context().discussion.results, queue: s.context().discussion.mapReduce.queue });
  const originalHistory = history();
  const { artifactVerification } = await import(pathToFileURL(join(root, 'src/resource-acquisition.ts')).href);
  const { deliveryJudgments } = await import(pathToFileURL(join(root, 'src/delivery-acceptance.ts')).href);
  let reopened = false, online = true, rolledBack = false;
  const check = () => s.context().intents.find(work => work.kind === 'check' && work.goalVersion === 1);
  const artifacts = () => s.context().artifacts.filter(artifact => artifact.goalVersion === 1 && artifact.name === 'formal.md');
  const body = status => ({ type: 'CHECK_RESULT', ...identity(check()), resultId: `forward:${status}`,
    candidateRevision: check().payload.candidate.revision,
    criteriaResults: check().payload.candidate.acceptance.criteria.map(criterion => ({ criterionId: criterion.id, status,
      ...(status === 'passed' ? {} : { reason: 'source gap in final' }) })) });
  const observe = () => {
    const c = s.context(), work = check(), selected = artifacts().at(-1);
    const verdict = { passed: 1, failed: 2, unverified: 3 }[work?.criteriaResults?.[0]?.status] ?? 0;
    return { phase: c.stopped || c.goalVersion !== 1 || c.outcome !== null ? 4 : !work ? 0 : work.status === 'pending' ? 1 : work.requestCount ? 3 : 2,
      verdict, revision: selected?.revision ?? 0, owners: c.intents.filter(work => work.kind === 'owner' && work.goalVersion === 1).length,
      published: !!c.publishedDelivery, gaps: c.candidate?.text.includes('source gap in final') ?? false,
      verified: !!selected && artifactVerification(c, selected).status === 'verified', stopped: c.stopped, goal: c.goalVersion,
      reopened, online, rolledBack, history: history() === originalHistory };
  };
  const properties = () => {
    const c = s.context(), o = observe();
    assert.equal(o.owners, 1, 'NoReviewBackflow: downstream findings cannot create upstream work');
    assert(o.history, 'HistoryImmutable: original child outcomes cannot be rewritten');
    const failed = c.discussion.results.find(result => result.status === 'failed');
    assert(failed && failed.answer === '' && failed.artifactIds.length === 0 && failed.reason,
      'FailedOutputEmpty: failed child body and artifacts must be empty with separate diagnostic');
    assert.equal(c.intents.filter(work => work.kind === 'assistance' && work.discussionId === round).length, 2, 'NoReviewBackflow: settled children cannot be rerun');
    if (o.verdict > 1) assert(o.published && o.gaps && !o.verified, 'DeclaredGaps: unresolved content is delivered and retains its verification status');
    if (o.published) {
      assert(!o.stopped && o.goal === 1 && c.outcome === 'complete', 'CurrentVerdict: publication must belong to the current valid check');
      assert.equal(c.messages.filter(message => message.kind === 'final').length, 1, 'CurrentVerdict: publish exactly once');
      assert.deepEqual(c.messages.find(message => message.kind === 'final').artifactIds, c.publishedDelivery.artifactIds, 'CurrentVerdict: final/publication selection');
      assert.deepEqual(deliveryJudgments(c, c.candidate.revision), check().criteriaResults, 'LatestVerdict: final result must use the current downstream conclusion');
    }
  };
  const apply = action => {
    switch (action) {
      case 'Submit': assert(s.send({ type: 'DELIVER', ...identity(owner), text: '原始归并报告', artifactIds: [],
        artifacts: [{ name: 'formal.md', content: '甲资料及乙的已知缺口' }],
        partitionRecoveries: [{ discussionId: round, partitionId: 'alpha', sourceOperationIds: ['obsolete-proof'] }] }).ok); break;
      case 'Claim': s.claim(check()); break;
      case 'Consume': assert(s.send({ type: 'CONSUME', intentId: check().id, ...identity(check()) }).ok); break;
      case 'Pass': assert(s.send(body('passed')).ok); break;
      case 'DeclareFailed': assert(s.send(body('failed')).ok); break;
      case 'DeclareUnverified': assert(s.send(body('unverified')).ok); break;
      case 'Repair': assert(s.send({ ...body('passed'), repair: { text: '下游直接修正', artifacts: [
        { name: 'formal.md', content: '下游直接补齐资料的报告', replacesArtifactId: artifacts()[0].id }] } }).ok); break;
      case 'Stale': assert.equal(s.send({ ...body('passed'), candidateRevision: 'stale' }).ok, false, 'CurrentVerdict: reject stale candidate'); break;
      case 'Duplicate': if (check()) s.send(body('passed')); break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'ChangeGoal': assert(s.send({ type: 'USER_INPUT', text: '新的明确目标', goal: { ...s.context().goal, text: '新目标' } }).ok); break;
      case 'Reopen': s.reopen(); reopened = true; online = true; break;
      case 'Rollback': {
        const before = JSON.stringify(s.store.read(s.room));
        s.store.failNextCommit = true;
        assert.throws(() => s.send(body('passed')), /Injected commit failure/);
        assert.equal(JSON.stringify(s.store.read(s.room)), before, 'CurrentVerdict: rollback cannot partially publish');
        online = false; rolledBack = true; break;
      }
      default: throw new Error('Unknown ForwardDelivery action: ' + action);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close, context: s.context, check, artifactVerification, deliveryJudgments };
}

export async function forwardDeliveryProbes(root, backend, directory) {
  const d = await createForwardDeliveryDriver(root, '', backend, directory);
  try {
    for (const action of ['Submit', 'Claim', 'Consume', 'Pass']) d.apply(action);
    const rows = [];
    for (const [old, latest] of [['failed', 'passed'], ['passed', 'failed']]) {
      const c = structuredClone(d.context()), work = c.intents.find(work => work.id === d.check().id);
      work.criteriaResults = work.criteriaResults.map(result => ({ ...result, status: latest, ...(latest === 'failed' ? { reason: 'latest gap' } : {}) }));
      const prior = structuredClone(work); prior.id = 'historical-check';
      prior.criteriaResults = prior.criteriaResults.map(result => ({ ...result, status: old, ...(old === 'failed' ? { reason: 'old gap' } : {}) }));
      c.intents.splice(c.intents.indexOf(work), 0, prior);
      assert(d.deliveryJudgments(c, c.candidate.revision).every(result => result.status === latest), 'LatestVerdict: historical verdict must not override latest downstream result');
      const expected = latest === 'passed' ? 'verified' : 'unverified';
      assert.equal(d.artifactVerification(c, c.artifacts.at(-1)).status, expected, 'LatestVerdict: artifact projection must use latest downstream result');
      rows.push({ backend, name: `${old}-then-${latest}`, family: 'forward-latest-verdict', origin: 'bounded-snapshot-input', verified: true });
    }
    return rows;
  } finally { d.close(); }
}
