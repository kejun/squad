import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore, TeamEngine, type Intent, type TaskEvent, type TeamConfig } from '../src/index.js';

export type RetryDomain = 'failed' | 'saved';
export class RetryComposition {
  private readonly directory = mkdtempSync(join(tmpdir(), 'squad-retry-composition-'));
  private store: MemoryStore | SqliteStore;
  private config: TeamConfig = {
    version: 'team-v3', toolVersion: 'tools-v3', defaultBot: 'A', inputAnalysis: { enabled: false },
    bots: [{ id: 'A', name: 'A', instructions: '', tools: ['read'] }, { id: 'B', name: 'B', instructions: '', tools: ['read'] }],
    limits: { ordinary: 30, checks: 5, assists: 8, replans: 2, retries: 5, workTimeoutMs: 1000, progressIntervalMs: 1000, repeatThreshold: 3 },
  };
  private engine: TeamEngine;
  private readonly room = 'retry-composition';
  private readonly task = 'task:begin';
  private readonly original: Intent;
  private nextWork: Intent | undefined;
  private sequence = 0;
  private commands = new Set<string>();
  private recovered = false;

  constructor(private readonly backend: 'memory' | 'sqlite', readonly domain: RetryDomain) {
    this.store = this.open();
    this.engine = this.host();
    assert(this.engine.submit(this.room, { id: 'begin', text: '原负责人请求核查' }).ok);
    assert(this.send({ type: 'HELP', requestId: 'original', caller: 'A', target: 'B', question: '核对原始资料', expected: '保留证据', requiredTools: ['read'] }).ok);
    const pending = this.engine.pending(this.room, this.task).find(work => work.kind === 'assistance');
    assert(pending);
    const claimed = this.engine.claim(this.room, this.task, pending.id);
    assert(claimed); this.original = claimed;
    if (domain === 'saved') {
      assert(this.send({ type: 'RECORD_RESULT', requestId: 'original', resultId: 'original-result', status: 'success', answer: '已经保存的原始核查结果', workId: claimed.id, attempt: claimed.attempt, fence: claimed }).ok);
    } else {
      assert(this.send({ type: 'WORK_FAILED', intentId: claimed.id, reason: '核查中断', transient: false, attempt: claimed.attempt }).ok);
    }
    this.observe();
  }

  private open() { return this.backend === 'sqlite' ? new SqliteStore(join(this.directory, 'team.sqlite')) : new MemoryStore(); }
  private host() { return new TeamEngine(this.store, this.config, () => 1); }
  private context() { const view = this.engine.view(this.room, this.task); assert(view); return view.context; }
  private send(body: Record<string, unknown>) {
    return this.engine.send(this.room, this.task, { id: `event:${++this.sequence}`, at: 1, ...body } as TaskEvent);
  }
  private retry(id: string) {
    this.commands.add(id);
    return this.engine.submit(this.room, { id, text: '重试 B 的这次协助', intent: 'retry', replyToTaskId: this.task, retryAssistanceId: 'original' });
  }

  observe() {
    const c = this.context();
    assert.equal(this.engine.roomDeletion(this.room), undefined, 'Slice: deletion is outside retry composition');
    assert(c.resilience && c.resilience.window.hardDeadline > 1, 'Slice: fixed time 1 must precede the task deadline');
    assert.equal(c.resilience.window.openedAt, 1, 'Slice: the original window cannot be silently replaced');
    assert.equal(c.resilience.window.authorizationId, undefined, 'Slice: replacement windows are outside this domain');
    assert.equal(c.resilience.window.repairUsed, 0, 'Slice: no supervisor repair budget is used');
    assert.equal(c.resilience.window.repairDeadline, undefined, 'Slice: no repair window');
    assert.deepEqual([c.resilience.gates.length, c.resilience.skips.length, c.resilience.cleanup.length], [0, 0, 0],
      'Slice: human gates, skips and physical cleanup are separate domains');
    assert.equal(c.resilience.frozen, undefined, 'Slice: no salvage publication');
    assert.equal(c.intents.some(work => work.replay === 'unsafe'), false, 'Slice: no legacy unsafe effects or global barrier');
    assert.equal(c.candidate, null, 'Slice: delivery/checking is outside retry composition');
    assert.equal(c.discussion, undefined, 'Slice: no partition scheduler');
    assert.equal(c.review, undefined, 'Slice: no multi-member review queue');
    assert.equal(c.intents.some(work => work.localOperations?.length || work.hostAcquisitions?.length), false,
      'Slice: no local process or acquisition receipt');
    assert.equal(c.goal.resourceRequirements?.length ?? 0, 0, 'Slice: no external source obligation');
    assert.equal(Object.keys(c.goal.partitionResources ?? {}).length, 0, 'Slice: no partition resource obligation');
    assert.equal(c.trace.some(entry => ['SUPERVISE', 'HUMAN_GATE_DECISION', 'EXECUTION_NOT_STARTED'].includes(entry.event)), false,
      'Slice: new protocol events are not stuttered away');
    const descendants = c.assists.filter(help => help.retryOf === 'original');
    const originalConsumed = c.results.some(result => result.requestId === 'original' && result.consumed);
    const memberRevoked = !this.config.bots.find(bot => bot.id === 'B')?.tools.includes('read');
    const ownerChanged = c.owner !== 'A';
    const resumes = c.intents.filter(work => work.kind === 'owner' && ['original-result', 'retry-result'].includes(String(work.payload.resultId))).length;
    assert(descendants.length <= 1, 'RetryUniqueness: more than one retryOf successor');
    assert(!(originalConsumed && descendants.length), 'ExclusiveResultChoice: consumed original and retried it');
    assert(this.domain !== 'saved' || descendants.length === 0, 'ExclusiveResultChoice: repeated saved helper work');
    assert(!memberRevoked || descendants.length === 0, 'RetryAuthority: revoked tool still scheduled helper');
    assert(!ownerChanged || descendants.length === 0, 'RetryOwner: changed owner still retried old dependency');
    assert(resumes <= 1, 'RetryHandoff: more than one owner continuation');
    const helper = descendants[0];
    const stage = helper ? ({ pending: 1, running: 2, answered: 3, success: 4, partial: 4, failed: 4, timeout: 4, cancelled: 4 } as const)[helper.status] : 0;
    if (stage === 4) assert.equal(resumes, 1, 'RetryHandoff: settled retry missing owner continuation');
    if (originalConsumed) assert.equal(resumes, 1, 'RetryHandoff: consumed saved result missing owner continuation');
    const retryPending = !!helper && c.intents.some(work => work.payload.requestId === helper.id && work.kind === 'assistance' && work.status === 'pending');
    return { savedInitial: this.domain === 'saved', command1: this.commands.has('retry:1'), command2: this.commands.has('retry:2'),
      successors: descendants.length, stage, retryPending, originalConsumed, resumes, memberRevoked, ownerChanged, recovered: this.recovered };
  }

