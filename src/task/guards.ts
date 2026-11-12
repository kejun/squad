import { executionNotStartedEnds, safeFailureRetry, taskHumanGate, taskHumanGates, otherTaskHumanGate, directTaskGate, requiredHumanFailure, authorizationFailure, windowExpired, workInCleanup } from './resilience.js';
import { mapQueueNeedsProgress } from './map-queue.js';
import { canStartHostRetry, findHostRetry, hostRetryBatchNeedsSync, hostRetryBatchRetirable, hostRetryBoundary, pendingHostRetry } from '../host-retry.js';
import { type TaskContext, type TaskEvent } from '../types.js';
import { localResumeKind, permissionProblem, valid } from './policy.js';
import { activeHelp, allInflight, d, discussionActive, fresh, incompatibleExecution, inflight, isBot, pendingInput, recoveryIssue, remainingInflight, unresolvedInput } from './facts.js';
import { localAwaitingApproval, localPhysicalPending } from '../local-operation.js';
import { helpResultContinuesReview, nextReviewer, reviewCanDispatch, savedHelpResult } from './assistance.js';
import { automaticRevisionActive, canReviseDelivery, checkDisposition, deliveryInterruptionPending, deliverySubmissionProblem, hasDeliveryRetryPermit, isBoundedCheck, recoveryCheckExhausted, settlingDeliveryCheck } from './delivery.js';
import { canRetryDeliveryCheck, canRetryWork } from './budget.js';

type TaskGuardArgs = { context: TaskContext; event: TaskEvent };
const resultKind = ({ context, event }: TaskGuardArgs) => event.type === 'CHECK_RESULT' && valid({ context, event })
  ? checkDisposition(context, event, context.intents.find(work => work.id === event.workId)!).kind : null;
const settlingCheck = ({ context, event }: TaskGuardArgs) => event.type === 'SETTLE' && valid({ context, event })
  && settlingDeliveryCheck(context, context.intents.find(work => work.id === event.intentId));

