import { supervisionDecision } from './resilience.js';
import type { Phase, TaskContext, TaskEvent } from '../types.js';
const superviseActions = { interpreting: 'superviseInterpreting', running: 'superviseRunning', waitingAssistance: 'superviseAssistance', coordinating: 'superviseCoordinating', waitingHuman: 'superviseHuman', checking: 'superviseChecking', stopping: 'superviseStopping', ended: 'superviseEnded' } as const;
const supervision = (phase: Phase) => [
  { guard: function supervisionEnds({ context, event }: { context: TaskContext; event: TaskEvent }) { return ['freeze', 'stopped', 'settled'].includes(supervisionDecision(context, phase, event.at)); }, target: '#botTeamTask.ended', actions: superviseActions[phase] },
  { guard: function supervisionWaitsForHuman({ context, event }: { context: TaskContext; event: TaskEvent }) { return ['human', 'windowExpired'].includes(supervisionDecision(context, phase, event.at)); }, target: '#botTeamTask.waitingHuman', actions: superviseActions[phase] },
  { guard: function supervisionRepairs({ context, event }: { context: TaskContext; event: TaskEvent }) { return supervisionDecision(context, phase, event.at) === 'repair'; }, target: '#botTeamTask.coordinating', actions: superviseActions[phase] },
  { actions: superviseActions[phase] },
];
// Ordered transition arrays are part of the persisted/debugging contract.
// `ended` remains resumable; only the execution epoch has ended.
export const taskLifecycle = {
  id: 'botTeamTask',
  initial: 'running',
  always: [
    { guard: 'hostRetryBatchNeedsSync', actions: 'syncHostRetryBatch' },
    { guard: 'mapQueueNeedsProgress', actions: 'advanceMapQueue' },
    { guard: 'analysisReady', target: '.interpreting', actions: 'beginInterpretation' },
    { guard: 'inputsReady', target: '.running', actions: 'boundary' },
    { guard: 'hostRetryReady', target: '.running', actions: 'startHostRetry' },
    { guard: 'hostRetryBoundary', target: '.ended', actions: 'failHostRetry' },
    { guard: 'hostRetryBatchRetirable', actions: 'retireHostRetry' },
  ],
  on: {
    RECORD_ACQUISITION: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    EXECUTION_NOT_STARTED: [{ guard: 'activeWindowExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'notStartedEnds', target: '.ended', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    HUMAN_GATE_DECISION: [{ guard: 'gateReplyExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'gateDecisionEnds', target: '.ended', actions: 'apply' }, { guard: 'gateDecisionHelp', target: '.waitingAssistance', actions: 'apply' }, { guard: 'gateDecisionTask', target: '.running', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    REVOKE_HOST_SESSION: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    REQUEST_HOST_RETRY: [{ guard: 'reactivateHostRetry', target: '.running', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    HOST_RETRY_RECONCILE: { guard: 'valid', actions: 'apply' },
    HOST_RETRY_EXPIRE: { guard: 'valid', actions: 'apply' },
    LOCAL_RETRY_EXPIRED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_REQUEST: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_REJECTED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_CLAIM: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_PREPARED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_STARTED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_APPROVAL_REQUIRED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_APPROVAL_DECISION: [{ guard: 'approvalDecisionEnds', target: '.waitingHuman', actions: 'apply' }, { guard: 'localResumeOwner', target: '.running', actions: 'apply' }, { guard: 'localResumeHelp', target: '.waitingAssistance', actions: 'apply' }, { guard: 'localResumeFacilitator', target: '.coordinating', actions: 'apply' }, { guard: 'localResumeCheck', target: '.checking', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_APPROVAL_EXPIRED: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_RESULT: [{ guard: 'localResumeOwner', target: '.running', actions: 'apply' }, { guard: 'localResumeHelp', target: '.waitingAssistance', actions: 'apply' }, { guard: 'localResumeFacilitator', target: '.coordinating', actions: 'apply' }, { guard: 'localCheckExhausted', target: '.ended', actions: 'apply' }, { guard: 'localResumeCheck', target: '.checking', actions: 'apply' }, { guard: 'uncertainLocalResult', target: '.waitingHuman', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    LOCAL_RECONCILE: [{ guard: 'localResumeOwner', target: '.running', actions: 'apply' }, { guard: 'localResumeHelp', target: '.waitingAssistance', actions: 'apply' }, { guard: 'localResumeFacilitator', target: '.coordinating', actions: 'apply' }, { guard: 'localCheckExhausted', target: '.ended', actions: 'apply' }, { guard: 'localResumeCheck', target: '.checking', actions: 'apply' }, { guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    DISCUSSION_PLAN: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    DISCUSSION_RESULT: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    RETRY_ASSISTANCE: [
      { guard: 'directHumanResponseExpired', target: '.waitingHuman', actions: 'apply' },
      { guard: 'retryReviewContinues', target: '.waitingAssistance', actions: 'apply' },
      { guard: 'retryHasResult', target: '.running', actions: 'apply' },
      { guard: 'valid', target: '.waitingAssistance', actions: 'apply' },
    ],
    HELP_RESULT: [
      { guard: 'reviewResultAtBoundary', target: '.waitingAssistance', actions: 'apply' },
      { guard: 'resultAtBoundary', target: '.running', actions: 'apply' },
    ],
    STOP: { guard: 'valid', target: '.stopping', actions: 'apply' },
    USER_INPUT: [{ guard: 'directHumanResponseExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
    HUMAN_DECISION: [{ guard: 'humanDecisionExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
    BOARD_WRITE: { guard: 'valid', actions: 'apply' },
    ARTIFACT: { guard: 'valid', actions: 'apply' },
    ACTIVITY: { guard: 'valid', actions: 'apply' },
    PROGRESS: { guard: 'valid', actions: 'apply' },
    CLAIM: [{ guard: 'claimDiscussion', actions: 'apply' }, { guard: 'claimCancel', actions: 'apply' }],
    WORK_FAILED: [{ guard: 'windowFailed', target: '.waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: '.waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }],
    CONSUME: { guard: 'valid', actions: 'apply' },
    REGENERATE_MODEL_OUTPUT: { guard: 'valid', actions: 'apply' },
    RECORD_TOOL_FAILURE: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }],
    SETTLE: { guard: 'valid', actions: 'apply' },
    RECOVER: [{ guard: 'recoverStopped', target: '.ended', actions: 'apply' }, { guard: 'recoverIncompatible', target: '.waitingHuman', actions: 'apply' }, { guard: 'activeWindowExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'hasTaskHumanGate', target: '.waitingHuman', actions: 'apply' }, { guard: 'recoveredCheckExhausted', target: '.ended', actions: 'apply' }, { guard: 'recoveredSafe', actions: 'apply' }, { target: '.waitingHuman', actions: 'apply' }],
    EXHAUSTED: [{ guard: 'activeWindowExpired', target: '.waitingHuman', actions: 'apply' }, { guard: 'hasTaskHumanGate', target: '.waitingHuman', actions: 'apply' }, { guard: 'valid', target: '.ended', actions: 'apply' }],
    RECONCILE: { guard: 'valid', actions: 'apply' },
    '*': { actions: 'reject' },
  },
  states: {
    interpreting: {
      on: {
        SUPERVISE: supervision('interpreting'),
        CLAIM: { guard: 'claimInterpretation', actions: 'apply' },
        INTERPRETATION_RESULT: [
          { guard: 'interpretationClarifies', target: 'waitingHuman', actions: 'apply' },
          { guard: 'valid', target: 'running', actions: 'apply' },
          { guard: 'currentInterpretation', target: 'waitingHuman', actions: 'reject' },
        ],
        WORK_FAILED: [{ guard: 'windowFailed', target: 'waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: 'waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }, { guard: 'retryable', actions: 'apply' }, { guard: 'safeFailureRetry', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    running: {
      always: [{ guard: 'discussionHandoffReady', actions: 'handoffDiscussion' }, { guard: 'reviewReady', target: 'coordinating', actions: 'beginReview' }, { guard: 'deferredReady', target: 'coordinating', actions: 'deferred' }],
      on: {
        SUPERVISE: supervision('running'),
        CLAIM: { guard: 'claimOwner', actions: 'apply' },
        HELP: { guard: 'valid', target: 'waitingAssistance', actions: 'apply' },
        BLOCKED: [{ guard: 'revisionFailed', target: 'ended', actions: 'apply' }, { guard: 'canCoordinate', target: 'coordinating', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
        WAIT_USER: { guard: 'valid', target: 'waitingHuman', actions: 'apply' },
        HANDOFF: { guard: 'valid', actions: 'apply' },
        DELIVER: [
          { guard: 'businessBlockedByHuman', target: 'waitingHuman', actions: 'apply' },
          { guard: 'holdingDelivery', actions: 'apply' },
          { guard: 'deliveryReady', target: 'checking', actions: 'apply' },
          { guard: 'deliveryCanRevise', actions: 'apply' },
          { guard: 'valid', target: 'ended', actions: 'apply' },
        ],
        TOOL: { guard: 'valid', actions: 'apply' },
        TICK: { guard: 'shouldTick', target: 'coordinating', actions: 'apply' },
        FAILURE_SIGNAL: [{ guard: 'repeated', target: 'coordinating', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
        WORK_FAILED: [{ guard: 'windowFailed', target: 'waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: 'waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }, { guard: 'retryable', actions: 'apply' }, { guard: 'safeFailureRetry', actions: 'apply' }, { guard: 'revisionFailed', target: 'ended', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    waitingAssistance: {
      on: {
        SUPERVISE: supervision('waitingAssistance'),
        CLAIM: { guard: 'claimHelp', actions: 'apply' },
        RECORD_RESULT: { guard: 'valid', actions: 'apply' },
        HELP_RESULT: [{ guard: 'reviewResultContinues', actions: 'apply' }, { guard: 'valid', target: 'running', actions: 'apply' }],
        WORK_FAILED: [{ guard: 'windowFailed', target: 'waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: 'waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }, { guard: 'retryable', actions: 'apply' }, { guard: 'safeFailureRetry', actions: 'apply' }, { guard: 'failedReviewContinues', actions: 'apply' }, { guard: 'failedAssistance', target: 'running', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    coordinating: {
      on: {
        SUPERVISE: supervision('coordinating'),
        CLAIM: { guard: 'claimFacilitator', actions: 'apply' },
        COORDINATE: [
          { guard: 'businessBlockedByHuman', target: 'waitingHuman', actions: 'apply' },
          { guard: 'decisionReviewDispatch', target: 'waitingAssistance', actions: 'apply' },
          { guard: 'decisionReview', target: 'running', actions: 'apply' },
          { guard: 'decisionAssist', target: 'waitingAssistance', actions: 'apply' },
          { guard: 'decisionAsk', target: 'waitingHuman', actions: 'apply' },
          { guard: 'hostRetryHoldsFinish', target: 'running', actions: 'apply' },
          { guard: 'decisionFinish', target: 'ended', actions: 'apply' },
          { guard: 'decisionRun', target: 'running', actions: 'apply' },
          { guard: 'isCurrent', target: 'waitingHuman', actions: ['reject', 'explainCoordinationRejection'] },
        ],
        WORK_FAILED: [{ guard: 'windowFailed', target: 'waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: 'waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }, { guard: 'retryable', actions: 'apply' }, { guard: 'safeFailureRetry', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    waitingHuman: { on: { SUPERVISE: supervision('waitingHuman'), CONTINUE: { guard: 'valid', target: 'running', actions: 'apply' } } },
    checking: {
      on: {
        SUPERVISE: supervision('checking'),
        CLAIM: [{ guard: 'claimCheckUnavailable', target: 'ended', actions: 'failCheckClaim' }, { guard: 'claimCheck', actions: 'apply' }],
        CHECK_RESULT: [
          { guard: 'businessBlockedByHuman', target: 'waitingHuman', actions: 'apply' },
          { guard: 'checkCanRetry', actions: 'apply' },
          { guard: 'checkContinues', target: 'running', actions: 'apply' },
          { guard: 'valid', target: 'ended', actions: 'apply' },
        ],
        SETTLE: [{ guard: 'businessBlockedByHuman', target: 'waitingHuman', actions: 'apply' }, { guard: 'settlingCheckHandoff', target: 'running', actions: 'apply' }, { guard: 'settlingCheck', target: 'ended', actions: 'apply' }, { guard: 'valid', actions: 'apply' }],
        WORK_FAILED: [{ guard: 'windowFailed', target: 'waitingHuman', actions: 'apply' }, { guard: 'approvalBlockedFailure', target: 'waitingHuman', actions: 'apply' }, { guard: 'failedDiscussion', actions: 'apply' }, { guard: 'checkFailureHandoff', target: 'running', actions: 'apply' }, { guard: 'retryable', actions: 'apply' }, { guard: 'safeFailureRetry', actions: 'apply' }, { guard: 'checkFailed', target: 'ended', actions: 'apply' }, { guard: 'valid', target: 'waitingHuman', actions: 'apply' }],
      },
    },
    stopping: {
      always: [{ guard: 'logicalStopped', target: 'ended' }, { guard: 'stoppedSettled', target: 'ended', actions: 'stopped' }],
      on: {
        SUPERVISE: supervision('stopping'), STOP: {}, WORK_FAILED: { actions: 'apply' }, HELP_RESULT: { actions: 'reject' }, SETTLE: [{ guard: 'valid', actions: 'apply' }, { actions: 'reject' }] },
    },
    ended: {
      on: {
        SUPERVISE: supervision('ended'),
        STOP: {}, CONTINUE: { guard: 'valid', target: 'running', actions: 'apply' },
        USER_INPUT: { actions: 'reject' }, ARTIFACT: { actions: 'reject' }, PROGRESS: { actions: 'reject' },
        RECOVER: { actions: 'apply' }, CLAIM: [{ guard: 'claimCancel', actions: 'apply' }, { actions: 'reject' }], CONSUME: { actions: 'reject' },
      },
    },
  }
} as const;
