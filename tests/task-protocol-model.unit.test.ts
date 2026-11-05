import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { restoreTask, taskPhase } from '../src/task.machine.js';
import { legacyTaskSnapshot } from './legacy-task-snapshot-fixture.js';
import { LocalModel, localModelInput } from './local-model-fixture.js';

const nextConfig = () => ({
  ...localModelInput().config, version: 'team-v3', toolVersion: 'tools-v3',
  models: { default: 'new', services: { new: { model: 'current', baseUrl: 'https://current.example' } } },
});
const newLegacyModel = (version: 1 | 2) => new LocalModel(input => {
  input.config.version = `team-v${version}`;
  input.config.toolVersion = `tools-v${version}`;
  input.config.limits.ordinary = 44;
});
const retry = (m: LocalModel, config = nextConfig()) => m.send({
  type: 'REQUEST_HOST_RETRY', sourceWorkId: m.work.id, sourceOperationId: 'op1',
  sourceRequestHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), fence: m.c, currentConfig: config,
});

function runningLegacyCommand(version: 1 | 2 = 2) {
  const m = newLegacyModel(version);
  assert(m.request().ok);
  assert(m.claim().ok);
  assert(m.started().ok);
  m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot));
  return m;
}

function completedLegacyTask(version: 1 | 2 = 2) {
  const m = runningLegacyCommand(version);
  assert(m.result({ result: { ok: false, code: 'PERM_DENIED', data: { exitCode: 1 } } }).ok);
  assert(m.send({ type: 'STOP' }).ok);
  assert(m.send({ type: 'SETTLE', intentId: m.work.id }).ok);
  assert.equal(taskPhase(m.snapshot), 'ended');
  m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot, true));
  return m;
}