export const taskGuards = {
    safeFailureRetry: args => valid(args) && safeFailureRetry(args.context, args.event),
    activeWindowExpired: args => valid(args) && !args.context.stopped && args.context.outcome === null && windowExpired(args.context, args.event.at),
    windowFailed: args => args.event.type === 'WORK_FAILED' && valid(args) && !args.context.stopped && args.context.outcome === null && windowExpired(args.context, args.event.at),
    gateReplyExpired: args => {
      if (args.event.type !== 'HUMAN_GATE_DECISION' || !valid(args) || args.context.stopped || args.context.outcome !== null
        || !windowExpired(args.context, args.event.at)) return false;
      const gate = args.context.resilience?.gates.find(gate => gate.id === (args.event as Extract<TaskEvent, { type: 'HUMAN_GATE_DECISION' }>).gateId);
      return gate?.scope === 'task' && (args.event.decision === 'reply'
        || args.event.decision === 'skip' && gate.cause !== 'windowExpired' && gate.cause !== 'incompatibleExecution');
    },
    notStartedEnds: args => args.event.type === 'EXECUTION_NOT_STARTED' && valid(args) && executionNotStartedEnds(args.context, args.event),
    hasTaskHumanGate: ({ context }) => !!taskHumanGate(context),
    directHumanResponseExpired: args => valid(args) && !!directTaskGate(args.context, args.event) && windowExpired(args.context, args.event.at)
      && !otherTaskHumanGate(args.context, directTaskGate(args.context, args.event)!.id),
    approvalBlockedFailure: args => valid(args) && args.event.type === 'WORK_FAILED' && (!!taskHumanGate(args.context) || requiredHumanFailure(args.context, args.event)),
    businessBlockedByHuman: args => valid(args) && !!taskHumanGate(args.context),
    approvalDecisionEnds: args => valid(args) && !args.context.stopped && args.context.outcome === null && args.event.type === 'LOCAL_APPROVAL_DECISION' && windowExpired(args.context, args.event.at)
      && !taskHumanGates(args.context).some(g => g.approvalId !== (args.event as Extract<TaskEvent, { type: 'LOCAL_APPROVAL_DECISION' }>).approvalId
        || g.operationId !== (args.event as Extract<TaskEvent, { type: 'LOCAL_APPROVAL_DECISION' }>).operationId || g.workId !== (args.event as Extract<TaskEvent, { type: 'LOCAL_APPROVAL_DECISION' }>).intentId),
    humanDecisionExpired: ({ context, event }) => event.type === 'HUMAN_DECISION' && !!directTaskGate(context, event) && windowExpired(context, event.at) && !otherTaskHumanGate(context, directTaskGate(context, event)!.id),
    gateDecisionEnds: ({ context, event }) => event.type === 'HUMAN_GATE_DECISION' && valid({ context, event })
      && context.resilience?.gates.find(g => g.id === event.gateId)?.scope === 'task'
      && (event.decision === 'stop' || event.decision === 'skip' && context.resilience?.gates.find(g => g.id === event.gateId)?.cause === 'incompatibleExecution' || event.decision === 'skip' && context.resilience?.gates.find(g => g.id === event.gateId)?.cause === 'windowExpired' && windowExpired(context, event.at)
        && !otherTaskHumanGate(context, event.gateId)),
    gateDecisionHelp: args => args.event.type === 'HUMAN_GATE_DECISION' && valid(args) && args.event.decision === 'skip'
      && args.context.resilience?.gates.find(g => g.id === (args.event as Extract<TaskEvent, { type: 'HUMAN_GATE_DECISION' }>).gateId)?.kind === 'clarification'
      && !!activeHelp(args.context),
    gateDecisionTask: ({ context, event }) => event.type === 'HUMAN_GATE_DECISION' && valid({ context, event }) && context.resilience?.gates.find(g => g.id === event.gateId)?.scope === 'task'
      && !(context.resilience.gates.find(g => g.id === event.gateId)?.approvalId && event.decision === 'reply'),
    recoverIncompatible: ({ context, event }) => event.type === 'RECOVER' && !!recoveryIssue(context, event.config),
    recoverStopped: ({ context }) => context.stopped,
    logicalStopped: ({ context }) => context.stopped && context.outcome === 'stopped',
    mapQueueNeedsProgress: ({ context, event }: { context: TaskContext; event: TaskEvent }) => mapQueueNeedsProgress(context, event.at ?? context.lastActivityAt),
    hostRetryBatchNeedsSync: ({ context }: { context: TaskContext }) => hostRetryBatchNeedsSync(context),
    valid,
    reactivateHostRetry: args => valid(args) && args.event.type === 'REQUEST_HOST_RETRY' && args.context.outcome !== null
      && !findHostRetry(args.context, args.event.sourceWorkId, args.event.sourceOperationId),
    hostRetryReady: ({ context, event }) => canStartHostRetry(context, event.at ?? context.lastActivityAt),
    hostRetryBatchRetirable: ({ context }) => hostRetryBatchRetirable(context),
    hostRetryBoundary: ({ context }) => hostRetryBoundary(context),
    hostRetryHoldsFinish: args => valid(args) && d(args.event)?.action === 'finish' && pendingHostRetry(args.context),
    localResumeOwner: ({ context, event }) => ['owner', 'tool'].includes(localResumeKind(context, event) ?? ''),
    localResumeHelp: ({ context, event }) => localResumeKind(context, event) === 'assistance',
    localResumeFacilitator: ({ context, event }) => localResumeKind(context, event) === 'facilitator',
    localResumeCheck: ({ context, event }) => localResumeKind(context, event) === 'check',
    localCheckExhausted: ({ context, event }) => {
      if ((event.type !== 'LOCAL_RECONCILE' && event.type !== 'LOCAL_RESULT') || localResumeKind(context, event) !== 'check') return false;
      const work = context.intents.find(item => item.id === event.intentId);
      return isBoundedCheck(work) && work.status === 'uncertain' && work.requestCount > 0 && !hasDeliveryRetryPermit(context, work) && !deliveryInterruptionPending(context, work.id)
        && !canRetryDeliveryCheck(context, work, event.at);
    },
    uncertainLocalResult: args => valid(args) && !args.context.stopped && args.event.type === 'LOCAL_RESULT' && !args.context.intents.find(w => w.id === (args.event as Extract<TaskEvent, { type: 'LOCAL_RESULT' }>).intentId)?.discussionId && (!args.event.settled || !args.event.effectsKnown),
    claimDiscussion: args => valid(args) && args.event.type === 'CLAIM' && args.context.intents.some(work => work.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && !!work.discussionId),
    failedDiscussion: args => valid(args) && args.event.type === 'WORK_FAILED' && args.context.intents.some(work => work.id === (args.event.type === 'WORK_FAILED' ? args.event.intentId : '') && !!work.discussionId),
    holdingDelivery: args => valid(args) && deliveryInterruptionPending(args.context),
    discussionHandoffReady: ({ context }) => context.discussion?.status === 'ready' && !context.stopped && !incompatibleExecution(context)
      && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)) && !activeHelp(context) && !unresolvedInput(context) && !context.inputs.some(input => !input.applied),
    safeBoundary: ({ context }) => inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)),
    analysisReady: ({ context }) => !taskHumanGate(context) && !context.stopped && context.outcome === null && !incompatibleExecution(context) && !!pendingInput(context)
      && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)) && !activeHelp(context),
    inputsReady: ({ context }) => !taskHumanGate(context) && !context.stopped && context.outcome === null && !unresolvedInput(context) && context.inputs.some(n => !n.applied)
      && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)) && !activeHelp(context),
    retryHasResult: args => valid(args) && args.event.type === 'RETRY_ASSISTANCE' && !!savedHelpResult(args.context, args.event.requestId),
    retryReviewContinues: args => valid(args) && args.event.type === 'RETRY_ASSISTANCE'
      && !!savedHelpResult(args.context, args.event.requestId) && helpResultContinuesReview(args.context, args.event.requestId),
    resultAtBoundary: args => valid(args) && !args.context.stopped && args.context.outcome === null && inflight(args.context).length === 0,
    reviewResultAtBoundary: args => valid(args) && !args.context.stopped && args.context.outcome === null && inflight(args.context).length === 0
      && args.event.type === 'HELP_RESULT' && helpResultContinuesReview(args.context, args.event.requestId),
    stoppedSettled: ({ context }) => context.stopped && allInflight(context).length === 0 && !context.intents.some(i => i.status === 'uncertain'),
    canCoordinate: args => valid(args) && !discussionActive(args.context) && remainingInflight(args.context, args.event).length === 0,
    isCurrent: ({ context, event }) => fresh(context, event) && !context.stopped && (!event.workId || context.intents.some(i => i.id === event.workId && i.status === 'inflight' && (event.attempt === undefined || event.attempt === i.attempt))),
    deferredReady: ({ context }) => context.deferredCoordination && !discussionActive(context) && !unresolvedInput(context) && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)),
    reviewReady: ({ context }) => context.review?.status === 'pending' && !context.stopped && !unresolvedInput(context) && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)),
    interpretationClarifies: args => valid(args) && args.event.type === 'INTERPRETATION_RESULT' && args.event.spec.clarification !== null,
    currentInterpretation: ({ context, event }) => event.type === 'INTERPRETATION_RESULT' && fresh(context, event) && !context.stopped
      && context.intents.some(work => work.id === event.workId && work.kind === 'interpretation' && work.status === 'inflight' && (event.attempt === undefined || event.attempt === work.attempt)),
    claimInterpretation: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'interpretation',
    decisionReview: args => valid(args) && d(args.event)?.action === 'review',
    decisionReviewDispatch: args => valid(args) && d(args.event)?.action === 'review' && reviewCanDispatch(args.context),
    reviewResultContinues: args => valid(args) && args.event.type === 'HELP_RESULT' && helpResultContinuesReview(args.context, args.event.requestId),
    failedReviewContinues: args => {
      if (!valid(args) || args.event.type !== 'WORK_FAILED' || args.event.resultUncertain) return false;
      const event = args.event;
      const work = args.context.intents.find(i => i.id === event.intentId);
      const help = args.context.assists.find(h => h.id === work?.payload.requestId);
      const next = help ? nextReviewer(args.context, help.target) : undefined;
      return work?.kind === 'assistance' && !!help?.reviewId && help.reviewId === args.context.review?.id
        && !!next && isBot(args.context, next) && reviewCanDispatch(args.context);
    },
    claimOwner: args => valid(args) && ['owner', 'tool'].includes(args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind ?? ''),
    claimHelp: args => valid(args) && args.context.intents.some(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && i.kind === 'assistance' && !i.discussionId),
    claimFacilitator: args => valid(args) && args.context.intents.some(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && i.kind === 'facilitator' && !i.discussionId),
    claimCheck: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'check',
    claimCheckUnavailable: ({ context, event }) => event.type === 'CLAIM'
      && context.intents.some(work => work.id === event.intentId && isBoundedCheck(work))
      && ['CHECK_BUDGET_EXHAUSTED', 'WORK_EXPIRED'].includes(permissionProblem(context, event) ?? ''),
    claimCancel: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'cancel',
    shouldTick: ({ context, event }) => valid({ context, event }) && !automaticRevisionActive(context) && !discussionActive(context) && event.at >= context.nextCheckAt && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) || localAwaitingApproval(work)) && !context.processedSignals.includes(event.id),
    repeated: ({ context, event }) => {
      if (event.type !== 'FAILURE_SIGNAL' || !valid({ context, event }) || automaticRevisionActive(context) || discussionActive(context) || remainingInflight(context, event).length) return false;
      const f = JSON.stringify([event.operation, event.parameters, event.resource, event.error, event.result]).normalize('NFKC');
      return (f === context.repeat.fingerprint ? context.repeat.count + 1 : 1) >= context.config.limits.repeatThreshold;
    },
    decisionAssist: args => valid(args) && d(args.event)?.action === 'assist',
    decisionAsk: args => valid(args) && d(args.event)?.action === 'askUser',
    decisionFinish: args => valid(args) && d(args.event)?.action === 'finish',
    decisionRun: args => valid(args) && ['continue', 'replan'].includes(d(args.event)?.action ?? ''),
    deliveryReady: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event }) && !deliverySubmissionProblem(context, event),
    deliveryCanRevise: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event })
      && !!deliverySubmissionProblem(context, event)?.mechanical && canReviseDelivery(context),
    checkCanRetry: args => resultKind(args) === 'retry',
    checkContinues: args => ['handoff', 'revise'].includes(resultKind(args) ?? ''),
    settlingCheck,
    settlingCheckHandoff: args => settlingCheck(args) && deliveryInterruptionPending(args.context),
    checkFailureHandoff: ({ context, event }) => event.type === 'WORK_FAILED' && !event.resultUncertain && valid({ context, event })
      && isBoundedCheck(context.intents.find(work => work.id === event.intentId)) && deliveryInterruptionPending(context),
    checkFailed: ({ context, event }) => event.type === 'WORK_FAILED' && !event.resultUncertain && valid({ context, event })
      && isBoundedCheck(context.intents.find(work => work.id === event.intentId)),
    revisionFailed: ({ context, event }) => {
      const id = event.type === 'WORK_FAILED' && !event.resultUncertain ? event.intentId : event.type === 'BLOCKED' ? event.workId : undefined;
      return !!id && valid({ context, event }) && !deliveryInterruptionPending(context) && context.intents.some(work => work.id === id && work.payload.deliveryRevision === true);
    },
    retryable: args => valid(args) && !(args.event.type === 'WORK_FAILED' && authorizationFailure(args.event.reason)) && canRetryWork(args.context, args.event),
    failedAssistance: args => valid(args) && args.event.type === 'WORK_FAILED' && !args.event.resultUncertain && args.context.intents.find(i => i.id === (args.event as Extract<TaskEvent, { type: 'WORK_FAILED' }>).intentId)?.kind === 'assistance',
    recoveredSafe: ({ context, event }) => event.type === 'RECOVER' && !recoveryIssue(context, event.config) && !context.intents.some(i => localPhysicalPending(i) || i.status === 'uncertain' || i.status === 'inflight' && i.replay === 'unsafe'),
    recoveredCheckExhausted: ({ context, event }) => event.type === 'RECOVER' && !recoveryIssue(context, event.config) && !!recoveryCheckExhausted(context, event.at),
  } satisfies Record<string, (args: TaskGuardArgs) => boolean>;
