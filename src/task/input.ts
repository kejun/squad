import { type InputAction, type TaskContext, type TaskEvent } from '../types.js';
import { requiredResources } from '../resource-acquisition.js';
import { createInputAnalysis, inputReferences } from '../input-intent.js';
import { pendingInput } from './facts.js';
import { cancelWork, conversationInput, intent } from './operations.js';
import { hierarchicalContext, hierarchicalSummaryPending } from './hierarchical-summary.js';
import { mapReduceCapacity, mapReduceConcurrency } from './map-reduce-capacity.js';

export function recordInput(c: TaskContext, id: string, text: string, action: InputAction, analyzeRequest = false) {
  const analyses = c.inputAnalyses ??= [];
  const force = analyzeRequest || analyses.some(input => ['clarification', 'failed'].includes(input.status));
  for (const input of analyses.filter(input => ['clarification', 'failed'].includes(input.status))) {
    input.status = 'cancelled'; input.error = 'SUPERSEDED_INPUT';
  }
  analyses.push(createInputAnalysis(c, id, text, action, c.goal, force));
}

export function prepareInterpretation(c: TaskContext, e: TaskEvent) {
  const input = pendingInput(c);
  if (!input) return;
  cancelWork(c, e);
  const hierarchical = hierarchicalSummaryPending(c);
  const shared = { maxPartitions: mapReduceCapacity(c, 1), maxConcurrentPartitions: mapReduceConcurrency(c, 1),
    input: { id: input.id, rawText: input.rawText, action: input.action }, references: inputReferences(c) };
  const work = intent(c, e.at, 'interpretation', 'facilitator', hierarchical
    ? { ...shared, ...hierarchicalContext(c) }
    : { ...shared, goal: c.goal, artifacts: c.artifacts, board: c.board, ...conversationInput(c),
      ...(c.config.executionMemory ? { sources: requiredResources(c).map((requirement, index) => ({ index: index + 1, ...requirement })) } : {}) });
  input.workId = work.id;
}
