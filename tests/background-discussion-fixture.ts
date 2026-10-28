import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore, TeamEngine, WorkRunner, type Intent, type Store, type TaskEvent, type WorkAdapter, type WorkOutput } from '../src/index.js';
import { configuration } from './helpers.js';

export class DiscussionFixture {
  now = 0;
  readonly config = configuration();
  readonly room = 'discussion-room';
  readonly task = 'task:plan';
  readonly calls: Intent[] = [];
  store: Store = new MemoryStore();
  engine: TeamEngine;
  ownerWork: Intent;
  seq = 0;
  failStage?: string;
  failMode?: string;
  directory?: string;
  repeated?: TaskEvent;
  constructor(ordinary?: number, withModels = false) {
    if (ordinary !== undefined) this.config.limits.ordinary = ordinary;
    if (withModels) this.config.models = { default: 'members', facilitator: 'coordinator', services: {
      members: { baseUrl: 'http://127.0.0.1:9/v1', model: 'member-model' },
      coordinator: { baseUrl: 'http://127.0.0.1:9/v1', model: 'coordinator-model' },
    } };
    this.engine = new TeamEngine(this.store, this.config, () => this.now);
    this.engine.submit(this.room, { id: 'plan', text: '制定有证据的可离线同步方案' });
    this.ownerWork = this.engine.claim(this.room, this.task, this.engine.pending(this.room, this.task)[0]!.id)!;
    assert.equal(this.ownerWork.kind, 'owner');
  }
  context() { return this.engine.view(this.room, this.task)!.context; }
  pending() { return this.engine.pending(this.room, this.task); }
  invite(text = '所有人都参与讨论一下', id = `invite-${++this.seq}`) {
    const reply = this.engine.submit(this.room, { id, text }); assert(reply.ok); return reply;
  }
  output(work: Intent): WorkOutput {
    const stage = work.kind === 'facilitator' ? '安排' : work.kind === 'discussionSummary' ? '汇总' : '成员';
    if (work.discussionId && this.failStage === stage && (stage !== '成员' || work.target === 'B')) throw new Error(this.failMode === '超时' ? 'discussion deadline exceeded' : `${stage}服务失败`);
    if (work.kind === 'facilitator') return { type: 'decision', decision: { action: 'review', question: '从各自专业视角讨论离线同步方案的风险、依据与替代选择', expected: '具体意见及来源', reason: '用户直接要求空闲成员讨论' } };
    if (work.kind === 'assistance') return { type: 'answer', text: `${work.target} 的完整意见与独立依据`, summary: `${work.target} 的建议`, artifacts: [{ name: `${work.target}.md`, content: `${work.target} 的完整报告与来源 https://example.com/source` }] };
    if (work.kind === 'discussionSummary') return { type: 'answer', text: '协调员汇总：保留各成员依据、共识、分歧及未完成项。' };
    if (work.kind === 'check') return { type: 'check', passed: true, gaps: [] };
    assert.equal(work.kind, 'owner');
    return { type: 'deliver', text: '方案师已结合草稿、协调员汇总和完整成员意见完善方案。', artifactIds: [] };
  }
  adapter(): WorkAdapter { return { execute: async work => { this.calls.push(work); return this.output(work); } }; }
  async one(id?: string) { return new WorkRunner(this.engine, this.adapter(), () => this.now).runOne(this.room, this.task, id); }
  async discuss() {
    for (let n = 0; n < 24; n++) {
      if (!this.context().discussion || ['ready', 'delivered', 'cancelled'].includes(this.context().discussion!.status)) return;
      assert(await this.one(), '后台讨论应能在原请求返回前推进');
    }
    assert.fail('讨论超出有限执行步骤');
  }
  async drain() {
    for (let n = 0; n < 30; n++) if (!await this.one()) return;
    assert.fail('工作超出有限执行步骤');
  }
  draft() {
    const work = this.ownerWork;
    const reply = this.engine.send(this.room, this.task, { type: 'DELIVER', id: 'draft', at: this.now, workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, text: '方案师原始草稿', artifactIds: [] });
    assert(reply.ok);
  }
  async busyB() {
    assert(this.engine.send(this.room, this.task, { type: 'HELP', id: 'main-help', at: this.now, workId: this.ownerWork.id, fence: { epoch: 1, goalVersion: 1 }, caller: 'A', target: 'B', requestId: 'primary-B', question: '核查已有资料', expected: '核查依据' }).ok);
    assert(this.engine.claim(this.room, this.task, this.pending()[0]!.id));
  }
  async occupyAll() {
    this.invite('大家都提提意见', 'older-discussion'); await this.one();
    for (const work of this.pending()) assert(this.engine.claim(this.room, this.task, work.id));
    assert.equal(this.context().intents.filter(work => work.kind === 'assistance' && work.status === 'inflight').length, 4);
    this.changeGoal(); // Cancellation is not settlement: these members are still physically occupied.
  }
  changeGoal() {
    assert(this.engine.submit(this.room, { id: `goal-${++this.seq}`, text: '新增硬约束：禁止持有外部密钥', goal: { ...this.context().goal, constraints: ['禁止持有外部密钥'] } }).ok);
  }
  async duplicateResult() {
    await this.one();
    const work = this.pending().find(item => item.kind === 'assistance')!;
    const claimed = this.engine.claim(this.room, this.task, work.id)!;
    const event: TaskEvent = { type: 'DISCUSSION_RESULT', id: 'saved-member', at: this.now, workId: claimed.id, fence: { epoch: 1, goalVersion: 1 }, discussionId: claimed.discussionId!, text: 'B 的唯一意见', status: 'success' };
    assert(this.engine.send(this.room, this.task, event).ok);
    assert(this.engine.send(this.room, this.task, event).duplicate);
    const alternate = this.engine.send(this.room, this.task, { ...event, id: 'different-event-same-work' });
    assert.equal(alternate.ok, false);
  }
  async startClaimed() {
    const work = this.pending().find(item => item.discussionId)!;
    const claimed = this.engine.claim(this.room, this.task, work.id)!;
    this.repeated = { type: 'DISCUSSION_PLAN', id: 'late-plan', at: this.now, workId: claimed.id, fence: { epoch: claimed.epoch, goalVersion: claimed.goalVersion }, discussionId: claimed.discussionId!, decision: { action: 'review', question: '旧讨论问题', expected: '意见', reason: '旧请求' } };
  }
  sqlite() {
    this.directory = mkdtempSync(join(tmpdir(), 'squad-discussion-'));
    const next = new SqliteStore(join(this.directory, 'team.sqlite'));
    const room = this.store.read(this.room);
    next.transact(this.room, tx => Object.assign(tx.room, room));
    this.store = next; this.engine = new TeamEngine(next, this.config, () => this.now);
  }
  recover() {
    assert(this.directory); (this.store as SqliteStore).close();
    this.store = new SqliteStore(join(this.directory, 'team.sqlite'));
    this.engine = new TeamEngine(this.store, this.config, () => this.now);
    this.engine.recover(this.room); this.engine.recover(this.room);
  }
  assertHandoff() {
    const owner = this.pending().filter(work => work.kind === 'owner');
    assert.equal(owner.length, 1); assert.equal(owner[0]!.target, 'A');
    assert.equal((owner[0]!.payload.candidate as { text: string }).text, '方案师原始草稿');
    const input = owner[0]!.payload.discussion as { status: string; results: unknown[]; summary: string };
    assert.equal(input.status, 'delivered'); assert.equal(input.results.length, 4); assert(input.summary.includes('协调员汇总'));
    assert(JSON.stringify(owner[0]!.payload).includes('B 的完整意见与独立依据'));
    assert(JSON.stringify(owner[0]!.payload).includes('B 的完整报告与来源'));
    assert.equal(this.context().messages.filter(message => message.text.includes('讨论汇总及成员原始意见已交给')).length, 1);
  }
  close() { if (this.directory) { (this.store as SqliteStore).close(); rmSync(this.directory, { recursive: true, force: true }); delete this.directory; } }
}
