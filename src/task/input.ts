import { type InputAction, type TaskContext, type TaskEvent } from '../types.js';
import { createInputAnalysis, inputReferences } from '../input-intent.js';
import { pendingInput } from './facts.js';
import { cancelWork, conversationInput, intent } from './operations.js';
import { mapReduceCapacity, mapReduceConcurrency } from './map-reduce-capacity.js';

export function recordInput(c: TaskContext, id: string, text: string, action: InputAction) {
  const analyses = c.inputAnalyses ??= [];
  const force = analyses.some(input => ['clarification', 'failed'].includes(input.status));
  for (const input of analyses.filter(input => ['clarification', 'failed'].includes(input.status))) {
    input.status = 'cancelled'; input.error = 'SUPERSEDED_INPUT';
  }
  analyses.push(createInputAnalysis(c, id, text, action, c.goal, force));
}

export function prepareInterpretation(c: TaskContext, e: TaskEvent) {
  const input = pendingInput(c);
  if (!input) return;
  cancelWork(c, e);
  const work = intent(c, e.at, 'interpretation', 'facilitator', {
    maxPartitions: mapReduceCapacity(c, 1),
    maxConcurrentPartitions: mapReduceConcurrency(c, 1),
    input: { id: input.id, rawText: input.rawText, action: input.action }, goal: c.goal, artifacts: c.artifacts, board: c.board,
    references: inputReferences(c), ...conversationInput(c),
  });
  input.workId = work.id;
}
