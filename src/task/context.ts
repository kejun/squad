import { initialResilience } from './resilience.js';
import { type TaskContext, type TaskInput } from '../types.js';
import { recordInput } from './input.js';
import { requestReview } from './assistance.js';
import { owner } from './operations.js';
import { newDeliveryCycle } from './delivery.js';
import { sourceRevisionRequirement } from '../delivery-acceptance.js';

export function createTaskContext(input: TaskInput): TaskContext {
    const c: TaskContext = { schemaVersion: 1, taskId: input.taskId, owner: input.owner, config: structuredClone(input.config), goal: structuredClone(input.goal),
      epoch: 1, goalVersion: 1, messages: [input.message], board: [], boardHistory: [], artifacts: [], assists: [], intents: [], trace: [], inputs: [], consumedResults: [], processedSignals: [], progressRefs: [], lateResults: [], results: [],
      usage: { ordinary: 0, checks: 0, assists: 0, replans: 0, retries: 0 }, candidate: null, outcome: null, reason: '', stopped: false, nextSeq: 1,
      deliveryCycle: newDeliveryCycle(input.config),
      lastActivityAt: input.at, lastProgressAt: input.at, nextCheckAt: input.at + input.config.limits.progressIntervalMs, repeat: { fingerprint: '', count: 0 }, deferredCoordination: false, reply: { ok: true, code: 'OK', detail: 'created' } };
    c.resilience = initialResilience(c);
    if (input.history) c.history = input.history;
    if (input.sourceArtifact) {
      c.sourceArtifact = structuredClone(input.sourceArtifact);
      c.goal.requiredArtifacts = Math.max(1, c.goal.requiredArtifacts);
      if (!c.goal.criteria.includes(sourceRevisionRequirement)) c.goal.criteria.push(sourceRevisionRequirement);
    }
    recordInput(c, input.message.id, input.message.text, input.reviewTargets?.length ? 'review' : 'request');
    if (input.reviewTargets?.length) requestReview(c, input.message.id, input.message.text, input.reviewTargets);
    else owner(c, { type: 'BOUNDARY', id: 'initial', at: input.at });
    return c;
  }
