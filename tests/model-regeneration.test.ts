import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { candidateJudgments, configuration, Harness } from './helpers.js';
import { badModelOutput, goodModelOutput, modelResponse, RegenerationFixture, regenerationConfig, type ModelKind } from './model-regeneration-fixture.js';

const opened: RegenerationFixture[] = [];
function fixture(kind: ModelKind = 'check', limits: Parameters<typeof regenerationConfig>[0] = {}) {
  const f = new RegenerationFixture(kind, limits); opened.push(f); return f;
}
afterEach(() => { for (const f of opened.splice(0).reverse()) f.close(); });

describe('model output regeneration', () => {
  it('[BT_M10] retries a check with missing criteria once using the same fixed material', async () => {
    const f = fixture('check', { ordinary: 1 });
    f.replies = [{ type: 'check' }, goodModelOutput('check')];

    await f.run();
    expect(f.requests).toHaveLength(1);
    await f.run();

    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.messages).toEqual(f.requests[0]!.messages);
    expect(f.h.context().outcome).toBe('complete');
    expect(f.h.context().usage).toMatchObject({ retries: 1, checks: 2, ordinary: 1 });
  });

  it('[BT_M12] shares one retry ceiling between format corrections and transient HTTP failures', async () => {
    const f = fixture();
    f.responseFactory = index => index === 1 ? new Response('', { status: 429 }) : modelResponse({ type: 'check' });
    await f.run();
    expect(f.work.status).toBe('pending'); expect(f.h.context().usage.retries).toBe(1);
    await f.run();
    expect(f.requests).toHaveLength(2); expect(f.repairs).toHaveLength(0);
    expect(f.h.view().phase).toBe('ended'); expect(f.h.context().usage.checks).toBe(2);
    expect(f.h.context().outcome).toBe('partial');
    expect(f.h.context().reason).toContain('HTTP 429');
  });

  it('[BT_M14] does not send a queued check retry after the user stops', async () => {
    const f = fixture(); f.replies = [{ type: 'check' }, goodModelOutput('check')];
    await f.run();

    expect(f.h.event({ type: 'STOP' }).ok).toBe(true);
    await f.run();

    expect(f.requests).toHaveLength(1);
    expect(f.h.context().usage.checks).toBe(1); expect(f.h.context().outcome).toBe('stopped');
  });

  it('[BT_M14] does not renew the deadline or send an expired check retry', async () => {
    const f = fixture(), originalDeadline = f.work.deadline;
    f.replies = [{ type: 'check' }, goodModelOutput('check')];
    await f.run();

    f.h.now = originalDeadline!;
    await f.run();

    expect(f.requests).toHaveLength(1); expect(f.work.deadline).toBe(originalDeadline);
    expect(f.h.context().usage.checks).toBe(1); expect(f.h.context().reason).toContain('WORK_EXPIRED');
  });

  it('[BT_M10] never executes a tool suggested by a malformed checking response', async () => {
    const f = fixture(); f.replies = [{ type: 'web_search', query: 'must not execute' }, goodModelOutput('check')];
    await f.run(); await f.run();
    expect(f.requests).toHaveLength(2); expect(f.webCalls).toBe(0); expect(f.searches).toBe(0);
    expect(f.h.context().outcome).toBe('complete');
  });

  it('[BT_M16] does not classify a real tool execution error as a format validation failure', async () => {
    const f = fixture('owner'); f.replies = [{ type: 'web_search', query: 'valid search request' }];
    await f.run();
    expect(f.requests).toHaveLength(1); expect(f.webCalls).toBe(1); expect(f.repairs).toHaveLength(0);
    expect(f.h.context().usage.retries).toBe(0); expect(f.h.view().phase).toBe('waitingHuman');
  });

  it('[BT_M13] fails closed when a custom host does not implement repair authorization', async () => {
    const f = fixture('owner'); f.replies = [badModelOutput('空答案')];
    const runner = new WorkRunner(f.h.engine, { execute: (work, signal, scope) => {
      const { regenerateModelOutput: _repair, ...legacyScope } = scope;
      return f.adapter.execute(work, signal, legacyScope);
    } }, () => f.h.now);
    await runner.runOne(f.h.room, f.h.task);
    expect(f.requests).toHaveLength(1); expect(f.repairs).toHaveLength(0);
    expect(f.h.context().reason).toContain('authorization is unavailable');
  });

  it('[BT_M28] fails before requesting a model when a custom host omits the trusted coordinator identity', async () => {
    const f = fixture('facilitator');
    const runner = new WorkRunner(f.h.engine, { execute: (work, signal, scope) => {
      const legacy = structuredClone(work);
      delete legacy.payload.owner;
      return f.adapter.execute(legacy, signal, scope);
    } }, () => f.h.now);

    await runner.runOne(f.h.room, f.h.task);

    expect(f.requests).toHaveLength(0);
    expect(f.repairs).toHaveLength(0);
    expect(f.h.view().phase).toBe('waitingHuman');
    expect(f.h.context().reason).toContain('COORDINATION_OWNER_MISSING');
    expect(f.h.context().messages.at(-1)?.text).toBe(f.h.context().reason);
  });

  it('[BT_M19] preserves a negative judgment regenerated from a malformed response', async () => {
    const f = fixture();
    const criteriaResults = candidateJudgments(f.h.context().candidate, { index: 0, status: 'failed', reason: '实际缺口' });
    f.replies = [{ type: 'check' }, { type: 'check', criteriaResults }];

    await f.run(); await f.run();

    expect(f.requests).toHaveLength(2); expect(f.h.view().phase).toBe('running');
    expect(f.h.context().outcome).toBeNull(); expect(f.h.context().usage.retries).toBe(1);
    expect(f.work.criteriaResults).toEqual(criteriaResults);
    expect(f.h.context().intents.at(-1)!.payload).toHaveProperty('priorFindings');
  });

  it.each(['web', 'skills'])('[BT_W02] keeps explicitly disabled %s capabilities outside the format-repair loop', async capability => {
    const config = configuration({ retries: 2 });
    config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'model' } } };
    if (capability === 'web') config.webTools = { enabled: false }; else config.skillSearch = { enabled: false };
    const h = new Harness(config); let calls = 0;
    const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport: async () => {
      calls++; return modelResponse(capability === 'web' ? { type: 'web_search', query: 'not allowed' } : { type: 'findSkills', query: 'not allowed' });
    } });
    await new WorkRunner(h.engine, adapter, () => h.now).runOne(h.room, h.task);
    expect(calls).toBe(1); expect(h.context().usage.retries).toBe(0); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().trace.some(trace => trace.event === 'MODEL_OUTPUT_REPAIR')).toBe(false);
  });
});
