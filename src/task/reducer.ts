import { hostSessionActive, revokeHostSession } from '../host-session.js';
import { type BoardEntry, type Decision, type TaskContext, type TaskEvent } from '../types.js';
import { permissionProblem } from './policy.js';
import { capabilities, completeProblem, deliveryHandoffPending, discussionActive, discussionIncomplete, fence, fresh, hasOrdinary, inflight, ok, recoveryIssue, reject } from './facts.js';
import { cancelWork, conversationInput, coordinate, deliveryArtifacts, finish, intent, message, owner, release, saveReports } from './operations.js';
import { applyLocalEvent, localEnabled, localPhysicalPending, recoverLocalOperations, type LocalEvent } from '../local-operation.js';
import { acceptDiscussion, discussionFailed, planDiscussion, startDiscussion } from './discussion.js';
import { acceptHelpResult, advanceReview, helpTools, refreshReviewFailures, requestReview, resetReviewAtBoundary, savedHelpResult, startHelp } from './assistance.js';
import { recordInput } from './input.js';
import { deliveryVersionProblem, retainLegacyPublication } from './delivery.js';
import { canRetryWork } from './budget.js';
import { bindDraftReferences, deliveryCheckGaps, deliveryPreflight, deliveryRevision } from '../delivery-acceptance.js';
import { applyHostRetry, cancelHostRetries, expireHostRetry, pendingHostRetry, settleHostRetryOperation } from '../host-retry.js';

