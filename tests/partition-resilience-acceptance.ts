import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import type { InputIntentSpec, Intent, TaskContext, TaskEvent, TaskInput } from '../src/types.js';
import { persistTask, restoreTask } from '../src/task.machine.js';
import { ResilientPartitionModel } from './partition-resilience-model-fixture.js';

type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;
/** Reuses scenario actions, but starts a separate task through real public Engine commands. */
export class PartitionResilienceEngineFixture extends ResilientPartitionModel {
  engine?: TeamEngine;
  store?: SqliteStore;
  directory?: string;
  room = 'partition-resilience'; task = 'task:partition-engine';
  constructor(change: (input: TaskInput) => void = () => {}, planChange?: (spec: InputIntentSpec) => void) {
    super(change);
    const seed = restoreTask(persistTask(this.snapshot)).context;
    this.directory = mkdtempSync(join(tmpdir(), 'squad-partition-resilience-'));
    this.store = new SqliteStore(join(this.directory, 'team.sqlite'));
    this.engine = new TeamEngine(this.store, seed.config, () => this.sequence);
    assert(this.engine.submit(this.room, { id: 'partition-engine', text: seed.goal.text, goal: seed.goal }).ok);
    const interpretation = this.engine.pending(this.room, this.task).find(work => work.kind === 'interpretation')!;
    const work = this.engine.claim(this.room, this.task, interpretation.id)!; assert(work);
    assert(this.send({ type: 'CONSUME', intentId: work.id, attempt: work.attempt, fence: work }).ok);
    const spec = structuredClone(seed.inputAnalyses![0]!.spec!); spec.references = []; planChange?.(spec);
    const interpreted = this.send({ type: 'INTERPRETATION_RESULT', workId: work.id, attempt: work.attempt, fence: work,
      inputId: (work.payload.input as { id: string }).id, spec });
    assert(interpreted.ok, interpreted.code);
  }
  override get context(): TaskContext { return this.engine?.view(this.room, this.task)?.context ?? super.context; }
  override send(body: Body) {
    if (!this.engine) return super.send(body);
    if (body.type === 'RECORD_ACQUISITION') { this.sequence++; return this.engine.recordAcquisition(this.room, this.task, body.receipt); }
    return this.engine.send(this.room, this.task, { ...body, id: `partition-integration:${++this.sequence}`, at: this.sequence } as TaskEvent);
  }
  reopen() {
    assert(this.store && this.directory && this.engine);
    const config = this.engine.config;
    this.store.close(); this.store = new SqliteStore(join(this.directory, 'team.sqlite'));
    this.engine = new TeamEngine(this.store, config, () => this.sequence); this.engine.recover(this.room);
  }
  close() { this.store?.close(); if (this.directory) rmSync(this.directory, { recursive: true, force: true }); }
}

export function partitionEngineRecoveryAcceptance() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const initial = fixture.pending('assistance').map(work => fixture.start(work));
    const first = initial.find(work => work.target === 'B')!;
    fixture.fail(first);
    const second = fixture.start(fixture.pending('assistance').find(work => work.target === 'B')!); fixture.fail(second);
    assert.equal(fixture.pending('assistance').length, 0);
    const originalResults = structuredClone(fixture.context.discussion!.results);
    fixture.acquire(initial.find(work => work.target === 'C')!);
    assert.equal(fixture.context.usage.retries, 2);
    assert.deepEqual(fixture.context.discussion!.results, originalResults);
    const retries = fixture.context.usage.retries, assignments = fixture.context.discussion!.mapReduce!.assignments.length;
    fixture.reopen(); fixture.reopen();
    assert.equal(fixture.context.usage.retries, retries);
    assert.equal(fixture.context.discussion!.mapReduce!.assignments.length, assignments);
    assert.equal(fixture.context.discussion!.results.filter(result => result.status === 'failed').length, 2);
    assert.equal(fixture.engine!.send(fixture.room, fixture.task, { type: 'RECORD_ACQUISITION', intentId: first.id,
      receipt: fixture.context.intents.flatMap(work => work.hostAcquisitions ?? [])[0]!, id: 'untrusted-acquisition', at: fixture.sequence }).code, 'HOST_ONLY_EVENT');
    return { failures: originalResults.length, retries, assignments, persistence: 'SQLite reopened twice',
      sourceBoundary: 'Trusted Engine receipt entry; local operation results controlled; no OS process or external source used' };
  } finally { fixture.close(); }
}

