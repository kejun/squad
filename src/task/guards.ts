import { canStartHostRetry, findHostRetry, hostRetryBoundary, pendingHostRetry } from '../host-retry.js';
import { type TaskContext, type TaskEvent } from '../types.js';
import { localResumeKind, valid } from './policy.js';
import { activeHelp, allInflight, completeProblem, d, deliveryHandoffPending, discussionActive, discussionIncomplete, fresh, hasOrdinary, incompatibleExecution, inflight, isBot, pendingInput, recoveryIssue, remainingInflight, unresolvedInput } from './facts.js';
import { localAwaitingApproval, localPhysicalPending } from '../local-operation.js';
import { helpResultContinuesReview, nextReviewer, reviewCanDispatch, savedHelpResult } from './assistance.js';
import { deliveryVersionProblem } from './delivery.js';
import { deliveryCheckGaps, deliveryPreflight } from '../delivery-acceptance.js';
import { canRetryWork } from './budget.js';

type TaskGuardArgs = { context: TaskContext; event: TaskEvent };

export const taskGuards = {
    valid,
    reactivateHostRetry: args => valid(args) && args.event.type === 'REQUEST_HOST_RETRY' && args.context.outcome !== null
      && !findHostRetry(args.context, args.event.sourceWorkId, args.event.sourceOperationId),
    hostRetryReady: ({ context, event }) => canStartHostRetry(context, event.at ?? context.lastActivityAt),
    hostRetryBoundary: ({ context }) => hostRetryBoundary(context),
    hostRetryHoldsDelivery: args => valid(args) && pendingHostRetry(args.context),
    hostRetryHoldsCheck: args => valid(args) && pendingHostRetry(args.context),
    hostRetryHoldsFinish: args => valid(args) && d(args.event)?.action === 'finish' && pendingHostRetry(args.context),
    localResumeOwner: ({ context, event }) => ['owner', 'tool'].includes(localResumeKind(context, event) ?? ''),
    localResumeHelp: ({ context, event }) => localResumeKind(context, event) === 'assistance',
    localResumeFacilitator: ({ context, event }) => localResumeKind(context, event) === 'facilitator',
    localResumeCheck: ({ context, event }) => localResumeKind(context, event) === 'check',
    uncertainLocalResult: args => valid(args) && !args.context.stopped && args.event.type === 'LOCAL_RESULT' && !args.context.intents.find(w => w.id === (args.event as Extract<TaskEvent, { type: 'LOCAL_RESULT' }>).intentId)?.discussionId && (!args.event.settled || !args.event.effectsKnown),
    claimDiscussion: args => valid(args) && args.event.type === 'CLAIM' && args.context.intents.some(work => work.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && !!work.discussionId),
    failedDiscussion: args => valid(args) && args.event.type === 'WORK_FAILED' && args.context.intents.some(work => work.id === (args.event.type === 'WORK_FAILED' ? args.event.intentId : '') && !!work.discussionId),
    deliveryConflict: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event }) && deliveryVersionProblem(context, event) !== null,
    deliveryConflictExhausted: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event }) && !hasOrdinary(context) && deliveryVersionProblem(context, event) !== null,
    holdingDelivery: args => valid(args) && deliveryHandoffPending(args.context),
    discussionHandoffReady: ({ context }) => context.discussion?.status === 'ready' && !context.stopped && !incompatibleExecution(context)
      && inflight(context).length === 0 && !context.intents.some(localPhysicalPending) && !activeHelp(context) && !unresolvedInput(context) && !context.inputs.some(input => !input.applied),
    incompleteDiscussion: args => valid(args) && !!discussionIncomplete(args.context),
    safeBoundary: ({ context }) => inflight(context).length === 0 && !context.intents.some(localPhysicalPending),
    analysisReady: ({ context }) => !context.stopped && context.outcome === null && !incompatibleExecution(context) && !!pendingInput(context)
      && inflight(context).length === 0 && !context.intents.some(localPhysicalPending) && !activeHelp(context),
    inputsReady: ({ context }) => !context.stopped && context.outcome === null && !unresolvedInput(context) && context.inputs.some(n => !n.applied)
      && inflight(context).length === 0 && !context.intents.some(localPhysicalPending) && !activeHelp(context),
    retryHasResult: args => valid(args) && args.event.type === 'RETRY_ASSISTANCE' && !!savedHelpResult(args.context, args.event.requestId),
    retryReviewContinues: args => valid(args) && args.event.type === 'RETRY_ASSISTANCE'
      && !!savedHelpResult(args.context, args.event.requestId) && helpResultContinuesReview(args.context, args.event.requestId),
    resultAtBoundary: args => valid(args) && !args.context.stopped && args.context.outcome === null && inflight(args.context).length === 0,
    reviewResultAtBoundary: args => valid(args) && !args.context.stopped && args.context.outcome === null && inflight(args.context).length === 0
      && args.event.type === 'HELP_RESULT' && helpResultContinuesReview(args.context, args.event.requestId),
    stoppedSettled: ({ context }) => context.stopped && allInflight(context).length === 0 && !context.intents.some(i => i.status === 'uncertain'),
    canCoordinate: args => valid(args) && !discussionActive(args.context) && remainingInflight(args.context, args.event).length === 0,
    isCurrent: ({ context, event }) => fresh(context, event) && !context.stopped && (!event.workId || context.intents.some(i => i.id === event.workId && i.status === 'inflight' && (event.attempt === undefined || event.attempt === i.attempt))),
    deferredReady: ({ context }) => context.deferredCoordination && !discussionActive(context) && !unresolvedInput(context) && inflight(context).length === 0 && !context.intents.some(localPhysicalPending),
    reviewReady: ({ context }) => context.review?.status === 'pending' && !context.stopped && !unresolvedInput(context) && inflight(context).length === 0 && !context.intents.some(localPhysicalPending),
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
    incompleteReview: args => valid(args) && !!args.context.review?.incomplete,
    claimOwner: args => valid(args) && ['owner', 'tool'].includes(args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind ?? ''),
    claimHelp: args => valid(args) && args.context.intents.some(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && i.kind === 'assistance' && !i.discussionId),
    claimFacilitator: args => valid(args) && args.context.intents.some(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : '') && i.kind === 'facilitator' && !i.discussionId),
    claimCheck: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'check',
    claimCancel: args => valid(args) && args.context.intents.find(i => i.id === (args.event.type === 'CLAIM' ? args.event.intentId : ''))?.kind === 'cancel',
    shouldTick: ({ context, event }) => valid({ context, event }) && !discussionActive(context) && event.at >= context.nextCheckAt && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) || localAwaitingApproval(work)) && !context.processedSignals.includes(event.id),
    repeated: ({ context, event }) => {
      if (event.type !== 'FAILURE_SIGNAL' || !valid({ context, event }) || discussionActive(context) || remainingInflight(context, event).length) return false;
      const f = JSON.stringify([event.operation, event.parameters, event.resource, event.error, event.result]).normalize('NFKC');
      return (f === context.repeat.fingerprint ? context.repeat.count + 1 : 1) >= context.config.limits.repeatThreshold;
    },
    decisionAssist: args => valid(args) && d(args.event)?.action === 'assist',
    decisionAsk: args => valid(args) && d(args.event)?.action === 'askUser',
    decisionFinish: args => valid(args) && d(args.event)?.action === 'finish',
    decisionRun: args => valid(args) && ['continue', 'replan'].includes(d(args.event)?.action ?? ''),
    deliveryReady: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event }) && !deliveryPreflight(context, event).gaps.length,
    deliveryCanRevise: ({ context, event }) => event.type === 'DELIVER' && valid({ context, event }) && hasOrdinary(context)
      && !deliveryPreflight(context, event).repeated,
    checkCanRevise: ({ context, event }) => event.type === 'CHECK_RESULT' && valid({ context, event }) && !!context.candidate?.acceptance && hasOrdinary(context) && !deliveryHandoffPending(context) && !context.intents.some(localPhysicalPending),
    checkComplete: ({ context, event }) => valid({ context, event }) && event.type === 'CHECK_RESULT' && event.passed && !completeProblem(context) && !deliveryCheckGaps(context, event).length,
    canCorrect: ({ context, event }) => valid({ context, event }) && hasOrdinary(context),
    retryable: args => valid(args) && canRetryWork(args.context, args.event),
    failedAssistance: args => valid(args) && args.event.type === 'WORK_FAILED' && !args.event.resultUncertain && args.context.intents.find(i => i.id === (args.event as Extract<TaskEvent, { type: 'WORK_FAILED' }>).intentId)?.kind === 'assistance',
    recoveredSafe: ({ context, event }) => event.type === 'RECOVER' && !recoveryIssue(context, event.config) && !context.intents.some(i => localPhysicalPending(i) || i.status === 'uncertain' || i.status === 'inflight' && i.replay === 'unsafe'),
  } satisfies Record<string, (args: TaskGuardArgs) => boolean>;
