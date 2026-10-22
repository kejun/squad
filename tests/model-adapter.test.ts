import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter, resolveModel, TeamEngine, validateConfig, WorkRunner, type TeamConfig } from '../src/index.js';
import { configuration, Harness } from './helpers.js';

function modelConfig(): TeamConfig {
  const c = configuration();
  c.models = { default: 'main', facilitator: 'fast', check: 'review', services: {
    main: { baseUrl: 'https://models.example/v1', model: 'main-model', apiKeyEnv: 'TEST_MODEL_KEY' },
    fast: { baseUrl: 'https://models.example/compatible-mode/v1/', model: 'fast-model' },
    review: { baseUrl: 'https://review.example/api/v1', model: 'review-model', jsonMode: false },
  } };
  c.bots[1]!.model = 'fast';
  return c;
}
function completion(value: unknown, finish = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finish, message: { role: 'assistant', content: JSON.stringify(value) } }] });
}
function setup(config = modelConfig(), transport: typeof fetch = async () => completion({ type: 'answer', text: 'done' })) {
  const h = new Harness(config);
  const adapter = new OpenAICompatibleAdapter(config, { transport, env: { TEST_MODEL_KEY: 'test-secret' }, clock: () => h.now });
  return { h, adapter, runner: new WorkRunner(h.engine, adapter, () => h.now) };
}