export function prepareSuccessfulClaimFixture() {
  const fixture = new PartitionResilienceEngineFixture();
  try {
    const pending = fixture.pending('assistance')[0]!;
    const claim = { type: 'CLAIM' as const, intentId: pending.id, id: `claim-success:${pending.id}`, at: fixture.sequence };
    assert(fixture.engine!.send(fixture.room, fixture.task, claim).ok);
    const usage = structuredClone(fixture.context.usage), current = fixture.context.intents.find(work => work.id === pending.id)!;
    assert(fixture.engine!.beginExecution(fixture.room, fixture.task, current));
    return { close: () => fixture.close(), replay: () => {
      const duplicate = fixture.engine!.send(fixture.room, fixture.task, claim);
      assert(duplicate.ok && duplicate.duplicate);
      assert.deepEqual(fixture.context.usage, usage);
      assert.equal(fixture.context.intents.find(work => work.id === pending.id)!.attempt, current.attempt);
      assert.equal(fixture.engine!.beginExecution(fixture.room, fixture.task, current), false);
      return { current, duplicate };
    } };
  } catch (error) { fixture.close(); throw error; }
}

export function successfulClaimReplayAcceptance() {
  const fixture = prepareSuccessfulClaimFixture();
  try { return fixture.replay(); } finally { fixture.close(); }
}

export async function prepareTemporaryClaimFixture() {
  const { DiscussionFixture } = await import('./background-discussion-fixture.js');
  const fixture = new DiscussionFixture();
  try {
    fixture.invite(); await fixture.one(); fixture.sqlite();
    const background = fixture.engine.claim(fixture.room, fixture.task, fixture.pending().find(work => work.target === 'B')!.id)!;
    assert(fixture.engine.send(fixture.room, fixture.task, { type: 'HELP', id: 'request-competing-B', at: fixture.now,
      workId: fixture.ownerWork.id, fence: fixture.ownerWork, caller: 'A', target: 'B', requestId: 'primary-B',
      question: '独立核查另一个来源', expected: '原始依据' }).ok);
    const primary = fixture.context().intents.find(work => work.kind === 'assistance' && !work.discussionId)!;
    assert.equal(fixture.engine.claim(fixture.room, fixture.task, primary.id), null);
    assert.equal(fixture.context().reply.code, 'WORK_BUSY');
    return { close: () => fixture.close(), releaseAndRecover: () => {
      assert(fixture.engine.send(fixture.room, fixture.task, { type: 'DISCUSSION_RESULT', id: 'release-background-B', at: fixture.now,
        workId: background.id, attempt: background.attempt, fence: background, discussionId: background.discussionId!,
        text: '背景讨论已经完成', status: 'success' }).ok);
      fixture.recover(); fixture.recover();
      const claimed = fixture.engine.claim(fixture.room, fixture.task, primary.id); assert(claimed);
      assert.equal(claimed.attempt, 1);
      assert(fixture.engine.beginExecution(fixture.room, fixture.task, claimed));
      assert.equal(fixture.engine.beginExecution(fixture.room, fixture.task, claimed), false);
      return { target: claimed.target, attempt: claimed.attempt, execution: fixture.engine.executionPhase(fixture.room, fixture.task, claimed),
        persistence: 'SQLite reopened twice' };
    } };
  } catch (error) { fixture.close(); throw error; }
}

export async function temporaryClaimRecoveryAcceptance() {
  const fixture = await prepareTemporaryClaimFixture();
  try { return fixture.releaseAndRecover(); } finally { fixture.close(); }
}
