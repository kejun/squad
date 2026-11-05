import type { Intent, Phase, TaskContext } from '../types.js';
import { hostRetryBoundary } from '../host-retry.js';
import { localAwaitingApproval, localPhysicalPending } from '../local-operation.js';
import { automaticRevisionActive } from './delivery.js';
import { activeHelp, allInflight, discussionActive, incompatibleExecution, pendingInput, unresolvedInput, workLaneAvailable } from './facts.js';

const mainWork: Partial<Record<Phase, Intent['kind'][]>> = {
  interpreting: ['interpretation'], running: ['owner', 'tool'], waitingAssistance: ['assistance'],
  coordinating: ['facilitator'], checking: ['check'],
};

export function pendingInPhase(c: TaskContext, phase: Phase, work: Intent): boolean {
  if (work.status !== 'pending' || localAwaitingApproval(work)) return false;
  if (work.kind === 'cancel') return true;
  const current = work.epoch === c.epoch && work.goalVersion === c.goalVersion;
  return current && !c.stopped && c.outcome === null && !!(work.discussionId || mainWork[phase]?.includes(work.kind))
    && workLaneAvailable(c, work);
}

function safeToSupervise(c: TaskContext): boolean {
  if (c.stopped || c.outcome !== null || c.hostRetryBatch || incompatibleExecution(c) || allInflight(c).length) return false;
  return !c.intents.some(work => work.status === 'uncertain' || localPhysicalPending(work) || localAwaitingApproval(work));
}

export function canCoordinateByProgress(c: TaskContext): boolean {
  return safeToSupervise(c) && !automaticRevisionActive(c) && !discussionActive(c) && !hasHandoff(c, 'running');
}

function hasHandoff(c: TaskContext, phase: Phase): boolean {
  const inputReady = !activeHelp(c) && (pendingInput(c) || !unresolvedInput(c) && c.inputs.some(note => !note.applied));
  return hostRetryBoundary(c) || !!inputReady || c.results.some(result => !result.consumed)
    || (phase === 'running' && c.discussion?.status === 'ready');
}

export function workflowStalled(c: TaskContext, phase: Phase): boolean {
  return !!mainWork[phase] && safeToSupervise(c) && !hasHandoff(c, phase)
    && !c.intents.some(work => pendingInPhase(c, phase, work));
}

export function canSuperviseProgress(c: TaskContext, phase: Phase): boolean {
  return phase === 'running' && canCoordinateByProgress(c) || workflowStalled(c, phase);
}
