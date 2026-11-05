import { describe, expect, it } from 'vitest';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import type { ArtifactDraft, Intent, TaskEvent } from '../src/types.js';
import { configuration, type EventBody } from './helpers.js';

const original = { name: 'report.md', content: 'original content' };

function task() {
  const config = configuration();
  return initialTask({
    taskId: 'version-task', owner: 'A', config: { ...config, inputAnalysis: { enabled: false } },
    goal: { text: 'Write a report', criteria: [], constraints: [], requiredArtifacts: 1 },
    at: 0, message: { id: 'M1', taskId: 'version-task', at: 0, text: 'Write a report', author: 'user', kind: 'user' },
  });
}

function send(state: TaskSnapshot, event: EventBody) {
  const at = state.context.trace.length + 1;
  return stepTask(state, { id: `event-${at}`, at, ...event } as TaskEvent);
}

function claim(state: TaskSnapshot, kind: Intent['kind']) {
  const work = state.context.intents.find(item => item.status === 'pending' && item.kind === kind)!;
  const next = send(state, { type: 'CLAIM', intentId: work.id });
  expect(next.context.reply.ok).toBe(true);
  return { next, work: next.context.intents.find(item => item.id === work.id)! };
}

function deliver(state: TaskSnapshot, ...drafts: ArtifactDraft[]) {
  const { next, work } = claim(state, 'owner');
  return send(next, { type: 'DELIVER', workId: work.id, text: 'Report summary', artifactIds: [], artifacts: drafts });
}

function check(state: TaskSnapshot, passed = true) {
  const { next, work } = claim(state, 'check');
  const output = {
    type: 'CHECK_RESULT' as const, workId: work.id, candidateRevision: next.context.candidate!.revision!,
    resultId: `result:${work.id}`, passed, gaps: passed ? [] : ['revise'],
  };
  return { next: send(next, output), output };
}

describe('candidate versions in taskMachine', () => {
  it('keeps the original published result and message until a checked replacement publishes', () => {
    const published = check(deliver(task(), original)).next;
    const previous = published.context.artifacts[0]!;
    const candidate = deliver(send(published, { type: 'CONTINUE' }), { name: 'renamed.md', content: 'revised', replacesArtifactId: previous.id });

    expect(candidate.context.publishedDelivery?.artifactIds).toEqual([previous.id]);
    expect(candidate.context.artifacts[1]).toMatchObject({ documentId: previous.documentId, revision: 2, replacesArtifactId: previous.id });
    const revised = check(candidate).next;
    expect(revised.context.publishedDelivery?.artifactIds).toEqual([candidate.context.artifacts[1]!.id]);
    expect(revised.context.messages.find(message => message.kind === 'final')?.artifactIds).toEqual([previous.id]);
    expect(revised.context.artifacts[0]).toEqual(previous);
  });

  it('publishes two independent same-name documents', () => {
    const published = check(deliver(task(), original, { ...original, content: 'another report' })).next;

    expect(published.context.publishedDelivery?.artifactIds).toEqual(published.context.artifacts.map(artifact => artifact.id));
    expect(new Set(published.context.artifacts.map(artifact => artifact.documentId)).size).toBe(2);
  });

  it('preserves the candidate on a stale revision and refuses an earlier check', () => {
    const first = deliver(task(), original);
    const artifactId = first.context.artifacts[0]!.id;
    const old = check(first, false);
    const coordinator = claim(old.next, 'facilitator');
    const owner = send(coordinator.next, { type: 'COORDINATE', workId: coordinator.work.id, decision: { action: 'continue', reason: 'revise' } });
    const second = deliver(owner, { ...original, content: 'revision', replacesArtifactId: artifactId });
    const rejectedCheck = send(second, { ...old.output, resultId: 'late-check', passed: true });

    expect(rejectedCheck.context.reply.ok).toBe(false);
    expect(taskPhase(rejectedCheck)).toBe('checking');
    expect(rejectedCheck.context.publishedDelivery).toBeUndefined();
    const failed = check(rejectedCheck, false).next;
    const facilitator = claim(failed, 'facilitator');
    const pending = send(facilitator.next, { type: 'COORDINATE', workId: facilitator.work.id, decision: { action: 'continue', reason: 'revise' } });
    const stale = deliver(pending, { ...original, content: 'stale revision', replacesArtifactId: artifactId });
    expect(stale.context.reply.ok).toBe(false);
    expect(stale.context.candidate?.revision).toBe(second.context.candidate?.revision);
    expect(stale.context.artifacts).toEqual(second.context.artifacts);
  });

  it('derives separate document identities for old reports and retains their published selection', () => {
    const completed = check(deliver(task(), original, { ...original, content: 'second report' })).next;
    const legacy = structuredClone(persistTask(completed)) as { context: TaskSnapshot['context'] };
    delete legacy.context.publishedDelivery;
    legacy.context.artifacts.forEach(artifact => { delete artifact.documentId; delete artifact.revision; });
    const [first, other] = legacy.context.artifacts;
    const next = deliver(send(restoreTask(legacy), { type: 'CONTINUE' }), { ...original, content: 'updated', replacesArtifactId: first!.id });

    expect(next.context.publishedDelivery?.artifactIds).toEqual([first!.id, other!.id]);
    expect(next.context.artifacts[2]).toMatchObject({ documentId: first!.id, revision: 2, replacesArtifactId: first!.id });
    expect(next.context.artifacts.slice(0, 2)).toEqual([first, other]);
  });
});
