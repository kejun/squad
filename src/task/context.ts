import { initialResilience } from './resilience.js';
import { type TaskContext, type TaskInput } from '../types.js';
import { recordInput } from './input.js';
import { requestReview } from './assistance.js';
import { message, owner } from './operations.js';
import { newDeliveryCycle } from './delivery.js';
import { sourceRevisionRequirement } from '../delivery-acceptance.js';

export function createTaskContext(input: TaskInput): TaskContext {
    const c: TaskContext = { schemaVersion: 1, taskId: input.taskId, owner: input.owner, config: structuredClone(input.config), goal: structuredClone(input.goal),
      epoch: 1, goalVersion: 1, messages: [input.message], board: [], boardHistory: [], artifacts: [], assists: [], intents: [], trace: [], inputs: [], consumedResults: [], processedSignals: [], progressRefs: [], lateResults: [], results: [],
      usage: { ordinary: 0, checks: 0, assists: 0, replans: 0, retries: 0 }, candidate: null, outcome: null, reason: '', stopped: false, nextSeq: 1,
      deliveryCycle: newDeliveryCycle(),
      lastActivityAt: input.at, lastProgressAt: input.at, nextCheckAt: input.at + input.config.limits.progressIntervalMs, repeat: { fingerprint: '', count: 0 }, deferredCoordination: false, reply: { ok: true, code: 'OK', detail: 'created' } };
    if (input.history) c.history = input.history;
    if (input.executionMemory) c.executionMemory = structuredClone(input.executionMemory);
    if (input.sourceArtifact) {
      c.sourceArtifact = structuredClone(input.sourceArtifact);
      if (input.sourceArtifact.purpose !== 'extract') {
        c.goal.requiredArtifacts = Math.max(1, c.goal.requiredArtifacts);
        if (!c.goal.criteria.includes(sourceRevisionRequirement)) c.goal.criteria.push(sourceRevisionRequirement);
      }
    }
    if (input.queued) {
      c.queuedStartup = {
        ...(input.reviewTargets ? { reviewTargets: [...input.reviewTargets] } : {}),
        ...(input.reviewParallel ? { reviewParallel: input.reviewParallel } : {}),
        ...(input.analyzeRequest === undefined ? {} : { analyzeRequest: input.analyzeRequest }),
      };
      c.reason = '已登记新委托，轮到时自动开始。';
      message(c, { type: 'BOUNDARY', id: input.message.id, at: input.at }, 'facilitator', c.reason, 'notice');
    } else startInitialWork(c, input, input.at);
    return c;
}

export function startInitialWork(c: TaskContext, startup: NonNullable<TaskContext['queuedStartup']>, at: number) {
  const { id, text } = c.messages[0]!;
  const { analyzeRequest, reviewTargets, reviewParallel } = startup;
  const planNewTask = analyzeRequest === true && !reviewTargets?.length && c.config.limits.ordinary >= 2;
  c.lastActivityAt = c.lastProgressAt = at;
  c.nextCheckAt = at + c.config.limits.progressIntervalMs;
  c.resilience = initialResilience(c, at);
  c.reason = '';
  delete c.queuedStartup;
  recordInput(c, id, text, reviewTargets?.length ? 'review' : 'request', planNewTask);
  if (reviewTargets?.length) requestReview(c, id, text, reviewTargets, reviewParallel);
  else owner(c, { type: 'BOUNDARY', id: 'initial', at });
}
