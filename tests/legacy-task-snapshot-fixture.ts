import { persistTask, type TaskSnapshot } from '../src/task.machine.js';
import type { TaskContext } from '../src/types.js';

/** Seed the previous wire format without executing the retired checker in current code. */
export function legacyTaskSnapshot(snapshot: TaskSnapshot, complete = false): unknown {
  const legacy = structuredClone(persistTask(snapshot)) as { context: TaskContext & Record<string, unknown> };
  const c = legacy.context;
  delete c.deliveryCycle;
  for (const work of c.intents) delete work.payload.deliveryProtocol;
  if (!complete) return legacy;

  const owner = c.intents.find(work => work.kind === 'owner')!;
  const artifact = { id: 'legacy-artifact', name: 'legacy.md', content: '原交付正文', goalVersion: c.goalVersion };
  const criteria = [{ id: 'legacy-criterion', text: c.goal.text, goalVersion: c.goalVersion, sources: [{ kind: 'goal', id: c.messages[0]!.id }] }];
  const candidate = { revision: 'legacy-candidate', text: '原交付结论', artifactIds: [artifact.id], goalVersion: c.goalVersion, workId: owner.id,
    acceptance: { revision: 'legacy-candidate', criteria, coverage: [{ criterionId: criteria[0]!.id, refs: [{ kind: 'candidateText' }] }] } };
  Object.assign(c, { candidate, outcome: 'complete', reason: '', stopped: false,
    deliveryAssessments: [{ candidateRevision: candidate.revision, judgments: [{ criterionId: criteria[0]!.id, status: 'passed' }], gaps: [] }] });
  if (c.config.version === 'team-v2') c.publishedDelivery = { revision: candidate.revision, artifactIds: candidate.artifactIds, goalVersion: c.goalVersion, at: c.lastActivityAt };
  c.artifacts.push(artifact);
  c.messages.push({ id: 'legacy-final', at: c.lastActivityAt, taskId: c.taskId, author: c.owner, text: candidate.text, kind: 'final', artifactIds: candidate.artifactIds });
  c.intents.push({ id: 'legacy-check', kind: 'check', target: 'checker', bucket: 'checks', requestCount: 1, status: 'done',
    payload: { candidate }, replay: 'safe', attempt: 1, deadline: owner.deadline, epoch: owner.epoch, goalVersion: owner.goalVersion });
  c.consumedResults.push('legacy-check-result');
  c.usage.checks++;
  return legacy;
}