describe('task protocol compatibility in the real task machine', () => {
  it('[BT_A27] preserves incompatible active work as unresolved until the original effect settles', () => {
    const m = runningLegacyCommand();

    const result = m.send({ type: 'RECOVER', config: nextConfig() });

    expect(result.code).toBe('INCOMPATIBLE_EXECUTION');
    expect(taskPhase(m.snapshot)).toBe('waitingHuman');
    expect(m.op?.status).toBe('uncertain');
    expect(m.c.config.version).toBe('team-v2');
  });

  it('[BT_A27] reconciles a known old effect without allowing an active snapshot upgrade', () => {
    const m = runningLegacyCommand();
    m.send({ type: 'RECOVER', config: nextConfig() });

    const result = m.send({ type: 'LOCAL_RECONCILE', intentId: m.work.id, operationId: 'op1', sessionId: 'session1',
      resolution: 'receipt', detail: '已核对原进程', result: { ok: true, code: 'settled', data: { stdout: '原回执' } } });

    expect(result.ok).toBe(true);
    expect(m.op?.status).toBe('succeeded');
    expect(m.c.intents[0]?.status).toBe('done');
    expect(m.c.reason).toBe('Execution version incompatible');
    expect(m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).code).toBe('INCOMPATIBLE_EXECUTION');
    expect(m.c.intents.filter(work => work.kind === 'owner')).toHaveLength(1);
  });

  it('[BT_A27] retires a legacy check with no unsettled external effect so the user can stop and continue', () => {
    const m = newLegacyModel(2);
    assert(m.send({ type: 'DELIVER', workId: m.work.id, fence: m.work, text: '旧候选', artifactIds: [] }).ok);
    const check = m.c.intents.find(work => work.kind === 'check')!;
    assert(m.send({ type: 'CLAIM', intentId: check.id }).ok);
    assert(m.send({ type: 'CONSUME', intentId: check.id }).ok);
    m.snapshot = restoreTask(legacyTaskSnapshot(m.snapshot));

    const recovery = m.send({ type: 'RECOVER', config: nextConfig() });

    expect(recovery.code).toBe('INCOMPATIBLE_EXECUTION');
    expect(m.c.intents.find(work => work.id === check.id)?.status).toBe('done');
    expect(m.c.usage.checks).toBe(1);
    assert(m.send({ type: 'STOP' }).ok);
    expect(taskPhase(m.snapshot)).toBe('ended');
    expect(m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).ok).toBe(true);
    expect(m.c.publishedDelivery).toBeUndefined();
  });

  it.each([
    { route: 'continue', activate: (m: LocalModel) => m.send({ type: 'CONTINUE', currentConfig: nextConfig() }) },
    { route: 'retry', activate: retry },
  ])('[BT_A28] activates a settled old task under current configuration through $route', ({ activate }) => {
    const m = completedLegacyTask();
    const previous = m.c;

    const result = activate(m);

    expect(result.ok).toBe(true);
    expect(taskPhase(m.snapshot)).toBe('running');
    expect(m.c.epoch).toBe(previous.epoch + 1);
    expect(m.c.goalVersion).toBe(previous.goalVersion);
    expect(m.c.config).toMatchObject({ version: 'team-v3', toolVersion: 'tools-v3', models: nextConfig().models, limits: previous.config.limits });
    expect(m.c.usage).toEqual(previous.usage);
    expect(m.c.artifacts).toEqual(previous.artifacts);
    expect(m.c.messages.filter(message => message.kind === 'final')).toEqual(previous.messages.filter(message => message.kind === 'final'));
    expect(m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')).toMatchObject({ epoch: m.c.epoch,
      model: { serviceId: 'new' } });
    expect(m.c.intents.filter(work => work.kind === 'owner' && work.epoch === previous.epoch && work.status === 'pending')).toEqual([]);
  });

  it('[BT_A28] preserves the v1 final-message publication on explicit continuation', () => {
    const m = completedLegacyTask(1);

    const result = m.send({ type: 'CONTINUE', currentConfig: nextConfig() });

    expect(result.ok).toBe(true);
    expect(m.c.publishedDelivery?.artifactIds).toEqual(['legacy-artifact']);
  });

  it('[BT_A28] rejects a legacy pass after the next candidate was submitted', () => {
    const m = completedLegacyTask();
    const originalPublication = m.c.publishedDelivery;
    assert(m.send({ type: 'CONTINUE', currentConfig: nextConfig() }).ok);
    const owner = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
    assert(m.send({ type: 'CLAIM', intentId: owner.id }).ok);
    assert(m.send({ type: 'DELIVER', workId: owner.id, fence: owner, text: '本轮候选', artifactIds: [] }).ok);

    const result = m.send({ type: 'CHECK_RESULT', workId: 'legacy-check', fence: { epoch: 1, goalVersion: 1 },
      passed: true, gaps: [], candidateRevision: 'legacy-candidate', resultId: 'late-legacy-result' });

    expect(result.ok).toBe(false);
    expect(m.c.outcome).toBeNull();
    expect(m.c.publishedDelivery).toEqual(originalPublication);
  });

  it('[BT_A28] rejects a legacy host retry after current permission was revoked', () => {
    const m = completedLegacyTask();
    const config = { ...nextConfig(), localTools: { enabled: false } };

    const result = retry(m, config);

    expect(result.code).toBe('LOCAL_TOOLS_DISABLED');
    expect(taskPhase(m.snapshot)).toBe('ended');
    expect(m.c.config.version).toBe('team-v2');
    expect(m.c.hostRetryRequests).toBeUndefined();
  });

  it('[BT_A28] refuses a different protocol mismatch without migrating history', () => {
    const m = completedLegacyTask();

    const result = m.send({ type: 'CONTINUE', currentConfig: { ...nextConfig(), version: 'unrelated' } });

    expect(result.code).toBe('INCOMPATIBLE_EXECUTION');
    expect(taskPhase(m.snapshot)).toBe('ended');
    expect(m.c.config.version).toBe('team-v2');
  });
});