export function reduce(original: TaskContext, e: TaskEvent): TaskContext {
  const c = structuredClone(original);
  const problem = permissionProblem(c, e);
  if (problem) { reject(c, problem); return c; }
  if (['INTERPRETATION_RESULT', 'HELP', 'HELP_RESULT', 'RECORD_RESULT', 'COORDINATE', 'BLOCKED', 'WAIT_USER', 'DELIVER', 'CHECK_RESULT', 'TOOL', 'SETTLE'].includes(e.type)) release(c, e.workId);
  ok(c); c.lastActivityAt = e.at;
  c.trace.push({ event: e.type, detail: e.id, at: e.at });
  if (e.type.startsWith('LOCAL_')) {
    const local = e as TaskEvent & LocalEvent;
    applyLocalEvent(c, local);
    settleHostRetryOperation(c, local.intentId, local.operationId, e.at);
    return c;
  }
  if (e.workId === c.hostRetryBatch?.workId && e.workId && ['HELP', 'BLOCKED', 'WAIT_USER', 'DELIVER', 'TOOL'].includes(e.type)) delete c.hostRetryBatch;
  switch (e.type) {
    case 'REVOKE_HOST_SESSION': revokeHostSession(c, e.id); break;
    case 'REQUEST_HOST_RETRY': applyHostRetry(c, e); break;
    case 'HOST_RETRY_EXPIRE': expireHostRetry(c, e.at); break;
    case 'DISCUSSION_PLAN': planDiscussion(c, e); break;
    case 'DISCUSSION_RESULT': acceptDiscussion(c, e); break;
    case 'DISCUSSION_HANDOFF':
      c.discussion!.status = 'delivered';
      c.deferredCoordination = false;
      cancelWork(c, e);
      owner(c, e, { reason: '吸收协调员汇总和全部成员原始意见，在已有草稿上继续完善；区分共识、分歧、依据和未完成项。', previousBlocker: c.reason });
      message(c, e, 'facilitator', `讨论汇总及成员原始意见已交给 ${c.owner}，已安排继续完善方案。`, 'notice', { recipient: c.owner });
      break;
    case 'INTERPRETATION_RESULT': {
      const input = c.inputAnalyses!.find(input => input.id === e.inputId)!;
      input.spec = structuredClone(e.spec); input.status = e.spec.clarification ? 'clarification' : 'resolved';
      c.trace.push({ event: 'INPUT_INTERPRETED', at: e.at, detail: JSON.stringify({ inputId: input.id, workId: input.workId, status: input.status }) });
      if (e.spec.clarification) {
        c.reason = e.spec.clarification; message(c, e, 'facilitator', e.spec.clarification, 'notice');
      } else if (!c.inputs.some(note => !note.applied) && c.review?.status !== 'pending') {
        owner(c, e, { reason: 'Plan from the validated user intent and preserve the original goal' });
      }
      break;
    }
    case 'HELP': startHelp(c, e, e.requestId, e.target, e.question, e.expected, e.refs ?? [], false, e.requiredTools); break;
    case 'RECORD_RESULT': {
      const h = c.assists.find(h => h.id === e.requestId)!;
      const artifactIds = saveReports(c, e, e.answer, h.target, e.artifacts);
      h.status = 'answered';
      c.results.push({ requestId: e.requestId, resultId: e.resultId, status: e.status, answer: e.answer, consumed: false, artifactIds,
        ...(e.summary === undefined ? {} : { summary: e.summary }), ...(e.workId ? { workId: e.workId } : {}), ...fence(c) });
      break;
    }
    case 'HELP_RESULT': acceptHelpResult(c, e); break;
    case 'RETRY_ASSISTANCE': {
      const h = c.assists.find(h => h.id === e.requestId)!;
      if (e.config) c.config.bots = structuredClone(e.config.bots);
      message(c, e, 'user', e.text, 'user', { requestId: h.id });
      const saved = savedHelpResult(c, h.id);
      if (saved) { acceptHelpResult(c, { ...e, ...saved, type: 'HELP_RESULT' }); break; }
      if (c.stopped || c.outcome !== null) c.epoch++;
      c.stopped = false; c.outcome = null; c.candidate = null; c.reason = ''; c.usage.retries++;
      c.deferredCoordination = false;
      for (const note of c.inputs) note.applied = true;
      if (h.reviewId && c.review) {
        Object.assign(c.review, fence(c)); c.review.status = 'reviewing';
        c.review.completed = c.review.completed.filter(target => target !== h.target);
        refreshReviewFailures(c);
      }
      startHelp(c, e, `${c.taskId}:help:${c.nextSeq++}`, h.target, h.question, h.expected, h.refs, true, helpTools(c, h), h.reviewId, h.id);
      break;
    }
    case 'BLOCKED':
      if (inflight(c).length || discussionActive(c)) { c.deferredCoordination = true; c.reason = e.reason; }
      else coordinate(c, e, e.reason);
      break;
    case 'COORDINATE': {
      const d: Decision = e.decision;
      c.trace.push({ event: 'COORDINATION_DECISION', at: e.at, detail: JSON.stringify({ decision: d,
        basis: { reason: c.reason, ...fence(c), boardRefs: c.board.map(entry => entry.id), artifactRefs: c.artifacts.map(artifact => artifact.id), repeat: c.repeat } }) });
      if (d.action === 'review') {
        c.review!.status = 'reviewing'; c.review!.question = d.question; c.review!.expected = d.expected;
        advanceReview(c, e);
      }
      if (d.action === 'continue') owner(c, e, { reason: d.reason });
      if (d.action === 'assist') startHelp(c, e, `${c.taskId}:help:${c.nextSeq++}`, d.target, d.question, d.expected, [], true);
      if (d.action === 'replan') {
        c.usage.replans++; c.localSkillVersions = [];
        c.board.push({ id: `${c.taskId}:plan:${c.usage.replans}`, kind: 'opinion', author: 'facilitator', text: d.plan, sources: [], verified: false, revision: 1, goalVersion: c.goalVersion });
        owner(c, e, { plan: d.plan, retainedEvidence: c.board.map(b => b.id), reason: d.reason });
      }
      if (d.action === 'askUser') { cancelWork(c, e); c.reason = d.question; message(c, e, 'facilitator', d.question, 'notice'); }
      if (d.action === 'finish' && !pendingHostRetry(c)) finish(c, e, c.artifacts.length || c.candidate ? 'partial' : 'failed', d.reason);
      break;
    }
    case 'WAIT_USER': cancelWork(c, e); c.reason = e.question; message(c, e, c.owner, e.question, 'answer'); break;
    case 'USER_INPUT': {
      if (e.history) c.history = e.history;
      message(c, e, 'user', e.text, 'user');
      if (!e.goal && e.reviewTargets?.length && (discussionActive(c) || ((!c.review || ['complete', 'cancelled'].includes(c.review.status)) && inflight(c).some(work => ['owner', 'tool', 'assistance'].includes(work.kind))))) {
        startDiscussion(c, e); break;
      }
      if (e.decision) c.board.push({ id: e.id, kind: 'decision', text: e.text, author: 'user', sources: [], verified: false, revision: 1, goalVersion: c.goalVersion });
      else {
        c.inputs.push({ id: e.id, text: e.text, applied: false });
        if (e.goal) {
          c.goal = e.goal; c.goalVersion++; c.localSkillVersions = []; c.candidate = null; delete c.deliveryGaps;
          cancelWork(c, e, true); cancelHostRetries(c, 'STALE_WORK');
          for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'clarification', 'failed'].includes(input.status)) input.status = 'cancelled';
          for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        }
      }
      recordInput(c, e.id, e.text, e.reviewTargets?.length ? 'review' : e.decision ? 'decision' : 'supplement');
      if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
      break;
    }
    case 'HUMAN_DECISION': {
      if (e.history) c.history = e.history;
      message(c, e, 'user', e.text, 'user');
      c.board.push({ id: e.id, kind: 'decision', text: e.text, author: 'user', sources: [e.id], verified: false, revision: 1, goalVersion: c.goalVersion });
      if (c.outcome === null) {
        c.goal.constraints.push(`用户决定：${e.text}`); c.goalVersion++; c.localSkillVersions = []; c.candidate = null; delete c.deliveryGaps;
        for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight'].includes(input.status)) input.status = 'cancelled';
        c.inputs.push({ id: e.id, text: e.text, applied: false }); cancelWork(c, e, true); cancelHostRetries(c, 'STALE_WORK');
        for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
        recordInput(c, e.id, e.text, e.reviewTargets?.length ? 'review' : 'decision');
      }
      break;
    }
    case 'BOUNDARY':
      for (const note of c.inputs) note.applied = true;
      if (c.review && !['cancelled', 'complete'].includes(c.review.status)) resetReviewAtBoundary(c, e);
      else owner(c, e, { reason: 'Apply latest user input' });
      c.deferredCoordination = false; break;
    case 'HANDOFF': {
      const from = c.owner;
      cancelWork(c, e); c.owner = e.owner;
      c.trace.push({ event: 'OWNERSHIP_HANDOFF', at: e.at, detail: JSON.stringify({ from, to: e.owner, ...fence(c),
        boardRefs: c.board.map(entry => entry.id), artifactRefs: c.artifacts.map(artifact => artifact.id) }) });
      message(c, e, 'facilitator', `任务从 ${from} 交接给 ${e.owner}`, 'notice');
      owner(c, e, { handoff: true, boardRefs: c.board.map(b => b.id) }); break;
    }
    case 'DELIVER': {
      const versionProblem = deliveryVersionProblem(c, e);
      if (versionProblem) {
        c.reason = versionProblem;
        if (hasOrdinary(c)) owner(c, e, { deliveryConflict: versionProblem });
        else finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed', versionProblem);
        reject(c, versionProblem.split(':')[0]!);
        break;
      }
      const { acceptance, gaps, repeated } = deliveryPreflight(c, e);
      const artifactIds = saveReports(c, e, e.text, c.owner, e.artifacts);
      const requiresBoundCheck = !!c.publishedDelivery || e.artifacts?.some(artifact => !!artifact.replacesArtifactId);
      cancelWork(c, e); c.candidate = { text: e.text, artifactIds: [...new Set([...e.artifactIds, ...artifactIds])], goalVersion: c.goalVersion,
        revision: deliveryRevision(c, e), ...(e.backgroundArtifactIds?.length ? { backgroundArtifactIds: [...new Set(e.backgroundArtifactIds)] } : {}), ...(requiresBoundCheck ? { requiresBoundCheck: true } : {}),
        ...(e.summary === undefined ? {} : { summary: e.summary }), ...(e.workId ? { workId: e.workId } : {}),
        ...(acceptance ? { acceptance: bindDraftReferences(acceptance, artifactIds) } : {}) };
      if (gaps.length) c.deliveryGaps = gaps;
      else if (c.deliveryGaps) delete c.deliveryGaps;
      if (deliveryHandoffPending(c) || pendingHostRetry(c)) break;
      if (gaps.length) {
        const reason = gaps.map(gap => gap.reason).join('；');
        if (hasOrdinary(c) && !repeated) {
          c.reason = reason;
          owner(c, e, { reason, deliveryGaps: gaps });
        } else finish(c, e, 'partial', reason);
        break;
      }
      intent(c, e.at, 'check', 'facilitator', { goal: c.goal, ...deliveryArtifacts(c), board: c.board, ...conversationInput(c), deterministicGap: completeProblem(c) });
      break;
    }
    case 'CHECK_RESULT': {
      c.consumedResults.push(e.resultId);
      const gaps = deliveryCheckGaps(c, e);
      const problem = completeProblem(c);
      if (c.candidate?.acceptance) {
        c.deliveryGaps = gaps;
        (c.deliveryAssessments ??= []).push({ candidateRevision: c.candidate.acceptance.revision, judgments: e.criteriaResults ?? [], gaps });
      }
      if (pendingHostRetry(c)) break;
      if (discussionIncomplete(c)) finish(c, e, 'partial', discussionIncomplete(c)!);
      else if (c.review?.incomplete) finish(c, e, 'partial', c.review.incomplete);
      else if (e.passed && !problem && !gaps.length) {
        if (c.deliveryGaps) delete c.deliveryGaps;
        finish(c, e, 'complete', '');
      } else if (c.candidate?.acceptance && hasOrdinary(c) && !deliveryHandoffPending(c) && !c.intents.some(localPhysicalPending)) {
        c.reason = [problem, ...gaps.map(gap => gap.reason)].filter(Boolean).join('；') || 'Incomplete delivery';
        owner(c, e, { reason: c.reason, deliveryGaps: gaps });
      } else if (hasOrdinary(c)) coordinate(c, e, [problem, ...e.gaps].filter(Boolean).join('; ') || 'Incomplete delivery');
      else {
        finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed',
          [problem, ...(gaps.length ? gaps.map(gap => gap.reason) : e.gaps)].filter(Boolean).join('；') || 'Budget exhausted');
      }
      break;
    }
    case 'STOP':
      if (e.text) message(c, e, 'user', e.text, 'user');
      c.stopped = true; c.reason = 'User requested stop'; cancelWork(c, e, true); cancelHostRetries(c, 'STOPPED');
      for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'clarification', 'failed'].includes(input.status)) input.status = 'cancelled';
      if (c.review) c.review.status = 'cancelled';
      for (const h of c.assists) if (['pending', 'running', 'answered'].includes(h.status)) h.status = 'cancelled';
      break;
    case 'SETTLE': {
      const work = c.intents.find(i => i.id === e.intentId);
      release(c, e.intentId);
      if (c.hostRetryBatch?.workId === e.intentId) cancelHostRetries(c, 'WORK_NOT_STARTED');
      if (work?.kind === 'tool' && !c.stopped && fresh(c, { ...e, fence: { epoch: work.epoch, goalVersion: work.goalVersion } })) owner(c, e, { toolResult: work.id });
      break;
    }
    case 'CONTINUE':
      if (e.text) message(c, e, 'user', e.text, 'user');
      if (e.extraOrdinary) c.config.limits.ordinary += e.extraOrdinary;
      retainLegacyPublication(c, e.at);
      c.epoch++; c.stopped = false; c.outcome = null; c.reason = '';
      for (const input of c.inputAnalyses ?? []) if (input.source === 'model' && input.goalVersion === c.goalVersion
        && ['failed', 'clarification', 'cancelled'].includes(input.status) && input.error !== 'SUPERSEDED_INPUT') {
        input.epoch = c.epoch; input.status = 'pending'; delete input.workId; delete input.error;
      }
      for (const h of c.assists) if (['pending', 'running', 'answered'].includes(h.status)) h.status = 'cancelled';
      if (c.review && (c.review.status !== 'complete' || c.review.incomplete)) {
        requestReview(c, e.id, c.review.request, c.review.targets); c.candidate = null;
      } else owner(c, e, { continued: true });
      break;
    case 'TICK': c.processedSignals.push(e.id); coordinate(c, e, 'No evidenced progress by deadline'); break;
    case 'ACTIVITY': break;
    case 'PROGRESS': c.progressRefs.push(...e.refs); c.lastProgressAt = e.at; c.nextCheckAt = e.at + c.config.limits.progressIntervalMs; c.repeat.count = 0; break;
    case 'FAILURE_SIGNAL': {
      const fingerprint = JSON.stringify([e.operation, e.parameters, e.resource, e.error, e.result]).normalize('NFKC');
      c.repeat = { fingerprint, count: c.repeat.fingerprint === fingerprint ? c.repeat.count + 1 : 1 };
      if (c.repeat.count >= c.config.limits.repeatThreshold) {
        if (inflight(c).length || discussionActive(c)) { c.deferredCoordination = true; c.reason = 'Repeated failure without progress'; }
        else coordinate(c, e, 'Repeated failure without progress');
      }
      break;
    }
    case 'BOARD_WRITE': {
      const old = c.board.find(b => b.id === e.entryId);
      const item: BoardEntry = { id: e.entryId, revision: (old?.revision ?? 0) + 1, author: e.author, text: e.text, kind: e.kind, sources: e.sources, verified: false, goalVersion: c.goalVersion };
      if (old) { c.boardHistory.push(old); c.board[c.board.indexOf(old)] = item; } else c.board.push(item);
      break;
    }
    case 'ARTIFACT': {
      const { id, name, content, author, workId } = e.artifact;
      c.artifacts.push({ id, name, content, goalVersion: c.goalVersion, documentId: id, revision: 1,
        ...(author ? { author } : {}), ...(workId ? { workId } : {}) });
      c.progressRefs.push(id);
      c.repeat.count = 0; c.lastProgressAt = e.at; c.nextCheckAt = e.at + c.config.limits.progressIntervalMs;
      break;
    }
    case 'CLAIM': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      // Legacy work receives trusted identity in the same pure transition as its claim.
      if (work.kind === 'facilitator' && work.payload.owner === undefined) work.payload.owner = c.owner;
      work.localSkills = [...(work.localSkills ?? []).filter(s => !c.localSkillVersions?.some(p => p.skillId === s.skillId)), ...(c.localSkillVersions ?? [])];
      work.status = 'inflight'; work.attempt++; work.requestCount = 0;
      if (c.hostRetryBatch?.workId === work.id) {
        if (!c.hostRetryBatch.ownerClaimed) c.usage.ordinary++;
        c.hostRetryBatch.ownerClaimed = true;
      } else if (work.bucket !== 'none') c.usage[work.bucket]++;
      if (work.kind === 'interpretation') c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'inflight';
      if (work.kind === 'assistance' && !work.discussionId) c.assists.find(h => h.id === work.payload.requestId)!.status = 'running';
      break;
    }
    case 'CONSUME': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      if (work.requestCount > 0 && work.bucket !== 'none') c.usage[work.bucket]++;
      work.requestCount++;
      break;
    }
    case 'REGENERATE_MODEL_OUTPUT': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      c.usage.retries++;
      work.outputRepair = { count: (work.outputRepair?.count ?? 0) + 1, issue: e.issue };
      c.trace.push({ event: 'MODEL_OUTPUT_REPAIR', at: e.at, detail: JSON.stringify({ intentId: work.id, issue: e.issue, count: work.outputRepair.count }) });
      break;
    }
    case 'WORK_FAILED': {
      const work = c.intents.find(i => i.id === e.intentId);
      if (!work) { reject(c, 'UNKNOWN_WORK'); break; }
      if (work.discussionId) {
        if (discussionActive(c) && work.discussionId === c.discussion!.id) discussionFailed(c, e, work, e.reason);
        else release(c, work.id);
        break;
      }
      if (work.kind === 'cancel') { work.status = 'done'; c.reason = `Cancellation not confirmed: ${e.reason}`; break; }
      if (e.resultUncertain || work.replay === 'unsafe') {
        work.status = 'uncertain'; c.reason = `Result uncertain; reconcile before retry: ${e.reason}`;
      } else if (canRetryWork(c, e)) {
        c.usage.retries++; work.status = 'pending'; work.deadline = e.at + c.config.limits.workTimeoutMs;
        if (work.kind === 'interpretation') c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'pending';
      } else {
        const failureReason = e.transient && c.usage.retries >= c.config.limits.retries ? `${e.reason}（重试额度已用尽）` : e.reason;
        release(c, work.id); c.reason = failureReason;
        if (c.hostRetryBatch?.workId === work.id) cancelHostRetries(c, failureReason);
        if (work.kind === 'facilitator') {
          c.reason = `协调工作未能完成：${failureReason}。请重试或补充处理方式。`;
          message(c, e, 'facilitator', c.reason, 'notice');
        }
        if (work.kind === 'interpretation') {
          const input = c.inputAnalyses!.find(input => input.workId === work.id)!;
          input.status = 'failed'; input.error = failureReason;
          message(c, e, 'facilitator', `输入意图解析失败：${failureReason}`, 'notice');
        }
        if (work.kind === 'assistance') {
          const h = c.assists.find(h => h.id === work.payload.requestId)!;
          h.status = 'failed'; h.answer = failureReason; h.consumed = true;
          message(c, e, h.target, failureReason, 'answer', { requestId: h.id });
          if (h.reviewId && h.reviewId === c.review?.id) advanceReview(c, e, h);
          else {
            for (const note of c.inputs) note.applied = true;
            owner(c, e, { requestId: h.id, status: 'failed', answer: failureReason, requiresAssessment: true });
          }
        }
      }
      break;
    }
    case 'RECOVER': {
      c.hostSession = undefined;
      const issue = recoveryIssue(c, e.config);
      c.config.bots = e.config.bots; // Current permissions always win.
      c.config.localTools = { enabled: e.config.localTools?.enabled !== false };
      for (const work of c.intents) recoverLocalOperations(work, e.id);
      c.config.skillSearch = { enabled: e.config.skillSearch?.enabled !== false };
      c.config.webTools = { enabled: e.config.webTools?.enabled !== false };
      for (const work of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && ['owner', 'assistance', 'facilitator', 'check'].includes(i.kind))) {
        const legacy = (work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools === undefined;
        work.payload.capabilities = { ...capabilities(c, work.target), localTools: !legacy && localEnabled(e.config, work.target) };
      }
      if (issue) { cancelWork(c, e, true); cancelHostRetries(c, 'INCOMPATIBLE_EXECUTION'); c.reason = issue; reject(c, 'INCOMPATIBLE_EXECUTION'); break; }
      for (const work of c.intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel')) {
        if (localPhysicalPending(work) || work.replay === 'unsafe') { work.status = 'uncertain'; c.reason = 'Reconcile uncertain external result'; }
        else {
          work.status = 'pending';
          if (work.kind === 'interpretation') c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'pending';
        }
      }
      break;
    }
    case 'TOOL':
      cancelWork(c, e); intent(c, e.at, 'tool', c.owner, { tool: e.tool, ...e.payload }, e.replay); break;
    case 'EXHAUSTED': finish(c, e, c.candidate || c.artifacts.length ? 'partial' : 'failed', e.reason); break;
    case 'RECONCILE': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      work.status = 'done';
      c.trace.push({ event: 'RECONCILED', detail: `${work.id}:${e.resolution}:${e.detail}`, at: e.at });
      c.reason = 'External result reconciled; waiting for explicit continuation';
      break;
    }
  }
  if (c.hostSession && !hostSessionActive(c)) revokeHostSession(c, e.id);
  return c;
}
