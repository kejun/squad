import { type TaskContext, type TaskInput } from '../types.js';
import { recordInput } from './input.js';
import { requestReview } from './assistance.js';
import { owner } from './operations.js';

export function createTaskContext(input: TaskInput): TaskContext {
    const c: TaskContext = { schemaVersion: 1, taskId: input.taskId, owner: input.owner, config: structuredClone(input.config), goal: structuredClone(input.goal),
      epoch: 1, goalVersion: 1, messages: [input.message], board: [], boardHistory: [], artifacts: [], assists: [], intents: [], trace: [], inputs: [], consumedResults: [], processedSignals: [], progressRefs: [], lateResults: [], results: [],
      usage: { ordinary: 0, checks: 0, assists: 0, replans: 0, retries: 0 }, candidate: null, outcome: null, reason: '', stopped: false, nextSeq: 1,
      lastActivityAt: input.at, lastProgressAt: input.at, nextCheckAt: input.at + input.config.limits.progressIntervalMs, repeat: { fingerprint: '', count: 0 }, deferredCoordination: false, reply: { ok: true, code: 'OK', detail: 'created' } };
    if (input.history) c.history = input.history;
    recordInput(c, input.message.id, input.message.text, input.reviewTargets?.length ? 'review' : 'request');
    if (input.reviewTargets?.length) requestReview(c, input.message.id, input.message.text, input.reviewTargets);
    else owner(c, { type: 'BOUNDARY', id: 'initial', at: input.at });
    return c;
  }