  apply(action: string) {
    switch (action) {
      case 'Retry1': this.retry('retry:1'); break;
      case 'Retry2': this.retry('retry:2'); break;
      case 'ReplayCommand': {
        const id = this.commands.has('retry:1') ? 'retry:1' : 'retry:2';
        const result = this.retry(id); assert.equal(result.duplicate, true, 'RetryReceipt: cached command was not replayed'); break;
      }
      case 'LateOriginal': {
        const before = this.observe();
        const reply = this.send({ type: 'RECORD_RESULT', requestId: 'original', resultId: 'late-original', status: 'success', answer: '旧尝试迟到', workId: this.original.id, attempt: this.original.attempt, fence: this.original });
        assert(!reply.ok, 'RetryAttempt: settled original work accepted a late result');
        assert.deepEqual(this.observe(), before, 'RetryAttempt: late result affected retry'); break;
      }
      case 'RevokePermission':
        this.config = { ...this.config, bots: this.config.bots.map(bot => bot.id === 'B' ? { ...bot, tools: [] } : bot) };
        this.engine = this.host(); break;
      case 'ChangeOwner': assert(this.send({ type: 'HANDOFF', owner: 'B' }).ok); break;
      case 'ClaimRetry': {
        const pending = this.engine.pending(this.room, this.task).find(work => work.kind === 'assistance'); assert(pending);
        const work = this.engine.claim(this.room, this.task, pending.id); assert(work); this.nextWork = work; break;
      }
      case 'SaveRetry': {
        assert(this.nextWork);
        assert(this.send({ type: 'RECORD_RESULT', requestId: String(this.nextWork.payload.requestId), resultId: 'retry-result', status: 'success', answer: '新尝试的核查结果', workId: this.nextWork.id, attempt: this.nextWork.attempt, fence: this.nextWork }).ok); break;
      }
      case 'ConsumeOriginal': case 'ConsumeRetry': assert(this.engine.flushResults(this.room, this.task)); break;
      case 'Recover':
        if (this.backend === 'sqlite') { this.store.close(); this.store = this.open(); }
        this.engine = this.host();
        assert(this.send({ type: 'RECOVER', config: this.config }).ok);
        this.recovered = true; break;
      default: throw new Error(`Unknown retry composition action: ${action}`);
    }
    return this.observe();
  }

  close() { this.store.close(); rmSync(this.directory, { recursive: true, force: true }); }
}

export function verifyRetryComposition(domain: RetryDomain) {
  const paths = domain === 'saved'
    ? [['Retry1', 'Retry2', 'ReplayCommand', 'Recover'], ['RevokePermission', 'Retry1', 'Recover', 'ConsumeOriginal', 'Retry2']]
    : [['Retry1', 'ClaimRetry', 'SaveRetry', 'ConsumeRetry', 'Retry2', 'ReplayCommand', 'LateOriginal', 'Recover'],
       ['RevokePermission', 'Retry1', 'Recover', 'Retry2'], ['ChangeOwner', 'Retry1', 'Recover', 'Retry2']];
  const outcomes = [];
  for (const backend of ['memory', 'sqlite'] as const) {
    for (const path of paths) {
      const run = new RetryComposition(backend, domain);
      try { for (const action of path) run.apply(action); outcomes.push({ backend, ...run.observe() }); } finally { run.close(); }
    }
  }
  return outcomes;
}

export function verifyRetryAuthorityCase(restriction: string) {
  assert(['RevokePermission', 'ChangeOwner'].includes(restriction));
  const results = [];
  for (const backend of ['memory', 'sqlite'] as const) {
    const run = new RetryComposition(backend, 'failed');
    try {
      run.apply(restriction); run.apply('Retry1'); run.apply('Recover'); run.apply('Retry2');
      results.push({ backend, ...run.observe() });
    } finally { run.close(); }
  }
  return results;
}
