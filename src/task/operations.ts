import { type ArtifactDraft, type Intent, type TaskContext, type TaskEvent } from '../types.js';
import { compactMessage, isLongResult } from '../presentation.js';
import { capabilities, discussionActive, fence, unresolvedInput } from './facts.js';
import { resolveModel } from '../model-config.js';
import { cancelLocalOperations, localEnabled, localPhysicalPending } from '../local-operation.js';

export function message(c: TaskContext, e: TaskEvent, author: string, text: string, kind: TaskContext['messages'][number]['kind'], extra: Partial<TaskContext['messages'][number]> = {}, summary?: string) {
  const shown = kind === 'user' ? text : compactMessage(text, summary);
  c.messages.push({ id: `${c.taskId}:message:${c.nextSeq++}`, taskId: c.taskId, at: e.at, author, text: shown, kind,
    ...(shown === text ? {} : { detailText: text }), ...(e.workId ? { workId: e.workId } : {}), ...extra });
}

export function saveReports(c: TaskContext, e: TaskEvent, text: string, author: string, drafts: ArtifactDraft[] = []): string[] {
  const reports = drafts.length ? drafts : isLongResult(text) ? [{ name: author === c.owner ? 'result.md' : 'review.md', content: text }] : [];
  if (reports.length) {
    c.lastProgressAt = e.at; c.nextCheckAt = e.at + c.config.limits.progressIntervalMs; c.repeat.count = 0;
  }
  return reports.map((draft, index) => {
    const id = `${c.taskId}:artifact:${e.id}:${index + 1}`;
    c.artifacts.push({ id, name: draft.name, content: draft.content, author, goalVersion: c.goalVersion, ...(e.workId ? { workId: e.workId } : {}) });
    c.progressRefs.push(id);
    return id;
  });
}

export function intent(c: TaskContext, at: number, kind: Intent['kind'], target: string, payload: Record<string, unknown> = {}, replay: Intent['replay'] = 'safe'): Intent {
  const item: Intent = { id: `${c.taskId}:E${c.epoch}:${kind}:${c.nextSeq++}`, kind, target,
    payload: kind === 'facilitator' ? { ...payload, owner: c.owner } : payload,
    ...(c.localSkillVersions?.length ? { localSkills: structuredClone(c.localSkillVersions) } : {}),
    ...fence(c), status: 'pending', replay, attempt: 0, deadline: at + c.config.limits.workTimeoutMs,
    bucket: kind === 'check' ? 'checks' : kind === 'cancel' ? 'none' : 'ordinary', requestCount: 0 };
  const model = resolveModel(c.config, kind, target);
  if (model) item.model = model;
  if (['owner', 'assistance', 'facilitator', 'check'].includes(kind)) item.payload.capabilities = { ...capabilities(c, target), ...(payload.capabilities as object ?? {}), localTools: localEnabled(c.config, target) };
  c.intents.push(item);
  return item;
}

export function cancelWork(c: TaskContext, e: TaskEvent, all = false) {
  for (const item of [...c.intents]) {
    if (item.kind === 'cancel') continue;
    if (item.discussionId && !all) continue;
    cancelLocalOperations(item);
    if (item.status === 'pending') item.status = 'cancelled';
    if (item.status === 'inflight' && !c.intents.some(i => i.kind === 'cancel' && i.payload.intentId === item.id && i.status !== 'cancelled')) {
      intent(c, e.at, 'cancel', item.target, { intentId: item.id });
    }
  }
  if (all && discussionActive(c)) c.discussion!.status = 'cancelled';
}

export function release(c: TaskContext, id: string | undefined) {
  if (!id) return;
  const work = c.intents.find(i => i.id === id);
  if (work && localPhysicalPending(work)) return;
  if (work) { cancelLocalOperations(work); work.status = 'done'; }
  for (const cancel of c.intents.filter(i => i.kind === 'cancel' && i.payload.intentId === id)) cancel.status = 'done';
}

export function conversationInput(c: TaskContext) {
  return { messages: [...(c.history?.messages ?? []), ...c.messages], candidate: c.candidate,
    inputIntents: (c.inputAnalyses ?? []).filter(input => input.status === 'resolved'),
    conversation: { artifacts: c.history?.artifacts ?? [], board: c.history?.board ?? [], tasks: c.history?.tasks ?? [], truncated: c.history?.truncated ?? false },
    ...(c.review ? { review: { ...c.review, results: c.assists.filter(h => h.reviewId === c.review!.id).map(h => ({ target: h.target, requestId: h.id, status: h.status, answer: h.answer, artifactIds: h.artifactIds })) } } : {}),
    ...(c.discussion ? { discussion: structuredClone(c.discussion) } : {}) };
}

export function owner(c: TaskContext, e: TaskEvent, payload: Record<string, unknown> = {}) {
  if (c.stopped || unresolvedInput(c) || discussionActive(c) || c.intents.some(localPhysicalPending)) return;
  // Pending instructions are superseded, not executed in parallel.
  for (const i of c.intents) if (i.kind === 'owner' && i.status === 'pending') i.status = 'cancelled';
  intent(c, e.at, 'owner', c.owner, { ...payload, goal: c.goal, inputs: c.inputs.filter(n => n.applied),
    board: c.board, artifacts: c.artifacts, repeat: c.repeat, ...conversationInput(c),
    capabilities: capabilities(c), roster: c.config.bots.map(b => ({ id: b.id, name: b.name, instructions: b.instructions, tools: b.tools })) });
  c.nextCheckAt = e.at + c.config.limits.progressIntervalMs;
}

export function coordinate(c: TaskContext, e: TaskEvent, reason: string) {
  cancelWork(c, e);
  c.reason = reason;
  if (unresolvedInput(c)) { c.deferredCoordination = true; return; }
  c.deferredCoordination = false;
  intent(c, e.at, 'facilitator', 'facilitator', { reason, goal: c.goal, board: c.board, artifacts: c.artifacts,
    ...conversationInput(c), repeat: c.repeat, roster: c.config.bots, usage: c.usage, limits: c.config.limits, capabilities: capabilities(c) });
  c.nextCheckAt = e.at + c.config.limits.progressIntervalMs;
}

export function finish(c: TaskContext, e: TaskEvent, outcome: TaskContext['outcome'], reason: string) {
  c.hostSession = undefined;
  cancelWork(c, e, true); c.outcome = outcome; c.reason = reason;
  for (const input of c.inputAnalyses ?? []) if (['pending', 'inflight'].includes(input.status)) {
    input.status = outcome === 'stopped' ? 'cancelled' : 'failed'; input.error = reason;
  }
  if (c.review) c.review.status = outcome === 'stopped' ? 'cancelled' : 'complete';
  if (outcome !== 'stopped') {
    const full = `${c.candidate?.text ?? ''}${reason ? `\n${reason}` : ''}`.trim();
    const summary = reason ? `${reason}\n${c.candidate?.summary ?? compactMessage(c.candidate?.text ?? '')}`.trim() : c.candidate?.summary;
    message(c, e, c.owner, full, 'final', {
      artifactIds: c.candidate?.artifactIds.filter(id => c.artifacts.some(artifact => artifact.id === id && artifact.goalVersion === c.goalVersion)) ?? [],
      ...(c.candidate?.workId ? { workId: c.candidate.workId } : {}),
    }, summary);
  }
}
