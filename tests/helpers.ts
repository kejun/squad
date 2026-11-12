import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TeamEngine, MemoryStore, type TaskEvent, type TeamConfig, type Store, type WorkKind, type Intent } from '../src/index.js';
import type { CriterionJudgment } from '../src/delivery-acceptance.js';
import type { Candidate } from '../src/types.js';
import { createTeamConfig } from '../team.config.js';
const baseline = createTeamConfig({});
// Scripted protocols require finite, explicit fixtures independent of production budget defaults.
baseline.limits = { ordinary: 300, checks: 30, assists: 20, replans: 10, retries: 10,
  workTimeoutMs: 10_800_000, progressIntervalMs: 600_000, repeatThreshold: 20 };
delete baseline.resilience;

export type EventBody = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> & { id?: string; at?: number } : never : never;
export const configuration = (change?: Partial<TeamConfig['limits']>): TeamConfig => ({ ...structuredClone(baseline), limits: { ...baseline.limits, ...change } });
export class Harness {
  now = 0; seq = 0; room = 'room1'; task = 'task:M1'; engine: TeamEngine;
  constructor(readonly config = configuration(), readonly store: Store = new MemoryStore(), initialAt = 0) {
    this.now = initialAt;
    this.engine = new TeamEngine(store, config, () => this.now);
    this.engine.submit(this.room, { id: 'M1', text: 'Write a plan', goal: { text: 'Write a plan', constraints: ['cite sources'], criteria: ['Complete plan'], requiredArtifacts: 0 } });
  }
  event(input: EventBody) {
    if (input.type === 'CHECK_RESULT' && typeof input.passed === 'boolean') {
      const { passed, gaps, ...event } = input;
      const current = this.context();
      const work = input.workId ? current.intents.find(item => item.id === input.workId)
        : current.intents.find(item => item.kind === 'check' && item.status === 'inflight')
          ?? this.engine.pending(this.room, this.task).find(item => item.kind === 'check');
      const matches = work && !current.stopped && work.epoch === current.epoch && work.goalVersion === current.goalVersion && (!input.fence || input.fence.epoch === work.epoch && input.fence.goalVersion === work.goalVersion);
      const check = matches && !work.requestCount && ['pending', 'inflight'].includes(work.status)
        ? this.authorizeCheck(work) : work;
      const candidate = (check?.payload.candidate as Candidate | undefined) ?? current.candidate;
      const revision = event.candidateRevision ?? candidate?.revision;
      input = { ...event, ...(check ? { workId: check.id, fence: event.fence ?? check, attempt: event.attempt ?? check.attempt } : {}),
        ...(revision ? { candidateRevision: revision } : {}),
        criteriaResults: event.criteriaResults ?? candidateJudgments(candidate, passed ? undefined : { index: 0, status: 'failed', reason: gaps?.join('；') || '检查未通过' }) };
    }
    return this.engine.send(this.room, this.task, { ...input, id: input.id ?? `test:${++this.seq}`, at: input.at ?? this.now } as TaskEvent);
  }
  authorizeCheck(work?: Intent) {
    const check = work?.status === 'inflight' ? work
      : work ? this.engine.claim(this.room, this.task, work.id)! : this.claim('check');
    const authorized = this.event({ type: 'CONSUME', intentId: check.id, attempt: check.attempt, fence: check });
    if (!authorized.ok) throw new Error(authorized.code);
    return this.context().intents.find(item => item.id === check.id)!;
  }
  checkResult(check: Intent, criteriaResults: CriterionJudgment[]) {
    const candidate = check.payload.candidate as Candidate;
    assert(candidate.revision);
    return this.event({ type: 'CHECK_RESULT', resultId: `${check.id}:${check.attempt}`, workId: check.id,
      fence: check, attempt: check.attempt, candidateRevision: candidate.revision, criteriaResults });
  }
  view() { return this.engine.view(this.room, this.task)!; }
  context() { return this.view().context; }
  claim(kind?: WorkKind) {
    const item = this.engine.pending(this.room, this.task).find(i => !kind || i.kind === kind);
    if (!item) throw new Error(`No pending ${kind}: ${this.view().phase}`);
    return this.engine.claim(this.room, this.task, item.id)!;
  }
  help(id = 'H1') { return this.event({ type: 'HELP', requestId: id, caller: 'A', target: 'B', question: 'Check recovery', expected: 'Sources and limitations' }); }
  result(id = 'R1', requestId = 'H1') { return this.event({ type: 'HELP_RESULT', requestId, resultId: id, status: 'success', answer: 'Source confirms limitations' }); }
  reopen() { this.engine = new TeamEngine(this.store, this.config, () => this.now); this.engine.recover(this.room); }
}

export function candidateJudgments(candidate: Candidate | null | undefined,
  finding?: { index: number; status: 'failed' | 'unverified'; reason: string }): CriterionJudgment[] {
  return (candidate?.acceptance?.criteria ?? []).map((criterion, index) => finding && index === finding.index
    ? { criterionId: criterion.id, status: finding.status, reason: finding.reason }
    : { criterionId: criterion.id, status: 'passed' });
}

export function saveEvidence(h: Harness, work: Intent, body: string, ok = true) {
  const action = { type: 'runCli' as const, executable: 'node', args: ['read-data.js'] };
  const operation = h.engine.requestLocal(h.room, h.task, work.id, work.attempt, action, [], 'test-workspace');
  const claimed = h.engine.claimLocal(h.room, h.task, work.id, operation.id, work.attempt);
  assert(claimed.response.ok && claimed.operation?.sessionId);
  const identity = { intentId: work.id, operationId: operation.id, sessionId: claimed.operation.sessionId };
  assert(h.event({ type: 'LOCAL_STARTED', ...identity }).ok);
  const capturedEvidence = { stdout: { capturedContentHash: createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body), chars: Array.from(body).length } };
  assert(h.event({ type: 'LOCAL_RESULT', ...identity,
    result: { ok, code: ok ? 'succeeded' : 'EXIT_NONZERO', data: { stdout: body, truncated: false, capturedEvidence } },
    settled: true, effectsKnown: true }).ok);
  return operation.id;
}

export function passFixtureCheck(engine: TeamEngine, room: string, task: string, resultId: string, at = 0) {
  const pending = engine.pending(room, task).find(work => work.kind === 'check');
  assert(pending);
  const check = engine.claim(room, task, pending.id);
  const candidate = engine.view(room, task)?.context.candidate;
  assert(check && candidate?.revision);
  const envelope = { at, fence: check, attempt: check.attempt };
  assert(engine.send(room, task, { ...envelope, id: `${resultId}:request`, type: 'CONSUME', intentId: check.id }).ok);
  assert(engine.send(room, task, { ...envelope, id: resultId, type: 'CHECK_RESULT', workId: check.id, resultId,
    candidateRevision: candidate.revision, criteriaResults: candidateJudgments(candidate) }).ok);
}
