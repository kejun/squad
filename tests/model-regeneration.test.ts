import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { configuration, Harness } from './helpers.js';
import { badModelOutput, goodModelOutput, modelResponse, RegenerationFixture, type ModelKind } from './model-regeneration-fixture.js';

const opened: RegenerationFixture[] = [];
function fixture(kind: ModelKind = 'check') { const f = new RegenerationFixture(kind); opened.push(f); return f; }
afterEach(() => { for (const f of opened.splice(0).reverse()) f.close(); });

describe('model output regeneration', () => {
  it('[BT_M10] regenerates a check with missing gaps instead of pausing the task', async () => {
    const config = configuration({ retries: 2, ordinary: 1 });
    config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'model' } } };
    const h = new Harness(config), owner = h.claim('owner');
    h.event({ type: 'DELIVER', workId: owner.id, text: '完整方案，来源 https://example.com', artifactIds: [] });
    let calls = 0;
    const adapter = new OpenAICompatibleAdapter(config, { clock: () => h.now, transport: async () => {
      const output = ++calls === 1 ? { type: 'check', passed: true } : { type: 'check', passed: true, gaps: [] };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    } });
    await new WorkRunner(h.engine, adapter, () => h.now).runOne(h.room, h.task);
    expect(calls).toBe(2);
    expect(h.context().outcome).toBe('complete');
    expect(h.context().usage.retries).toBe(1);
    expect(h.context().usage.checks).toBe(2);
    expect(h.context().usage.ordinary).toBe(1);
  });

  it('[BT_M12] shares one retry ceiling between format corrections and transient HTTP failures', async () => {
    const f = fixture();
    f.responseFactory = index => index === 1 ? new Response('', { status: 429 }) : modelResponse(badModelOutput('gaps缺失'));
    await f.run();
    expect(f.work.status).toBe('pending'); expect(f.h.context().usage.retries).toBe(2);
    await f.run();
    expect(f.requests).toHaveLength(3); expect(f.repairs).toHaveLength(1);
    expect(f.h.view().phase).toBe('waitingHuman'); expect(f.h.context().usage.checks).toBe(3);
    expect(f.h.context().reason).toContain('OUTPUT_REPAIR_EXHAUSTED');
  });

  it('[BT_M14] checks stop again after saving a repair and before making its follow-up request', async () => {
    const f = fixture(); f.replies = [badModelOutput('gaps缺失'), goodModelOutput('check')];
    const runner = new WorkRunner(f.h.engine, { execute: (work, signal, scope) => f.adapter.execute(work, signal, {
      ...scope, regenerateModelOutput: issue => {
        scope.regenerateModelOutput!(issue); f.h.event({ type: 'STOP' });
      },
    }) }, () => f.h.now);
    await runner.runOne(f.h.room, f.h.task);
    expect(f.requests).toHaveLength(1); expect(f.repairs).toHaveLength(1);
    expect(f.h.context().usage.checks).toBe(1); expect(f.h.context().outcome).toBe('stopped');
  });

  it('[BT_M14] does not renew the deadline or send a request that expires after repair authorization', async () => {
    const f = fixture(), originalDeadline = f.work.deadline;
    f.replies = [badModelOutput('gaps缺失'), goodModelOutput('check')];
    const runner = new WorkRunner(f.h.engine, { execute: (work, signal, scope) => f.adapter.execute(work, signal, {
      ...scope, regenerateModelOutput: issue => {
        scope.regenerateModelOutput!(issue); f.h.now = originalDeadline!;
      },
    }) }, () => f.h.now);
    await runner.runOne(f.h.room, f.h.task);
    expect(f.requests).toHaveLength(1); expect(f.work.deadline).toBe(originalDeadline);
    expect(f.h.context().usage.checks).toBe(1); expect(f.h.context().reason).toContain('WORK_EXPIRED');
  });

  it('[BT_M10] never executes a tool suggested by a malformed checking response', async () => {
    const f = fixture(); f.replies = [{ type: 'web_search', query: 'must not execute' }, goodModelOutput('check')];
    await f.run();
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
    const f = fixture(); f.replies = [badModelOutput('gaps缺失')];
    const runner = new WorkRunner(f.h.engine, { execute: (work, signal, scope) => {
      const { regenerateModelOutput: _repair, ...legacyScope } = scope;
      return f.adapter.execute(work, signal, legacyScope);
    } }, () => f.h.now);
    await runner.runOne(f.h.room, f.h.task);
    expect(f.requests).toHaveLength(1); expect(f.repairs).toHaveLength(0);
    expect(f.h.context().reason).toContain('authorization is unavailable');
  });

  it('[BT_M19] preserves a negative judgment regenerated from a malformed response', async () => {
    const f = fixture(); f.replies = [{ type: 'check', passed: 'false', gaps: '实际缺口' }, { type: 'check', passed: false, gaps: ['实际缺口'] }];
    await f.run();
    expect(f.requests).toHaveLength(2); expect(f.h.view().phase).toBe('coordinating');
    expect(f.h.context().outcome).toBeNull(); expect(f.h.context().usage.retries).toBe(1);
    expect(f.h.context().intents.at(-1)!.payload.reason).toContain('实际缺口');
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
