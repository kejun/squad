import { describe, expect, it } from 'vitest';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase } from '../src/task.machine.js';
import type { TaskEvent } from '../src/types.js';
import type { EventBody } from './helpers.js';
import { localModelInput } from './local-model-fixture.js';

/** Pure real-XState replay: no runner, adapter, HTTP, filesystem or model calls. */
function model(ordinary = 10) {
  const config = localModelInput().config;
  config.limits.ordinary = ordinary;
  config.inputAnalysis = { enabled: false };
  let snapshot = initialTask({ taskId: 'skill-search', owner: 'A', config, at: 0,
    message: { id: 'M', taskId: 'skill-search', author: 'user', kind: 'user', text: '搜索技能', at: 0 },
    goal: { text: '搜索技能', constraints: [], criteria: ['保留来源'], requiredArtifacts: 0 } });
  const work = snapshot.context.intents[0]!;
  let sequence = 0;
  const send = (body: EventBody) => {
    snapshot = stepTask(snapshot, { ...body, id: `search-model:${++sequence}`, at: sequence } as TaskEvent);
    snapshot = restoreTask(structuredClone(persistTask(snapshot)));
    return snapshot.context.reply;
  };
  expect(send({ type: 'CLAIM', intentId: work.id }).ok).toBe(true);
  // The initial model request consumes the reservation already made by CLAIM.
  expect(send({ type: 'CONSUME', intentId: work.id, fence: work }).ok).toBe(true);
  return { config, work, send, get snapshot() { return snapshot; }, get c() { return snapshot.context; },
    search: () => send({ type: 'CONSUME', intentId: work.id, fence: work }) };
}

describe('skill search reuses the real taskMachine execution boundaries', () => {
  it('[BT_M21] sends a completed search back through the existing delivery path', () => {
    const m = model();
    expect(m.search().ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(2);
    expect(m.c.candidate).toBeNull();
    expect(m.send({ type: 'CONSUME', intentId: m.work.id, fence: m.work }).ok).toBe(true);
    expect(m.send({ type: 'DELIVER', text: '搜索资料', artifactIds: [], workId: m.work.id, fence: m.work }).ok).toBe(true);
    expect(taskPhase(m.snapshot)).toBe('checking');
    expect(m.c.usage.ordinary).toBe(3);
    expect(m.c.intents.find(w => w.id === m.work.id)?.status).toBe('done');
    expect(m.c.intents.filter(w => w.kind === 'check' && w.status === 'pending')).toHaveLength(1);
    expect(m.c.intents.some(w => w.kind === 'tool')).toBe(false);
  });

  it('[BT_M22] settles malformed search output once without a candidate or retry', () => {
    const m = model(); m.search();
    expect(m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: 'Invalid skill search result', transient: false, fence: m.work }).ok).toBe(true);
    expect(taskPhase(m.snapshot)).toBe('waitingHuman');
    expect(m.c.candidate).toBeNull(); expect(m.c.usage.ordinary).toBe(2); expect(m.c.usage.retries).toBe(0);
    expect(m.c.intents.find(w => w.id === m.work.id)?.status).toBe('done');
    expect(m.c.intents.some(w => w.kind === 'check')).toBe(false);
    expect(m.send({ type: 'WORK_FAILED', intentId: m.work.id, reason: 'duplicate', transient: false, fence: m.work }).ok).toBe(false);
  });

  it('[BT_M21] denies the search before I/O when its budget is exhausted', () => {
    const m = model(1);
    expect(m.search().code).toBe('BUDGET_EXHAUSTED');
    expect(m.c.usage.ordinary).toBe(1);
    expect(m.c.intents.find(w => w.id === m.work.id)?.requestCount).toBe(1);
  });

  it('[BT_M21] stops the search lane and refuses a late candidate', () => {
    const m = model(); m.search(); m.send({ type: 'STOP' });
    expect(m.search().ok).toBe(false);
    expect(m.c.intents.some(w => w.kind === 'cancel' && w.status === 'pending')).toBe(true);
    m.send({ type: 'DELIVER', text: '迟到资料', artifactIds: [], workId: m.work.id, fence: m.work });
    expect(m.c.candidate).toBeNull(); expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_M21] rejects references returned under an obsolete goal version', () => {
    const m = model(); m.search();
    expect(m.send({ type: 'DELIVER', text: '过期资料', artifactIds: [], workId: m.work.id,
      fence: { epoch: m.work.epoch, goalVersion: m.work.goalVersion - 1 } }).code).toBe('STALE_FENCE');
    expect(m.c.candidate).toBeNull(); expect(m.c.usage.ordinary).toBe(2);
  });

  it('[BT_M21] recovers and reclaims the same saved safe work before another search', () => {
    const m = model(); m.search();
    expect(m.send({ type: 'RECOVER', config: m.config }).ok).toBe(true);
    expect(m.c.intents.filter(w => w.kind === 'owner')).toHaveLength(1);
    expect(m.c.intents.find(w => w.id === m.work.id)?.status).toBe('pending');
    expect(m.search().code).toBe('WORK_NOT_INFLIGHT');
    expect(m.send({ type: 'CLAIM', intentId: m.work.id }).ok).toBe(true);
    expect(m.c.usage.ordinary).toBe(3);
    expect(m.c.intents.find(w => w.id === m.work.id)?.attempt).toBe(2);
  });
});
