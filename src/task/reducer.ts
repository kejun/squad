import { startMapReduce } from './map-reduce.js';
import { beginDeliveryRevision, bindDeliveryCheck, deliveryCandidate, resetDeliveryMaterials, settleDeliveryCycle } from './delivery-cycle.js';
import { mapReduceCapacity, mapReduceConcurrency } from './map-reduce-capacity.js';
import { hostSessionActive, revokeHostSession } from '../host-session.js';
import { artifactSourceMetadata, type BoardEntry, type Decision, type TaskContext, type TaskEvent } from '../types.js';
import { permissionProblem } from './policy.js';
import { canRetireDiscussionWork, capabilities, discussionActive, fence, fresh, inflight, ok, recoveryIssue, reject } from './facts.js';
import { cancelWork, coordinate, continueOwner, finish, intent, message, owner, release, saveReports } from './operations.js';
import { applyLocalEvent, cancelLocalOperations, localEnabled, localPhysicalPending, localAwaitingApproval, recoverLocalOperations, type LocalEvent } from '../local-operation.js';
import { acceptDiscussion, discussionFailed, planDiscussion, startDiscussion } from './discussion.js';
import { acceptHelpResult, advanceReview, helpTools, refreshReviewFailures, requestReview, resetReviewAtBoundary, savedHelpResult, startHelp } from './assistance.js';
import { recordInput } from './input.js';
import { automaticRevisionActive, canReviseDelivery, checkDisposition, checkReferenceSources, deliveryInterruptionPending, deliverySubmissionProblem, deliveryVersionProblem, hasDeliveryRetryPermit, isBoundedCheck, newDeliveryCycle, recoveryCheckExhausted, retainLegacyPublication, saveCheckDiagnostic, settlingDeliveryCheck } from './delivery.js';
import { canRetryDeliveryCheck, canRetryWork, reserveDeliveryRetry } from './budget.js';
import { checkReviewSources, deliveryJudgments, deliveryPreflight } from '../delivery-acceptance.js';
import { adoptLegacyTerminalConfig } from './protocol.js';
import { applyHostRetry, cancelHostRetries, claimHostRetryOwner, expireHostRetry, pendingHostRetry, settleHostRetryOperation } from '../host-retry.js';
import { deliveryEvidence } from './evidence.js';
import { deliveryVerificationPlan } from './verification.js';
import { preserveSourceReference } from '../input-intent.js';
import { resolveMapRecoveries } from './map-recovery.js';
import { recordToolFailure } from './tool-recovery.js';
import { ensureResilience, openHumanGate, decideHumanGate, executionNotStarted, freezeIncomplete, taskHumanGate, answerTaskGate, syncLocalApprovalGate, recordApprovalExplanation, requiredHumanFailure, authorizationFailure,
  windowExpired, archiveFrozen, replaceProcessingWindow, adoptCleanup, settleCleanup, resiliencePolicy, processingWindow, safeFailureRetry, requeueSafeWork } from './resilience.js';
import { recordAcquisition, resourceAcquisitionProblem } from '../resource-acquisition.js';

function finishDelivery(c: TaskContext, e: TaskEvent, detail: string, code?: string) {
  if (c.candidate && code) c.candidate.deliveryIssue = { code, detail };
  const usable = c.candidate?.text.trim() || c.artifacts.some(item => item.goalVersion === c.goalVersion && item.content.trim());
  finish(c, e, usable ? 'partial' : 'failed', detail);
}

function reviseDelivery(c: TaskContext, e: TaskEvent, reason: string) {
  c.reason = reason;
  const priorFindings = deliveryJudgments(c, c.candidate?.revision).filter(item => item.status !== 'passed');
  owner(c, e, { deliveryRevision: true, reason, priorFindings });
  beginDeliveryRevision(c, c.intents.at(-1)!);
}