describe('third-party model configuration and transport', () => {
  it('routes member, facilitator and checking models independently', () => {
    const c = modelConfig();
    expect(resolveModel(c, 'owner', 'A')?.serviceId).toBe('main');
    expect(resolveModel(c, 'assistance', 'B')?.serviceId).toBe('fast');
    expect(resolveModel(c, 'facilitator', 'facilitator')?.serviceId).toBe('fast');
    expect(resolveModel(c, 'check', 'facilitator')?.serviceId).toBe('review');
    const h = new Harness(c); h.event({ type: 'BLOCKED', reason: 'needs coordination' });
    expect(h.engine.pending(h.room, h.task)[0]?.model?.serviceId).toBe('fast');
    delete c.models!.check; delete c.models!.facilitator;
    expect(resolveModel(c, 'check', 'facilitator')?.serviceId).toBe('main');
  });

  it('posts to the custom endpoint and keeps credentials outside snapshots', async () => {
    const http = vi.fn<typeof fetch>(async () => completion({ type: 'answer', text: 'provider answer' }));
    const c = modelConfig(); c.models!.services.main!.temperature = 0.3; c.models!.services.main!.maxTokens = 1024;
    c.models!.services.main!.extraBody = { enable_thinking: false };
    const { h, runner } = setup(c, http); await runner.runOne(h.room, h.task);
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/chat/completions');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-secret' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'main-model', stream: false, temperature: 0.3, max_tokens: 1024, enable_thinking: false, response_format: { type: 'json_object' } });
    expect(h.context().candidate?.text).toBe('provider answer'); expect(h.context().usage.ordinary).toBe(1);
    expect(JSON.stringify(h.store.read(h.room))).not.toContain('test-secret');
  });

  it('allows local services without keys and providers without JSON mode', async () => {
    const c = modelConfig(); const service = c.models!.services.main!;
    service.baseUrl = 'http://127.0.0.1:11434/v1/'; delete service.apiKeyEnv; service.jsonMode = false;
    const http = vi.fn<typeof fetch>(async () => completion({ type: 'answer', text: 'local answer' }));
    const { h, runner } = setup(c, http); await runner.runOne(h.room, h.task);
    expect(http.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(http.mock.calls[0]![1]?.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(http.mock.calls[0]![1]?.body))).not.toHaveProperty('response_format');
  });

  it('registers find skills in the model protocol and charges search plus follow-up', async () => {
    const http = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(completion({ type: 'findSkills', query: 'testing' }))
      .mockResolvedValueOnce(completion({ type: 'answer', text: 'found a skill' }));
    const search = vi.fn<typeof fetch>(async () => Response.json({ skills: [{ id: 'review', name: 'review', source: 'owner/repo', installs: 123 }] }));
    const { h, adapter } = setup(modelConfig(), http);
    await new WorkRunner(h.engine, adapter, () => h.now, search).runOne(h.room, h.task);
    expect(http).toHaveBeenCalledTimes(2); expect(search).toHaveBeenCalledTimes(1);
    expect(h.context().usage.ordinary).toBe(3);
    expect(String(http.mock.calls[1]![1]?.body)).toContain('skillSearchResults');
  });

  it('blocks the follow-up model request when the shared budget is spent', async () => {
    const c = modelConfig(); c.limits.ordinary = 2;
    const http = vi.fn<typeof fetch>(async () => completion({ type: 'findSkills', query: 'testing' }));
    const { h, adapter } = setup(c, http);
    await new WorkRunner(h.engine, adapter, () => h.now, async () => Response.json({ skills: [] })).runOne(h.room, h.task);
    expect(http).toHaveBeenCalledTimes(1); expect(h.context().usage.ordinary).toBe(2);
    expect(h.view().phase).toBe('waitingHuman');
  });

  it('requires the configured key before issuing HTTP', async () => {
    const c = modelConfig(); const h = new Harness(c); const http = vi.fn<typeof fetch>();
    const runner = new WorkRunner(h.engine, new OpenAICompatibleAdapter(c, { transport: http, env: {}, clock: () => 0 }), () => 0);
    await runner.runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().reason).toContain('TEST_MODEL_KEY');
  });

  it.each([401, 403, 408, 429, 503])('uses bounded orchestration retries for HTTP %i', async status => {
    const http = vi.fn<typeof fetch>(async () => new Response('provider body must not be persisted', { status }));
    const c = modelConfig(); c.limits.retries = 1;
    const { h, runner } = setup(c, http); await runner.runOne(h.room, h.task);
    if ([408, 429, 503].includes(status)) {
      expect(h.view().phase).toBe('running'); expect(h.context().usage.retries).toBe(1);
      await runner.runOne(h.room, h.task); expect(http).toHaveBeenCalledTimes(2);
      expect(h.context().usage.ordinary).toBe(2);
    } else expect(http).toHaveBeenCalledTimes(1);
    expect(h.view().phase).toBe('waitingHuman');
    expect(JSON.stringify(h.context())).not.toContain('provider body must not be persisted');
  });

  it.each([
    { type: 'decision', decision: { action: 'finish', reason: 'not an owner action' } },
    { type: 'help', target: 'B', question: '', expected: 'facts' },
    { type: 'findSkills', query: '' },
  ])('rejects malformed or wrong-role output %#', async value => {
    const { h, runner } = setup(modelConfig(), async () => completion(value));
    await runner.runOne(h.room, h.task);
    expect(h.view().phase).toBe('waitingHuman'); expect(h.context().outcome).toBeNull();
  });

  it('rejects truncated completions instead of publishing partial JSON', async () => {
    const { h, runner } = setup(modelConfig(), async () => completion({ type: 'answer', text: 'cut off' }, 'length'));
    await runner.runOne(h.room, h.task); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().candidate).toBeNull();
  });

  it('sanitizes transport failures before storing task errors', async () => {
    const { h, runner } = setup(modelConfig(), async () => { throw new Error('failure containing test-secret'); });
    await runner.runOne(h.room, h.task);
    expect(h.context().usage.retries).toBe(1); expect(JSON.stringify(h.context())).not.toContain('test-secret');
  });

  it('cancels an in-flight HTTP request and does not publish its result', async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const { h, runner } = setup(modelConfig(), async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    });
    const running = runner.runOne(h.room, h.task); await ready;
    h.event({ type: 'STOP' }); await runner.runOne(h.room, h.task); await running;
    expect(h.context().outcome).toBe('stopped'); expect(h.context().candidate).toBeNull();
  });

  it('honors the original operation deadline', async () => {
    const c = modelConfig(); c.limits.workTimeoutMs = 10;
    const { h, runner } = setup(c, async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('missing abort')), 1000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    }));
    await runner.runOne(h.room, h.task);
    expect(h.view().phase).toBe('waitingHuman'); expect(h.context().reason).toContain('deadline');
  });

  it('pauses recovery when the bound provider or model changes', () => {
    const c = modelConfig(); const h = new Harness(c); const changed = structuredClone(c);
    changed.models!.services.main!.model = 'another-model';
    const e = new TeamEngine(h.store, changed, () => 0); e.recover(h.room);
    expect(e.view(h.room, h.task)?.phase).toBe('waitingHuman');
    expect(e.view(h.room, h.task)?.context.reason).toBe('Model configuration changed');
    expect(e.send(h.room, h.task, { type: 'CONTINUE', id: 'resume', at: 0 }).ok).toBe(false);
  });

  it('also detects provider changes while waiting for human input', () => {
    const c = modelConfig(); const h = new Harness(c); h.event({ type: 'WAIT_USER', question: 'choose' });
    const changed = structuredClone(c); changed.models!.services.main!.baseUrl = 'https://another.example/v1';
    const e = new TeamEngine(h.store, changed, () => 0); e.recover(h.room);
    expect(e.view(h.room, h.task)?.context.reason).toBe('Model configuration changed');
  });

  it('rejects empty answers before advancing the state machine', async () => {
    const { h, runner } = setup(modelConfig(), async () => completion({ type: 'answer', text: ' ' }));
    await runner.runOne(h.room, h.task);
    expect(h.view().phase).toBe('waitingHuman'); expect(h.context().candidate).toBeNull();
  });

  it('passes the operation deadline to skill searches', async () => {
    const c = modelConfig(); c.limits.workTimeoutMs = 30;
    const { h, adapter } = setup(c, async () => completion({ type: 'findSkills', query: 'testing' }));
    let searchAborted = false;
    const search: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('missing search cancellation')), 1000);
      init!.signal!.addEventListener('abort', () => { searchAborted = true; clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    });
    await new WorkRunner(h.engine, adapter, () => h.now, search).runOne(h.room, h.task);
    expect(searchAborted).toBe(true); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().usage.ordinary).toBe(2);
  });

  it('rejects invalid references, URLs and request overrides in configuration', () => {
    for (const mutate of [
      (c: TeamConfig) => { c.bots[0]!.model = 'missing'; },
      (c: TeamConfig) => { c.models!.services.main!.baseUrl = 'https://user:password@provider.example/v1'; },
      (c: TeamConfig) => { c.models!.services.main!.extraBody = { messages: [] }; },
      (c: TeamConfig) => { c.models!.services.main!.maxTokens = -1; },
    ]) { const c = modelConfig(); mutate(c); expect(() => validateConfig(c)).toThrow(); }
  });

  it('executes the full multi-model collaboration over real local HTTP', async () => {
    const received: { path?: string; auth?: string; body: Record<string, unknown> }[] = [];
    const replies = [
      { type: 'help', target: 'B', question: 'verify source', expected: 'evidence' },
      { type: 'answer', text: 'verified evidence' },
      { type: 'deliver', text: 'final plan', artifactIds: [] },
      { type: 'check', passed: true, gaps: [] },
    ];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(replies[received.length - 1]) } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
      const c = modelConfig(); for (const service of Object.values(c.models!.services)) service.baseUrl = `http://127.0.0.1:${address.port}/custom/v1`;
      const h = new Harness(c);
      const runner = new WorkRunner(h.engine, new OpenAICompatibleAdapter(c, { env: { TEST_MODEL_KEY: 'local-test-secret' }, clock: () => 0 }), () => 0);
      for (let i = 0; i < 10 && await runner.runOne(h.room, h.task); i++) { /* finite host drive */ }
      expect(h.context().outcome).toBe('complete');
      expect(received.map(r => r.body.model)).toEqual(['main-model', 'fast-model', 'main-model', 'review-model']);
      expect(received.every(r => r.path === '/custom/v1/chat/completions')).toBe(true);
      expect(received[0]?.auth).toBe('Bearer local-test-secret'); expect(received[1]?.auth).toBeUndefined();
      expect(h.context().usage).toMatchObject({ ordinary: 3, checks: 1, assists: 1 });
      expect(h.context().messages.filter(m => m.kind === 'final')).toHaveLength(1);
    } finally {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 10000);
});
