import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store, Transaction } from '../src/store.js';
import type { Intent, TaskContext, TaskEvent, TeamConfig } from '../src/types.js';

export interface CompositionDriver {
  observe(): Record<string, number | boolean>;
  apply(action: string): Record<string, number | boolean>;
  properties(): void;
  close(): void;
}
type Session = Awaited<ReturnType<typeof session>>;
const identity = (work: Intent) => ({ workId: work.id, attempt: work.attempt, fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
export async function session(root: string, backend: string, directory: string, change: (config: TeamConfig) => void = () => {}) {
  const { TeamEngine, MemoryStore, SqliteStore } = await import(pathToFileURL(join(root, 'src/index.ts')).href);
  const { createTeamConfig } = await import(pathToFileURL(join(root, 'team.config.ts')).href);
  const config: TeamConfig = createTeamConfig({});
  config.inputAnalysis = { enabled: false };
  config.limits = { ...config.limits, ordinary: 40, assists: 12, checks: 8, retries: 3, workTimeoutMs: 10000, progressIntervalMs: 1000 };
  change(config);
  const path = join(directory, 'state.sqlite');
  let store = backend === 'sqlite' ? new SqliteStore(path) : new MemoryStore();
  let now = 0, seq = 0, commits = 0;
  const tracked: Store = { read: (roomId: string) => store.read(roomId), close: () => store.close(),
    transact<T>(roomId: string, fn: (tx: Transaction) => T): T { commits++; return store.transact(roomId, fn); } };
  let engine = new TeamEngine(tracked, config, () => now);
  const room = 'composition', task = 'task:start';
  const send = (body: Record<string, unknown>) => engine.send(room, task, { id: `composition:${++seq}`, at: now, ...body } as TaskEvent);
  let cachedContext: TaskContext | undefined, cachedAt = -1;
  // Reads within one committed state share a projection; every actual transaction invalidates it.
  const context = (): TaskContext => {
    if (cachedAt !== commits) { cachedContext = engine.view(room, task)!.context; cachedAt = commits; }
    return cachedContext!;
  };
  const current = (id: string) => context().intents.find(work => work.id === id)!;
  const claim = (work: Intent) => {
    const result = engine.claim(room, task, work.id);
    assert(result, `PublicClaim: ${work.kind}/${work.target} must be reachable`);
    return result as Intent;
  };
  const find = (kind: Intent['kind'], status = 'pending') => context().intents.find(work => work.kind === kind && work.status === status)!;
  const submit = (extra: Record<string, unknown> = {}) => assert(engine.submit(room, { id: 'start', text: '形成方案',
    goal: { text: '形成方案', constraints: [], criteria: ['完整'], requiredArtifacts: 0 }, ...extra }).ok, 'PublicPrefix: submission');
  const reopen = () => {
    if (backend === 'sqlite') { store.close(); store = new SqliteStore(path); }
    engine = new TeamEngine(tracked, config, () => now); cachedAt = -1;
  };
  return { config, room, task, context, current, claim, find, send, submit, reopen,
    recover: () => { reopen(); assert(send({ type: 'RECOVER', config }).ok, 'PublicRecovery: compatible RECOVER must commit'); },
    recoverRoom: () => {
      assert.equal(context().results.length, 0, 'Scope: cancelled-discussion recovery has no saved result to flush');
      reopen(); const before = commits; engine.recover(room);
      assert(commits - before <= 1, 'RecoveryAtomicBoundary: this single-task, no-result, pre-deadline recovery contains at most one committed RECOVER; settled ended tasks are a no-op');
    },
    engine: () => engine, setNow: (value: number) => { now = value; }, close: () => store.close() };
}

function sourceFree(s: Session) {
  assert.equal(s.context().sourceArtifact, undefined, 'Scope: composition slices have no cross-task source');
}
function spec() { return { action: 'supplement', objective: '核对新增来源并保留限制', constraints: ['保留原目标'], expectedOutputs: ['完整方案'],
  acceptanceCriteria: ['核对新增来源'], references: [], confidence: .95, clarification: null }; }

async function inputBoundary(root: string, kind: string, backend: string, directory: string): Promise<CompositionDriver> {
  const s = await session(root, backend, directory, config => {
    config.inputAnalysis = { enabled: true };
    config.models = { default: 'formal', services: { formal: { baseUrl: 'https://invalid.example/v1', model: 'formal' } } };
  });
  s.submit();
  let original: Intent;
  if (kind === 'help') {
    assert(s.send({ type: 'HELP', requestId: 'H', caller: s.context().owner, target: 'B', question: '核对旧来源', expected: '明确结果' }).ok);
    original = s.claim(s.find('assistance'));
  } else {
    const owner = s.claim(s.find('owner'));
    assert(s.send({ type: 'DELIVER', ...identity(owner), text: '初始候选', artifactIds: [] }).ok);
    original = s.claim(s.find('check'));
    assert(s.send({ type: 'CONSUME', intentId: original.id, attempt: original.attempt, fence: original }).ok);
  }
  let supplemented = false, saved = false, recovered = false;
  let originalInterpreter: Intent | undefined;
  const analysis = () => s.context().inputAnalyses?.find(input => input.id === 'supplement');
  const interpreter = () => s.context().intents.filter(work => work.kind === 'interpretation').at(-1);
  const observe = () => {
    sourceFree(s); const c = s.context(), a = analysis();
    return { supplement: supplemented, saved, consumed: kind === 'help' ? !!c.results.find(result => result.resultId === 'R')?.consumed : saved,
      applied: !!c.inputs.find(note => note.id === 'supplement')?.applied,
      analysis: a ? ['absent', 'pending', 'inflight', 'resolved', 'clarification', 'cancelled', 'failed'].indexOf(a.status) : 0,
      interpreter: !!interpreter(), owner: c.intents.filter(work => work.kind === 'owner' && ['pending', 'inflight'].includes(work.status)).length,
      stopped: c.stopped, recovered, epoch: c.epoch, evidence: c.deliveryCycle?.evidence !== undefined,
      published: !!c.publishedDelivery };
  };
  const properties = () => {
    const o = observe();
    assert(!o.interpreter || o.consumed, 'NoPrematureInterpretation: saved help must be consumed before parsing the supplement');
    assert(o.analysis !== 3 || o.applied && !o.evidence && o.owner === 1, 'AppliedInputBoundary: resolved input must reach its single safe successor and clear old check evidence');
    assert(!o.published, 'NoUnresolvedPublication: old check must not publish over a pending supplement');
    assert(o.owner === 0 || o.analysis === 0 || o.analysis === 3, 'NoUnresolvedOwner: unresolved supplement cannot authorize owner work');
    assert(!o.stopped || o.owner === 0, 'StopCancelsInputSuccessor: stopped interpretation cannot schedule owner');
  };
  const apply = (action: string) => {
    const c = s.context();
    switch (action) {
      case 'Supplement':
        assert(s.send({ type: 'USER_INPUT', id: 'supplement', text: '请核对新增来源并保留全部硬约束，再形成完整方案；如果资料存在分歧，需要明确依据和未解决的问题。' }).ok);
        supplemented = true; assert.equal(analysis()?.source, 'model', 'PublicPrefix: complex supplement must require interpretation'); break;
      case 'Save':
        assert(s.send({ type: 'RECORD_RESULT', ...identity(original), requestId: 'H', resultId: 'R', status: 'success', answer: '旧来源核对结果' }).ok); saved = true; break;
      case 'ReturnCheck':
        assert(s.send({ type: 'CHECK_RESULT', ...identity(original), resultId: 'old-check', candidateRevision: c.candidate!.revision,
          criteriaResults: c.candidate!.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) }).ok); saved = true; break;
      case 'Flush': assert(s.engine().flushResults(s.room, s.task), 'SavedResultProgress: the saved result must be consumed at the boundary'); break;
      case 'ClaimAnalysis': originalInterpreter = s.claim(interpreter()!); break;
      case 'Resolve': {
        const work = interpreter()!; assert(s.send({ type: 'INTERPRETATION_RESULT', ...identity(work), inputId: 'supplement', spec: spec() }).ok); break;
      }
      case 'Clarify': {
        const work = interpreter()!; assert(s.send({ type: 'INTERPRETATION_RESULT', ...identity(work), inputId: 'supplement',
          spec: { ...spec(), confidence: .3, clarification: '请确认新增来源' } }).ok); break;
      }
      case 'Continue': assert(s.send({ type: 'CONTINUE' }).ok); break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'Recover': s.recover(); recovered = true; break;
      case 'LateAnalysis': assert.equal(s.send({ type: 'INTERPRETATION_RESULT', ...identity(originalInterpreter ?? interpreter()!), inputId: 'supplement', spec: spec() }).ok, false,
        'LateInputIsolation: stopped or previous-attempt interpretation must be rejected'); break;
      default: throw new Error(`Unknown InputBoundary action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

export async function createCompositionDriver(root: string, model: string, variant: string, backend: string, directory: string): Promise<CompositionDriver> {
  root = resolve(root);
  if (model === 'InputBoundary') return inputBoundary(root, variant, backend, directory);
  if (model === 'DeferredCoordination') return deferredCoordination(root, backend, directory);
  if (model === 'ReservedRequests') return reservedRequests(root, variant, backend, directory);
  if (model === 'DiscussionBudget') return discussionBudget(root, backend, directory);
  if (model === 'ReviewQueue') return reviewQueue(root, backend, directory);
  if (model === 'CancelledDiscussion') return cancelledDiscussion(root, variant, backend, directory);
  throw new Error(`Unknown composition model ${model}`);
}

async function deferredCoordination(root: string, backend: string, directory: string): Promise<CompositionDriver> {
  const s = await session(root, backend, directory, config => { config.limits.progressIntervalMs = 2; config.limits.repeatThreshold = 2; });
  s.submit();
  assert(s.send({ type: 'BOARD_WRITE', author: 'A', entryId: 'new-progress', text: '新依据', kind: 'evidence', sources: ['source'] }).ok);
  assert(s.send({ type: 'TOOL', tool: 'read', replay: 'safe', payload: {} }).ok);
  const original = s.claim(s.find('tool'));
  let recovered = false, progressed = false, activity = false, changed = false;
  const observe = () => {
    sourceFree(s); const c = s.context();
    return { work: ['pending', 'inflight', 'done', 'cancelled'].indexOf(s.current(original.id).status),
      failures: c.repeat.count, changed, deferred: c.deferredCoordination,
      coordinations: c.intents.filter(work => work.kind === 'facilitator').length,
      stopped: c.stopped, recovered, progressed, activity };
  };
  const properties = () => {
    const o = observe();
    assert(o.coordinations <= 1, 'UniqueCoordination: one deferred obligation must not dispatch twice');
    assert(!(o.work === 2 && o.deferred && !o.stopped), 'DeferredProgress: settled work must discharge the pending coordination obligation');
    assert(!(o.work === 1 && o.coordinations > 0), 'SafeCoordinationBoundary: do not coordinate over still-running primary work');
    assert(!o.stopped || o.coordinations === 0, 'StoppedCoordination: stop must prevent a new coordination');
  };
  const apply = (action: string) => {
    const c = s.context();
    switch (action) {
      case 'FailureSignal': assert(s.send({ type: 'FAILURE_SIGNAL', operation: '读取', parameters: changed ? '新参数' : '原参数', resource: '资料', error: '无法访问', result: '无结果' }).ok); break;
      case 'ChangeFingerprint': changed = true; assert(s.send({ type: 'FAILURE_SIGNAL', operation: '读取', parameters: '新参数', resource: '资料', error: '无法访问', result: '无结果' }).ok); break;
      case 'EvidencedProgress': assert(s.send({ type: 'PROGRESS', refs: ['new-progress'], detail: '得到新证据' }).ok); progressed = true; break;
      case 'Activity': assert(s.send({ type: 'ACTIVITY', text: '仍在处理' }).ok); activity = true; break;
      case 'Block': assert(s.send({ type: 'BLOCKED', reason: '待安全边界重新协调' }).ok); break;
      case 'Settle': assert(s.send({ type: 'SETTLE', intentId: original.id }).ok); break;
      case 'ClaimTool': s.claim(s.current(original.id)); break;
      case 'Tick': s.setNow(2); assert(s.send({ type: 'TICK' }).ok); break;
      case 'Recover': s.recover(); recovered = true; break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'LateSignal': assert.equal(s.send({ type: 'FAILURE_SIGNAL', operation: '读取', parameters: '原参数', resource: '资料', error: '无法访问', result: '无结果' }).ok, false,
        'StoppedCoordination: stopped failure signal cannot reopen coordination'); break;
      default: throw new Error(`Unknown DeferredCoordination action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

async function reservedRequests(root: string, variant: string, backend: string, directory: string): Promise<CompositionDriver> {
  const limits: Record<string, number> = { review: 4, retry: 4, host: 9, verification: 5 };
  const s = await session(root, backend, directory, config => { config.limits.ordinary = limits[variant]!; });
  s.submit(variant === 'verification' ? { goal: { text: '形成报告并运行 npm test', constraints: [], criteria: ['运行 npm test'], requiredArtifacts: 1 } } : {});
  let active: Intent;
  if (variant === 'review') {
    assert(s.send({ type: 'USER_INPUT', text: '请两位成员评审', reviewTargets: ['B', 'builder-1'] }).ok);
    const planner = s.claim(s.find('facilitator'));
    assert(s.send({ type: 'COORDINATE', ...identity(planner), decision: { action: 'review', question: '核对方案', expected: '具体意见', reason: '直接邀请' } }).ok);
    active = s.claim(s.find('assistance'));
  } else if (variant === 'retry') {
    assert(s.send({ type: 'HELP', requestId: 'H', caller: 'A', target: 'B', question: '核对来源', expected: '明确结果' }).ok);
    const failed = s.claim(s.find('assistance'));
    assert(s.send({ type: 'WORK_FAILED', intentId: failed.id, ...identity(failed), transient: false, reason: '确定失败' }).ok);
    assert(s.send({ type: 'WAIT_USER', question: '请明确重试' }).ok);
    assert(s.send({ type: 'RETRY_ASSISTANCE', requestId: 'H', text: '重试这次协助' }).ok);
    active = s.claim(s.find('assistance'));
  } else if (variant === 'verification') {
    const original = s.claim(s.find('owner'));
    assert(s.send({ type: 'DELIVER', ...identity(original), text: '缺少必需报告的候选', artifactIds: [] }).ok);
    const revision = s.find('owner'); assert(revision?.payload.deliveryRevision, 'PublicPrefix: missing report must create the one revision work');
    active = s.claim(revision);
  } else {
    const original = s.claim(s.find('owner'));
    const op = s.engine().requestLocal(s.room, s.task, original.id, original.attempt,
      { type: 'runCli', executable: 'node', args: ['--version'] }, [], 'workspace:composition-host');
    const claimed = s.engine().claimLocal(s.room, s.task, original.id, op.id, original.attempt);
    assert(claimed.response.ok && claimed.operation?.sessionId);
    assert(s.send({ type: 'LOCAL_RESULT', intentId: original.id, operationId: op.id, sessionId: claimed.operation.sessionId,
      settled: true, effectsKnown: true, result: { ok: false, code: 'failed', data: { execution: 'sandbox', exitCode: 1 } } }).ok);
    assert(s.send({ type: 'REQUEST_HOST_RETRY', sourceWorkId: original.id, sourceOperationId: op.id, sourceRequestHash: op.requestHash,
      requestHash: 'b'.repeat(64), fence: original }).ok);
    assert(s.send({ type: 'DELIVER', ...identity(original), text: '保留候选并等待宿主续办', artifactIds: [] }).ok);
    const batch = s.context().hostRetryBatch; assert(batch, 'PublicPrefix: known sandbox failure must create the host retry batch');
    s.claim(s.current(batch.workId));
    assert(s.send({ type: 'USER_INPUT', text: '请空闲成员核对', reviewTargets: ['B'] }).ok);
    const planner = s.claim(s.find('facilitator'));
    assert(s.send({ type: 'DISCUSSION_PLAN', ...identity(planner), discussionId: planner.discussionId,
      decision: { action: 'review', question: '只读核对', expected: '明确依据', reason: '直接邀请' } }).ok);
    active = s.claim(s.find('assistance'));
  }
  const initialUsed = s.context().usage.ordinary;
  const reserve = variant === 'host' ? 3 : variant === 'verification' ? 2 : 1;
  const observe = () => { sourceFree(s); const c = s.context(); return { used: c.usage.ordinary, requests: s.current(active.id).requestCount, reserve }; };
  const properties = () => {
    const o = observe();
    assert(o.used + o.reserve <= limits[variant]!, 'ProtectedContinuation: additional requests cannot consume promised host, synthesis or verification capacity');
    assert.equal(o.used, initialUsed + Math.max(0, Number(o.requests) - 1), 'SharedRequestAccounting: claim prepays the first request, every later request is charged once');
    if (variant === 'host') {
      assert(s.context().hostRetryBatch, 'Scope: the shared host/discussion obligation remains active');
      assert(s.context().hostRetryRequests!.some(request => request.status === 'active'), 'Scope: host command cost remains unspent');
    }
  };
  const apply = (action: string) => {
    const work = s.current(active.id);
    const response = s.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work });
    if (action === 'DeniedRequest') assert.equal(response.ok, false, 'ProtectedContinuation: the request at the reserved frontier must be denied');
    else { assert(['FirstRequest', 'AdditionalRequest'].includes(action)); assert(response.ok, `SharedRequestAccounting: budgeted request denied: ${response.code}`); }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

async function discussionBudget(root: string, backend: string, directory: string): Promise<CompositionDriver> {
  const s = await session(root, backend, directory, config => { config.limits.ordinary = 7; });
  s.submit(); const original = s.claim(s.find('owner'));
  assert(s.send({ type: 'CONSUME', intentId: original.id, attempt: original.attempt, fence: original }).ok);
  assert(s.send({ type: 'USER_INPUT', text: '请空闲成员并行核对', reviewTargets: ['B', 'builder-1'] }).ok);
  const planner = s.claim(s.find('facilitator'));
  assert(s.send({ type: 'DISCUSSION_PLAN', ...identity(planner), discussionId: planner.discussionId,
    decision: { action: 'review', question: '核对来源', expected: '原始依据', reason: '直接邀请' } }).ok);
  const round = s.context().discussion!.id;
  const members = s.context().intents.filter(work => work.kind === 'assistance' && work.discussionId === round).map(work => work.id);
  assert.equal(members.length, 2, 'PublicPrefix: exactly two promised discussion participants');
  const summary = () => s.context().intents.find(work => work.kind === 'discussionSummary' && work.discussionId === round);
  const successor = () => s.context().intents.find(work => work.kind === 'owner' && work.payload.discussion && (work.payload.discussion as { id: string }).id === round);
  const observe = () => {
    sourceFree(s); const c = s.context(), r = c.discussion!, sum = summary(), next = successor();
    const pending = c.intents.filter(work => work.discussionId === round && work.status === 'pending').length;
    const reserve = r.status === 'delivered' ? Number(next?.status === 'pending') : 1 + pending + Number(r.status === 'collecting');
    return { used: c.usage.ordinary, requests: s.current(original.id).requestCount,
      member1: ['pending', 'inflight', 'done'].indexOf(s.current(members[0]!).status), member2: ['pending', 'inflight', 'done'].indexOf(s.current(members[1]!).status),
      summary: sum ? ['absent', 'pending', 'inflight', 'done'].indexOf(sum.status) : 0,
      handoff: r.status === 'delivered', successor: next?.status === 'inflight', reserve };
  };
  const properties = () => {
    const o = observe();
    assert(o.used + o.reserve <= 7, 'ProtectedDiscussionBudget: model/tool extras must preserve promised participants, synthesis and owner continuation');
    assert(!o.summary || o.member1 === 2 && o.member2 === 2, 'AllSettledBudget: reserve changes must not enable premature synthesis');
    assert(!o.successor || o.handoff, 'OwnerBudgetHandoff: the promised owner runs only after handoff');
  };
  const apply = (action: string) => {
    const member = /^(Claim|Return)([12])$/.exec(action);
    if (member) {
      const work = s.current(members[Number(member[2]) - 1]!);
      if (member[1] === 'Claim') s.claim(work);
      else assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(work), discussionId: round, text: `${work.target} 核对结果`, status: 'success' }).ok);
    } else switch (action) {
      case 'AdditionalRequest': {
        const work = s.current(original.id); assert(s.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok); break;
      }
      case 'DeniedRequest': {
        const work = s.current(original.id); assert.equal(s.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok, false,
          'ProtectedDiscussionBudget: request at protected frontier must be denied'); break;
      }
      case 'ClaimSummary': s.claim(summary()!); break;
      case 'ReturnSummary': {
        const work = summary()!; assert(s.send({ type: 'DISCUSSION_RESULT', ...identity(work), discussionId: round, text: '汇总原始结果', status: 'success' }).ok); break;
      }
      case 'Handoff': assert(s.send({ type: 'SETTLE', intentId: original.id }).ok); break;
      case 'ClaimSuccessor': s.claim(successor()!); break;
      default: throw new Error(`Unknown DiscussionBudget action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

async function reviewQueue(root: string, backend: string, directory: string): Promise<CompositionDriver> {
  const s = await session(root, backend, directory);
  s.submit();
  assert(s.send({ type: 'USER_INPUT', text: '请两位成员评审', reviewTargets: ['B', 'builder-1'] }).ok);
  const planner = s.claim(s.find('facilitator'));
  assert(s.send({ type: 'COORDINATE', ...identity(planner), decision: { action: 'review', question: '核对方案', expected: '原始意见', reason: '直接邀请' } }).ok);
  const originalRound = s.context().review!.id;
  const targets = ['B', 'builder-1'];
  let recovered = false, retried = false;
  const originalTickets: (Intent | undefined)[] = [];
  const help = (index: number) => s.context().assists.filter(item => item.reviewId === s.context().review!.id && item.target === targets[index]).at(-1);
  const work = (index: number) => { const h = help(index); return h ? s.context().intents.find(item => item.payload.requestId === h.id) : undefined; };
  const saved = (index: number) => { const h = help(index); return h ? s.context().results.find(item => item.requestId === h.id && !item.consumed) : undefined; };
  const result = (index: number) => {
    const h = help(index), r = h ? s.context().results.find(item => item.requestId === h.id) : undefined;
    return r ? r.status === 'success' ? 1 : 2 : h && ['success', 'failed'].includes(h.status) ? h.status === 'success' ? 1 : 2 : 0;
  };
  const observe = () => {
    sourceFree(s); const c = s.context(), review = c.review!;
    return { work1: work(0) ? ['absent', 'pending', 'inflight', 'done', 'cancelled'].indexOf(work(0)!.status) : 0,
      work2: work(1) ? ['absent', 'pending', 'inflight', 'done', 'cancelled'].indexOf(work(1)!.status) : 0,
      result1: result(0), result2: result(1), saved1: !!saved(0), saved2: !!saved(1),
      completed1: review.completed.includes(targets[0]!), completed2: review.completed.includes(targets[1]!),
      round: ['reviewing', 'summarizing', 'cancelled', 'pending'].indexOf(review.status), incomplete: !!review.incomplete,
      syntheses: c.intents.filter(item => item.kind === 'owner' && (item.payload.review as { id?: string } | undefined)?.id === originalRound).length,
      liveOwner: c.intents.some(item => item.kind === 'owner' && ['pending', 'inflight'].includes(item.status) && (item.payload.review as { id?: string } | undefined)?.id === originalRound),
      stopped: c.stopped, recovered, retried, epoch: c.epoch };
  };
  const properties = () => {
    const c = s.context(), r = c.review!, o = observe();
    assert.equal(new Set(r.completed).size, r.completed.length, 'ReviewMembership: completed reviewers must be unique');
    assert(r.completed.every(target => r.targets.includes(target)), 'ReviewMembership: only requested members can complete');
    if (r.status === 'reviewing' || r.status === 'summarizing') for (const h of c.assists.filter(item => item.reviewId === r.id && item.consumed)) {
      if (!c.assists.some(next => next.retryOf === h.id)) assert(r.completed.includes(h.target), 'ReviewMembership: consuming an opinion must advance that reviewer exactly once');
    }
    const active = c.assists.filter(h => h.reviewId === r.id && ['pending', 'running', 'answered'].includes(h.status));
    assert(active.length <= 1, 'SequentialReview: collect one requested opinion at a time');
    assert(r.status !== 'summarizing' || o.completed1 && o.completed2, 'AllReviewersSettled: synthesis follows every promised reviewer');
    assert(o.syntheses <= (retried ? 2 : 1), 'UniqueReviewSynthesis: one successor per collection completion, including one repaired review');
    assert(!(o.completed1 && o.result1 === 2 || o.completed2 && o.result2 === 2) || o.incomplete, 'PreserveReviewFailure: failed opinion must remain visible until its explicit retry repairs it');
    assert(!o.stopped || !o.liveOwner, 'StoppedReview: stopped queue cannot dispatch a synthesis');
  };
  const apply = (action: string) => {
    const step = /^(Claim|Success|Failure|Fail|Flush|Late)([12])$/.exec(action);
    if (step) {
      const index = Number(step[2]) - 1, w = work(index), h = help(index);
      switch (step[1]) {
        case 'Claim': originalTickets[index] ??= s.claim(w!); if (w!.status === 'pending' && s.current(w!.id).status === 'pending') s.claim(w!); break;
        case 'Success': case 'Failure':
          assert(s.send({ type: 'RECORD_RESULT', ...identity(w!), requestId: h!.id, resultId: `R:${h!.id}`, status: step[1] === 'Success' ? 'success' : 'failed', answer: '成员原始意见' }).ok); break;
        case 'Fail': assert(s.send({ type: 'WORK_FAILED', intentId: w!.id, ...identity(w!), transient: false, reason: '成员确定失败' }).ok); break;
        case 'Flush': assert(s.engine().flushResults(s.room, s.task), 'ReviewProgress: saved opinion must advance the queue'); break;
        case 'Late': {
          const old = s.context().stopped && w?.status === 'inflight' ? w : originalTickets[index] ?? w!;
          assert.equal(s.send({ type: 'RECORD_RESULT', ...identity(old), requestId: String(old.payload.requestId), resultId: `late:${old.id}`, status: 'success', answer: '旧评审迟到意见' }).ok, false,
            'ReviewRoundIsolation: old or settled reviewer cannot advance the queue'); break;
        }
      }
    } else switch (action) {
      case 'Recover': s.recover(); recovered = true; break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); break;
      case 'Continue': assert(s.send({ type: 'CONTINUE' }).ok); break;
      case 'RetryFirst': {
        const original = help(0)!; assert(s.send({ type: 'RETRY_ASSISTANCE', requestId: original.id, text: '重试失败成员评审' }).ok); retried = true; break;
      }
      default: throw new Error(`Unknown ReviewQueue action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

async function cancelledDiscussion(root: string, variant: string, backend: string, directory: string): Promise<CompositionDriver> {
  const [origin, cancellation, effect] = variant.split('-');
  const s = await session(root, backend, directory, config => {
    if (origin === 'map') { config.inputAnalysis = { enabled: true }; config.models = { default: 'formal', services: { formal: { baseUrl: 'https://invalid.example/v1', model: 'formal' } } }; }
  });
  s.submit(origin === 'map' ? { text: '分别研究甲乙两个来源，必须仅使用公开资料，保留完整要求并汇总全部依据与未知项。' } : {});
  let primary: Intent | undefined;
  if (origin === 'map') {
    const parser = s.claim(s.find('interpretation'));
    assert(s.send({ type: 'INTERPRETATION_RESULT', ...identity(parser), inputId: parser.payload.input && (parser.payload.input as { id: string }).id,
      spec: { ...spec(), action: 'request', decomposition: { kind: 'mapReduce', partitions: [{ id: 'one', objective: '研究甲', expectedOutput: '甲依据' },
        { id: 'two', objective: '研究乙', expectedOutput: '乙依据' }], synthesis: '归并全部依据' } } }).ok);
  } else {
    primary = s.claim(s.find('owner'));
    assert(s.send({ type: 'USER_INPUT', text: '请两位成员核对', reviewTargets: ['B', 'builder-1'] }).ok);
    const planner = s.claim(s.find('facilitator'));
    assert(s.send({ type: 'DISCUSSION_PLAN', ...identity(planner), discussionId: planner.discussionId,
      decision: { action: 'review', question: '核对依据', expected: '原始意见', reason: '直接邀请' } }).ok);
  }
  const oldRound = s.context().discussion!.id;
  const tickets = s.context().intents.filter(work => work.kind === 'assistance' && work.discussionId === oldRound).map(work => s.claim(work));
  assert.equal(tickets.length, 2, 'PublicPrefix: both old members must have been genuinely claimed');
  let recoveries = 0, continued = false, ownerClaimed = false, newStage = 0;
  let operationId: string | undefined, sessionId: string | undefined;
  if (effect === 'physical') {
    const w = tickets[0]!;
    const op = s.engine().requestLocal(s.room, s.task, w.id, w.attempt, { type: 'runCli', executable: 'node', args: ['--version'] }, [], 'workspace:composition-cancel');
    const claimed = s.engine().claimLocal(s.room, s.task, w.id, op.id, w.attempt);
    assert(claimed.response.ok && claimed.operation?.sessionId);
    operationId = op.id; sessionId = claimed.operation.sessionId;
    assert(s.send({ type: 'LOCAL_STARTED', intentId: w.id, operationId, sessionId, workspaceRevision: 'formal-revision', isolated: true }).ok);
  }
  const oldWork = (index: number) => s.current(tickets[index]!.id);
  const newRound = () => s.context().discussion?.id !== oldRound ? s.context().discussion : undefined;
  const newMembers = () => s.context().intents.filter(work => work.kind === 'assistance' && work.discussionId === newRound()?.id);
  const observe = () => {
    sourceFree(s); const op = oldWork(0).localOperations?.find(item => item.id === operationId);
    return { work1: ['pending', 'inflight', 'done', 'cancelled', 'uncertain'].indexOf(oldWork(0).status),
      work2: ['pending', 'inflight', 'done', 'cancelled', 'uncertain'].indexOf(oldWork(1).status),
      local: !op ? 0 : ['running', 'cancelling'].includes(op.status) ? 1 : op.status === 'uncertain' ? 2 : op.status === 'succeeded' ? 3 : -1,
      cancelled: s.context().discussion?.id !== oldRound || s.context().discussion?.status === 'cancelled',
      recoveries, continued, ownerClaimed, newStage, receiptAfterCancel: s.context().trace.some(entry => entry.detail === 'cancel-round')
        && s.context().trace.findIndex(entry => entry.detail === 'trusted-receipt') > s.context().trace.findIndex(entry => entry.detail === 'cancel-round'), primaryBusy: !!primary && s.current(primary.id).status === 'inflight',
      new1: newMembers().some(work => work.target === tickets[0]!.target && work.status === 'inflight'),
      new2: newMembers().some(work => work.target === tickets[1]!.target && work.status === 'inflight') };
  };
  const properties = () => {
    const o = observe();
    if (o.cancelled && recoveries > 0) {
      assert(o.work2 === 2, 'CancelledRetirement: safe obsolete companion must retire during recovery');
      if (o.local === 0 || o.local === 3) assert(o.work1 === 2, 'CancelledRetirement: known obsolete work must retire, never requeue');
      else {
        assert([1, 2].includes(Number(o.local)), 'UnknownMemberRetention: an unconfirmed command cannot be marked settled during recovery');
        assert(o.work1 === 1 || o.work1 === 4, 'UnknownMemberRetention: physical effects must retain the old member until a trusted settlement');
      }
    }
    assert(!o.receiptAfterCancel || o.work1 === 2, 'KnownReceiptRetirement: a trusted settled receipt for cancelled work must release its member immediately');
    assert.equal(s.context().intents.filter(work => work.kind === 'discussionSummary' && work.discussionId === oldRound).length, 0,
      'NoCancelledHandoff: recovering abandoned work must not create its reducer');
    if (newRound()) assert.deepEqual(newRound()!.targets, tickets.map(work => work.target), 'MemberRelease: both retired members must participate in the next public invitation');
    assert(!o.new1 && !o.new2 || o.work1 === 2 && o.work2 === 2 && !o.primaryBusy, 'RoundIsolation: new member work must not coexist with unknown old effects');
  };
  const apply = (action: string) => {
    switch (action) {
      case 'LateOwner': assert(primary); assert(s.send({ type: 'SETTLE', intentId: primary.id }).ok); break;
      case 'Cancel': assert(s.send(cancellation === 'goal' ? { type: 'USER_INPUT', id: 'cancel-round', text: '更换当前目标', goal: { ...s.context().goal, text: '新目标' } }
        : cancellation === 'stop' ? { type: 'STOP', id: 'cancel-round' } : { type: 'EXHAUSTED', id: 'cancel-round', reason: '当前轮次结束，保留未完成范围' }).ok); break;
      case 'Recover': s.recover(); recoveries++; break;
      case 'Reopen': s.recoverRoom(); recoveries++; break;
      case 'KnownReceipt': assert(s.send({ type: 'LOCAL_RESULT', id: 'trusted-receipt', intentId: tickets[0]!.id, operationId, sessionId,
        result: { ok: true, code: 'succeeded', data: { exitCode: 0, stdout: '已核对原效果' } }, settled: true, effectsKnown: true }).ok); break;
      case 'BlockedContinue': assert.equal(s.send({ type: 'CONTINUE' }).code, 'UNRESOLVED_WORK', 'UnknownMemberRetention: unknown effects must block explicit continuation'); break;
      case 'Continue': assert(s.send({ type: 'CONTINUE' }).ok); continued = true; break;
      case 'ClaimOwner': s.claim(s.find('owner')); ownerClaimed = true; break;
      case 'Invite': assert(s.send({ type: 'USER_INPUT', text: '请原两位成员重新核对', reviewTargets: tickets.map(work => work.target) }).ok); newStage = 1; break;
      case 'ClaimPlanner': s.claim(s.find('facilitator')); newStage = 2; break;
      case 'Plan': {
        const planner = s.find('facilitator', 'inflight');
        assert(s.send({ type: 'DISCUSSION_PLAN', ...identity(planner), discussionId: planner.discussionId,
          decision: { action: 'review', question: '重新核对', expected: '当前依据', reason: '直接邀请' } }).ok); newStage = 3; break;
      }
      case 'ClaimNew1': case 'ClaimNew2': s.claim(newMembers().find(work => work.target === tickets[action === 'ClaimNew1' ? 0 : 1]!.target)!); break;
      case 'Late1': case 'Late2': {
        const ticket = tickets[action === 'Late1' ? 0 : 1]!;
        assert.equal(s.send({ type: 'DISCUSSION_RESULT', ...identity(ticket), discussionId: oldRound, text: '旧轮次迟到结果', status: 'success' }).ok, false,
          'RoundIsolation: old round completion must not advance the new invitation'); break;
      }
      default: throw new Error(`Unknown CancelledDiscussion action ${action}`);
    }
    properties(); return observe();
  };
  return { observe, apply, properties, close: s.close };
}

export interface CompositionScenarioResult {
  observations: Record<string, number | boolean>[];
  final: Record<string, number | boolean>;
  actions: string[];
}
export async function runCompositionScenario(model: string, variant: string, actions: string[], backend = 'sqlite'): Promise<CompositionScenarioResult> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const directory = mkdtempSync(join(tmpdir(), 'squad-composition-scenario-'));
  const driver = await createCompositionDriver(resolve('.'), model, variant, backend, directory);
  try {
    driver.properties(); const observations = [driver.observe()];
    for (const action of actions) observations.push(driver.apply(action));
    return { observations, final: driver.observe(), actions };
  } finally { driver.close(); rmSync(directory, { recursive: true, force: true }); }
}