export function reduce(original: TaskContext, e: TaskEvent): TaskContext {
  const c = structuredClone(original);
  const received = e;
  const resultEvent = e.type === 'RECORD_RESULT' || e.type === 'HELP_RESULT' ? e : undefined;
  if (resultEvent?.status === 'success' && !c.results.some(r => r.resultId === resultEvent.resultId)) {
    const work = c.intents.find(w => w.payload.requestId === resultEvent.requestId && w.epoch === c.epoch && w.goalVersion === c.goalVersion);
    if (work?.deadline !== null && work?.deadline !== undefined && e.at >= work.deadline)
      e = { ...resultEvent, status: 'timeout', answer: '协助已超时；迟到原始结果保留在历史' };
  }
  const problem = permissionProblem(c, e);
  if (problem) { reject(c, problem); return c; }
  if (['INTERPRETATION_RESULT', 'HELP', 'HELP_RESULT', 'RECORD_RESULT', 'COORDINATE', 'BLOCKED', 'WAIT_USER', 'DELIVER', 'TOOL'].includes(e.type)) release(c, e.workId);
  ok(c); c.lastActivityAt = e.at;
  ensureResilience(c);
  if (e !== received) c.lateResults.push(received);
  c.trace.push({ event: e.type, detail: e.id, at: e.at });
  if (e.type.startsWith('LOCAL_')) {
    const local = e as TaskEvent & LocalEvent;
    const work = c.intents.find(item => item.id === local.intentId);
    const resumeCheck = isBoundedCheck(work) && work.status === 'uncertain';
    applyLocalEvent(c, local);
    syncLocalApprovalGate(c, local);
    if (c.resilience?.frozen && work) {
      cancelLocalOperations(work);
      if (!localPhysicalPending(work)) work.status = 'done';
    }
    settleCleanup(c, e.at);
    settleHostRetryOperation(c, local.intentId, local.operationId, e.at);
    if ((e.type === 'LOCAL_RESULT' || e.type === 'LOCAL_RECONCILE') && work && canRetireDiscussionWork(c, work)) release(c, work.id);
    if (resumeCheck && taskHumanGate(c)) return c;
    if (resumeCheck && work.status === 'pending' && work.requestCount > 0 && !hasDeliveryRetryPermit(c, work)) {
      if (deliveryInterruptionPending(c)) release(c, work.id);
      else if (canRetryDeliveryCheck(c, work, e.at)) reserveDeliveryRetry(c, work);
      else finishDelivery(c, e, '检查未完成，无法重新授权中断的检查请求', 'CHECK_RECOVERY_EXHAUSTED');
    }
    return c;
  }
  switch (e.type) {
    case 'HUMAN_GATE_DECISION': decideHumanGate(c, e); break;
    case 'EXECUTION_NOT_STARTED': executionNotStarted(c, e); break;
    case 'RECORD_ACQUISITION': recordAcquisition(c, e); break;
    case 'REVOKE_HOST_SESSION': revokeHostSession(c, e.id); break;
    case 'REQUEST_HOST_RETRY':
      adoptLegacyTerminalConfig(c, e.currentConfig);
      retainLegacyPublication(c, e.at);
      applyHostRetry(c, e);
      if (!c.deliveryCycle && c.outcome === null) c.deliveryCycle = newDeliveryCycle();
      break;
    case 'HOST_RETRY_EXPIRE': expireHostRetry(c, e.at); break;
    case 'HOST_RETRY_RECONCILE': break; // The automatic batch transition reads the saved work and operation states.
    case 'DISCUSSION_PLAN': planDiscussion(c, e); break;
    case 'DISCUSSION_RESULT': {
      const work = c.intents.find(w => w.id === e.workId)!;
      const issue = e.status === 'success' && !(work.kind === 'assistance' && c.discussion?.mapReduce?.queue) ? resourceAcquisitionProblem(c, work) : null;
      if (issue) { c.discussion!.incomplete = issue; acceptDiscussion(c, { ...e, status: 'partial' }); }
      else acceptDiscussion(c, e);
      break;
    }
    case 'DISCUSSION_HANDOFF':
      c.discussion!.status = 'delivered';
      c.deferredCoordination = false;
      cancelWork(c, e);
      owner(c, e, { reason: '吸收协调员汇总和全部成员原始意见，在已有草稿上继续完善；区分共识、分歧、依据和未完成项。', previousBlocker: c.reason });
      message(c, e, 'facilitator', `讨论汇总及成员原始意见已交给 ${c.owner}，已安排继续完善方案。`, 'notice', { recipient: c.owner });
      break;
    case 'INTERPRETATION_RESULT': {
      const input = c.inputAnalyses!.find(input => input.id === e.inputId)!;
      input.spec = preserveSourceReference(c, structuredClone(e.spec)); input.status = e.spec.clarification ? 'clarification' : 'resolved';
      c.trace.push({ event: 'INPUT_INTERPRETED', at: e.at, detail: JSON.stringify({ inputId: input.id, workId: input.workId, status: input.status }) });
      if (e.spec.clarification) {
        c.reason = e.spec.clarification; message(c, e, 'facilitator', e.spec.clarification, 'notice');
        openHumanGate(c, e, { kind: 'clarification', question: e.spec.clarification, ...(e.workId ? { workId: e.workId } : {}) });
      } else if (!c.inputs.some(note => !note.applied) && c.review?.status !== 'pending' && !startMapReduce(c, e)) {
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
      const gate = answerTaskGate(c, e);
      if (gate && windowExpired(c, e.at) && !taskHumanGate(c)) { message(c, e, 'user', e.text, 'user', { requestId: e.requestId }); freezeIncomplete(c, e, '人类已明确重试，原自动处理窗口已耗尽'); break; }
      const h = c.assists.find(h => h.id === e.requestId)!;
      if (e.config) c.config.bots = structuredClone(e.config.bots);
      message(c, e, 'user', e.text, 'user', { requestId: h.id });
      const saved = savedHelpResult(c, h.id);
      if (saved) {
        c.stopped = false; c.outcome = null; c.reason = ''; archiveFrozen(c);
        c.deliveryCycle = newDeliveryCycle();
        acceptHelpResult(c, { ...e, ...saved, type: 'HELP_RESULT' }); break;
      }
      if (c.stopped || c.outcome !== null) c.epoch++;
      archiveFrozen(c);
      c.stopped = false; c.outcome = null; c.candidate = null; c.reason = ''; c.usage.retries++;
      resetDeliveryMaterials(c);
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
      if (c.intents.some(work => work.id === e.workId && work.payload.deliveryRevision === true) && !deliveryInterruptionPending(c)) {
        finishDelivery(c, e, e.reason, 'DELIVERY_REVISION_FAILED');
      } else if (inflight(c).length || discussionActive(c)) { c.deferredCoordination = true; c.reason = e.reason; }
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
      if (d.action === 'continue') continueOwner(c, e, d.reason);
      if (d.action === 'assist') startHelp(c, e, `${c.taskId}:help:${c.nextSeq++}`, d.target, d.question, d.expected, [], true);
      if (d.action === 'replan') {
        c.usage.replans++; c.localSkillVersions = [];
        c.board.push({ id: `${c.taskId}:plan:${c.usage.replans}`, kind: 'opinion', author: 'facilitator', text: d.plan, sources: [], verified: false, revision: 1, goalVersion: c.goalVersion });
        owner(c, e, { plan: d.plan, retainedEvidence: c.board.map(b => b.id), reason: d.reason });
      }
      if (d.action === 'askUser') { cancelWork(c, e); c.reason = d.question; openHumanGate(c, e, { question: d.question }); message(c, e, 'facilitator', d.question, 'notice'); }
      if (d.action === 'finish' && !pendingHostRetry(c)) finish(c, e, c.artifacts.length || c.candidate ? 'partial' : 'failed', d.reason);
      break;
    }
    case 'WAIT_USER': cancelWork(c, e); c.reason = e.question; openHumanGate(c, e, { question: e.question, ...(e.workId ? { workId: e.workId } : {}) }); message(c, e, c.owner, e.question, 'answer'); break;
    case 'USER_INPUT': {
      if (recordApprovalExplanation(c, e)) break;
      const approvalGate = taskHumanGate(c);
      if (e.goal && approvalGate?.approvalId) { approvalGate.status = 'cancelled'; approvalGate.resolvedAt = e.at; }
      const gate = answerTaskGate(c, e);
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
          resetDeliveryMaterials(c);
          cancelWork(c, e, true); cancelHostRetries(c, 'STALE_WORK');
          for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'clarification', 'failed'].includes(input.status)) input.status = 'cancelled';
          for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        }
      }
      recordInput(c, e.id, e.text, e.reviewTargets?.length ? 'review' : e.decision ? 'decision' : 'supplement');
      if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
      if (gate && windowExpired(c, e.at) && !taskHumanGate(c)) freezeIncomplete(c, e, '人类已回复，原自动处理窗口已耗尽');
      break;
    }
    case 'HUMAN_DECISION': {
      if (recordApprovalExplanation(c, e)) break;
      const gate = answerTaskGate(c, e);
      if (e.history) c.history = e.history;
      message(c, e, 'user', e.text, 'user');
      c.board.push({ id: e.id, kind: 'decision', text: e.text, author: 'user', sources: [e.id], verified: false, revision: 1, goalVersion: c.goalVersion });
      if (c.outcome === null) {
        c.goal.constraints.push(`用户决定：${e.text}`); c.goalVersion++; c.localSkillVersions = []; c.candidate = null; delete c.deliveryGaps;
        resetDeliveryMaterials(c);
        for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight'].includes(input.status)) input.status = 'cancelled';
        c.inputs.push({ id: e.id, text: e.text, applied: false }); cancelWork(c, e, true); cancelHostRetries(c, 'STALE_WORK');
        for (const h of c.assists.filter(h => ['pending', 'running', 'answered'].includes(h.status))) h.status = 'cancelled';
        if (e.reviewTargets) requestReview(c, e.id, e.text, e.reviewTargets);
        recordInput(c, e.id, e.text, e.reviewTargets?.length ? 'review' : 'decision');
      }
      if (gate && windowExpired(c, e.at) && !taskHumanGate(c)) freezeIncomplete(c, e, '人类已回复，原自动处理窗口已耗尽');
      break;
    }
    case 'BOUNDARY':
      if (c.inputs.some(note => !note.applied)) resetDeliveryMaterials(c);
      for (const note of c.inputs) note.applied = true;
      if (c.review && !['cancelled', 'complete'].includes(c.review.status)) resetReviewAtBoundary(c, e);
      else if (!startMapReduce(c, e)) owner(c, e, { reason: 'Apply latest user input' });
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
        if (!deliveryInterruptionPending(c)) {
          if (canReviseDelivery(c)) reviseDelivery(c, e, versionProblem);
          else finishDelivery(c, e, versionProblem, versionProblem);
        }
        reject(c, versionProblem.split(':')[0]!);
        break;
      }
      const problem = deliverySubmissionProblem(c, e);
      const { acceptance } = deliveryPreflight(c, e);
      const artifactIds = saveReports(c, e, c.sourceArtifact && !e.artifacts?.length ? '' : e.text, c.owner, e.artifacts);
      const priorFindings = deliveryJudgments(c, c.candidate?.revision).filter(item => item.status !== 'passed');
      const baselineCheckId = [...c.intents].reverse().find(work => work.kind === 'check' && work.criteriaResults
        && work.epoch === c.epoch && work.goalVersion === c.goalVersion
        && (work.payload.candidate as TaskContext['candidate'])?.revision === c.candidate?.revision)?.id;
      const references = checkReferenceSources(c);
      cancelWork(c, e);
      c.candidate = { text: e.text, artifactIds: [...new Set([...e.artifactIds, ...artifactIds])], goalVersion: c.goalVersion,
        ...(e.partitionRecoveries?.length ? { partitionRecoveries: structuredClone(e.partitionRecoveries) } : {}),
        revision: acceptance.revision, ...(e.backgroundArtifactIds?.length ? { backgroundArtifactIds: [...new Set(e.backgroundArtifactIds)] } : {}),
        ...(e.summary === undefined ? {} : { summary: e.summary }), ...(e.workId ? { workId: e.workId } : {}), acceptance };
      deliveryCandidate(c);
      if (deliveryInterruptionPending(c)) break;
      if (problem) {
        c.candidate.deliveryIssue = { code: problem.code };
        if (problem.mechanical && canReviseDelivery(c)) reviseDelivery(c, e, problem.code);
        else finishDelivery(c, e, problem.code, problem.code);
        break;
      }
      const selected = new Set([...c.candidate.artifactIds, ...(c.candidate.backgroundArtifactIds ?? [])]);
      for (const artifact of c.artifacts) {
        if (c.candidate.artifactIds.includes(artifact.id) && artifact.replacesArtifactId) selected.add(artifact.replacesArtifactId);
      }
      const artifacts = c.artifacts.filter(artifact => selected.has(artifact.id) && artifact.goalVersion === c.goalVersion);
      const inputIds = new Set(acceptance.criteria.flatMap(criterion => criterion.sources.map(source => source.id)));
      const rawInputs = new Map((c.inputAnalyses ?? []).filter(input => inputIds.has(input.id)).map(input => [input.id, input.rawText]));
      for (const item of c.messages) if (item.author === 'user' && inputIds.has(item.id) && !rawInputs.has(item.id)) rawInputs.set(item.id, item.text);
      const verification = deliveryVerificationPlan(c);
      const work = intent(c, e.at, 'check', 'facilitator', { deliveryProtocol: 'bounded', candidate: c.candidate, artifacts,
        ...(baselineCheckId ? { baselineCheckId } : {}),
        ...(c.sourceArtifact ? { sourceArtifact: artifactSourceMetadata(c.sourceArtifact) } : {}),
        rawInputs: [...rawInputs].map(([id, text]) => ({ id, text })), priorFindings, reviewRecords: checkReviewSources(c),
        ...(references?.length ? { references } : {}),
        ...(verification ? { verification } : {}) });
      c.deliveryCycle!.evidence ??= deliveryEvidence(c, work)?.refs ?? [];
      bindDeliveryCheck(c, work);
      break;
    }
    case 'CHECK_RESULT': {
      const work = c.intents.find(item => item.id === e.workId)!;
      const outcome = checkDisposition(c, e, work);
      saveCheckDiagnostic(c, work, outcome.diagnostic);
      c.consumedResults.push(e.resultId);
      if (outcome.kind === 'retry') {
        reserveDeliveryRetry(c, work);
        work.status = 'pending';
        break;
      }
      release(c, work.id);
      if (outcome.kind === 'handoff') { deliveryCandidate(c); break; }
      if (outcome.checked) work.criteriaResults = e.criteriaResults!;
      if (outcome.kind === 'complete') { resolveMapRecoveries(c, work, e.at); finish(c, e, 'complete', ''); }
      if (outcome.kind === 'revise') reviseDelivery(c, e, outcome.detail!);
      if (outcome.kind === 'finish') finishDelivery(c, e, outcome.detail ?? `检查未完成（${outcome.code}）`, outcome.code);
      break;
    }
    case 'STOP':
      if (e.text) message(c, e, 'user', e.text, 'user');
      for (const gate of ensureResilience(c).gates.filter(g => g.scope === 'task' && g.status === 'open')) { gate.status = 'cancelled'; gate.resolvedAt = e.at; }
      c.stopped = true; c.reason = 'User requested stop'; cancelWork(c, e, true); cancelHostRetries(c, 'STOPPED');
      settleDeliveryCycle(c, 'stopped', c.reason);
      for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight', 'clarification', 'failed'].includes(input.status)) input.status = 'cancelled';
      if (c.review) c.review.status = 'cancelled';
      for (const h of c.assists) if (['pending', 'running', 'answered'].includes(h.status)) h.status = 'cancelled';
      adoptCleanup(c, e.at);
      if (c.resilience?.cleanup.some(item => item.state === 'pending')) freezeIncomplete(c, e, '用户停止；未决效果由独立清理接管', 'stopped');
      break;
    case 'SETTLE': {
      const work = c.intents.find(i => i.id === e.intentId);
      const unfinishedCheck = settlingDeliveryCheck(c, work) && !deliveryInterruptionPending(c);
      release(c, e.intentId);
      if (unfinishedCheck) finishDelivery(c, e, '检查工作已结算，未收到可发布的检查结果', 'CHECK_NOT_COMPLETED');
      if (work?.kind === 'tool' && !c.stopped && fresh(c, { ...e, fence: { epoch: work.epoch, goalVersion: work.goalVersion } })) owner(c, e, { toolResult: work.id });
      break;
    }
    case 'CONTINUE':
      if (e.newWindowMs !== undefined) replaceProcessingWindow(c, e, e.newWindowMs); else archiveFrozen(c);
      if (c.discussion && !['cancelled', 'delivered'].includes(c.discussion.status)) {
        c.discussion.status = 'cancelled';
        for (const work of c.intents) if (work.discussionId && work.status === 'pending') work.status = 'cancelled';
      }
      for (const gate of ensureResilience(c).gates.filter(g => g.scope === 'task' && g.status === 'open')) { gate.status = 'answered'; gate.responseId = e.id; gate.resolvedAt = e.at; }
      ensureResilience(c).nextSupervisionAt = Math.min(ensureResilience(c).window.hardDeadline, e.at + resiliencePolicy(c).repairTimeoutMs);
      adoptLegacyTerminalConfig(c, e.currentConfig);
      if (e.text) message(c, e, 'user', e.text, 'user');
      if (e.extraOrdinary) c.config.limits.ordinary += e.extraOrdinary;
      retainLegacyPublication(c, e.at);
      c.epoch++; c.stopped = false; c.outcome = null; c.reason = '';
      c.deliveryCycle = newDeliveryCycle();
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
      if (c.repeat.count >= c.config.limits.repeatThreshold && !automaticRevisionActive(c)) {
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
      const previousRequests = work.requestCount;
      work.status = 'inflight'; work.attempt++;
      if (!isBoundedCheck(work)) work.requestCount = 0;
      if (!claimHostRetryOwner(c, work, previousRequests) && work.bucket !== 'none' && !isBoundedCheck(work)) c.usage[work.bucket]++;
      if (work.kind === 'interpretation') {
        c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'inflight';
        if (typeof work.payload.maxPartitions === 'number') {
          work.payload.maxPartitions = mapReduceCapacity(c); work.payload.maxConcurrentPartitions = mapReduceConcurrency(c);
        }
      }
      if (work.kind === 'assistance' && !work.discussionId) c.assists.find(h => h.id === work.payload.requestId)!.status = 'running';
      break;
    }
    case 'CONSUME': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      if (isBoundedCheck(work)) {
        c.deliveryCycle!.requests++;
        c.usage.checks++;
        if (hasDeliveryRetryPermit(c, work)) c.deliveryCycle!.retry!.status = 'used';
      } else if (work.requestCount > 0 && work.bucket !== 'none') c.usage[work.bucket]++;
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
    case 'RECORD_TOOL_FAILURE': recordToolFailure(c, e); break;
    case 'WORK_FAILED': {
      const work = c.intents.find(i => i.id === e.intentId);
      if (!work) { reject(c, 'UNKNOWN_WORK'); break; }
      saveCheckDiagnostic(c, work, e.checkDiagnostic);
      if (work.discussionId) {
        if (discussionActive(c) && work.discussionId === c.discussion!.id) discussionFailed(c, e, work, e.reason);
        else release(c, work.id);
        break;
      }
      if (work.kind === 'cancel') { work.status = 'done'; c.reason = `Cancellation not confirmed: ${e.reason}`; break; }
      const approvalGate = c.resilience?.gates.find(g => g.scope === 'task' && g.status === 'open' && g.approvalId && g.workId === work.id && g.epoch === c.epoch && g.goalVersion === c.goalVersion);
      if (approvalGate) {
        work.status = 'pending'; c.reason = approvalGate.question; break;
      }
      if (e.resultUncertain || work.replay === 'unsafe') {
        work.status = 'uncertain'; c.reason = `Result uncertain; reconcile before retry: ${e.reason}`;
      } else if (!authorizationFailure(e.reason) && canRetryWork(c, e) && !(isBoundedCheck(work) && deliveryInterruptionPending(c))) {
        if (isBoundedCheck(work)) reserveDeliveryRetry(c, work);
        else { c.usage.retries++; work.deadline = Math.min(e.at + c.config.limits.workTimeoutMs, processingWindow(c).hardDeadline, processingWindow(c).repairDeadline ?? Number.MAX_SAFE_INTEGER); }
        work.status = 'pending';
        if (work.kind === 'interpretation') c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'pending';
      } else if (safeFailureRetry(c, e)) {
        requeueSafeWork(c, work, e.at);
      } else {
        const failureReason = e.transient && c.usage.retries >= c.config.limits.retries ? `${e.reason}（重试额度已用尽）` : e.reason;
        release(c, work.id); c.reason = failureReason;
        if (requiredHumanFailure(c, e))
          openHumanGate(c, e, { kind: 'authorization', workId: work.id, question: `需要处理权限或配置：${failureReason}` });
        if (!c.stopped && !deliveryInterruptionPending(c)) {
          if (isBoundedCheck(work)) finishDelivery(c, e, `检查未完成（${failureReason}）`, 'DELIVERY_CHECK_FAILED');
          if (work.payload.deliveryRevision === true) finishDelivery(c, e, failureReason, 'DELIVERY_REVISION_FAILED');
        }
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
      for (const work of c.intents) recoverLocalOperations(work, e.id);
      syncLocalApprovalGate(c, e);
      for (const work of c.intents.filter(work => canRetireDiscussionWork(c, work))) release(c, work.id);
      if (c.resilience?.frozen || c.stopped) for (const work of c.intents.filter(work => work.kind !== 'cancel' && work.replay === 'safe'
        && ['pending', 'inflight'].includes(work.status) && !localPhysicalPending(work))) release(c, work.id);
      if (c.resilience?.frozen) { adoptCleanup(c, e.at); settleCleanup(c, e.at); break; }
      if (c.stopped) { freezeIncomplete(c, e, '恢复已保存的停止请求；物理核对由独立清理继续', 'stopped'); break; }
      const issue = recoveryIssue(c, e.config);
      c.config.bots = e.config.bots; // Current permissions always win.
      c.config.localTools = { enabled: e.config.localTools?.enabled !== false };
      c.config.skillSearch = { enabled: e.config.skillSearch?.enabled !== false };
      c.config.webTools = { enabled: e.config.webTools?.enabled !== false };
      for (const work of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && ['owner', 'assistance', 'facilitator', 'check'].includes(i.kind))) {
        const legacy = (work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools === undefined;
        work.payload.capabilities = { ...capabilities(c, work.target), localTools: !legacy && localEnabled(e.config, work.target) };
      }
      if (issue) {
        for (const work of c.intents.filter(item => item.status === 'inflight' && item.kind !== 'cancel')) {
          if (work.replay === 'unsafe') work.status = 'uncertain';
          else release(c, work.id);
        }
        cancelWork(c, e, true); cancelHostRetries(c, 'INCOMPATIBLE_EXECUTION'); c.reason = issue;
        openHumanGate(c, e, { kind: 'recovery', cause: 'incompatibleExecution', decisions: ['skip', 'stop'], question: '当前宿主不支持原执行协议。请跳过剩余业务并交付缺口，或停止；需要继续请建立当前配置的新任务。' });
        reject(c, 'INCOMPATIBLE_EXECUTION'); break;
      }
      if (taskHumanGate(c)) {
        for (const work of c.intents.filter(w => w.status === 'inflight' && w.replay === 'safe' && localAwaitingApproval(w) && !localPhysicalPending(w))) work.status = 'pending';
        c.reason = taskHumanGate(c)!.question; break;
      }
      if (recoveryCheckExhausted(c, e.at)) {
        finishDelivery(c, e, '检查未完成，无法重新授权中断的检查请求', 'CHECK_RECOVERY_EXHAUSTED');
        break;
      }
      for (const work of c.intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel')) {
        if (localPhysicalPending(work) || work.replay === 'unsafe') { work.status = 'uncertain'; c.reason = 'Reconcile uncertain external result'; }
        else if (isBoundedCheck(work) && deliveryInterruptionPending(c)) release(c, work.id);
        else {
          if (isBoundedCheck(work) && work.requestCount > 0 && !hasDeliveryRetryPermit(c, work)) reserveDeliveryRetry(c, work);
          work.status = 'pending';
          if (work.kind === 'interpretation') c.inputAnalyses!.find(input => input.workId === work.id)!.status = 'pending';
        }
      }
      break;
    }
    case 'TOOL':
      cancelWork(c, e); intent(c, e.at, 'tool', c.owner, { tool: e.tool, ...e.payload }, e.replay); break;
    case 'EXHAUSTED': if (!taskHumanGate(c)) freezeIncomplete(c, e, e.reason); else c.reason = e.reason; break;
    case 'RECONCILE': {
      const work = c.intents.find(i => i.id === e.intentId)!;
      work.status = 'done';
      settleCleanup(c, e.at, work.id);
      c.trace.push({ event: 'RECONCILED', detail: `${work.id}:${e.resolution}:${e.detail}`, at: e.at });
      if (c.outcome === null) c.reason = 'External result reconciled; waiting for explicit continuation';
      break;
    }
  }
  if (c.hostSession && !hostSessionActive(c)) revokeHostSession(c, e.id);
  return c;
}
