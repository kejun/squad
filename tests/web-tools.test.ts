import { describe, expect, it } from 'vitest';
import { CloudflareWebTools, WorkFailure, WorkRunner, validateConfig } from '../src/index.js';
import { createTeamConfig } from '../team.config.js';
import { Harness, configuration } from './helpers.js';
import { scriptedModel, sourceUrl, webEnv, webFixture, webModelConfig, answer } from './web-tools-fixture.js';

const signal = () => new AbortController().signal;
describe('Cloudflare SDK web tools', () => {
  it('[BT_W01] executes the real SDK search/fetch protocol in the model loop', async () => {
    const config = webModelConfig(); const h = new Harness(config); const fake = webFixture(); const model = scriptedModel(config);
    await new WorkRunner(h.engine, model.adapter, () => h.now, undefined, fake.tools).runOne(h.room, h.task);
    expect(h.context().usage.ordinary).toBe(5); expect(h.context().candidate?.text).toContain(sourceUrl);
    expect(JSON.parse(String(fake.calls[0]!.init!.body))).toEqual({ query: 'SDK', limit: 5, provider: 'exa', options: { gateway: { id: 'squad' } } });
    expect(fake.calls[0]!.init!.redirect).toBe('error');
    expect(new Headers(fake.calls[0]!.init!.headers).get('authorization')).toBe(`Bearer ${webEnv.CLOUDFLARE_API_TOKEN}`);
    expect(new Headers(fake.calls[1]!.init!.headers).has('authorization')).toBe(false);
    expect(new Headers(fake.calls[1]!.init!.headers).get('accept')).toContain('text/markdown');
    expect(JSON.stringify(model.requests)).not.toContain(webEnv.CLOUDFLARE_API_TOKEN);
  });

  it('[BT_W01] caps search results and snippets while preserving host metadata', async () => {
    const f = webFixture(); f.state.searchItems = Array.from({ length: 9 }, () => ({ url: sourceUrl, title: 'Source', description: 'Long source '.repeat(1000) }));
    const result = await f.tools.search({ query: 'SDK', limit: 99 }, signal());
    expect(result.output.items).toHaveLength(5); expect(result.text.length).toBeLessThan(4000);
    expect(result.output.items[0]!.description!.length).toBeGreaterThan(600);
    expect(result.output.metadata.requestId).toBe('search-1'); expect(result.output.provider).toBe('exa');
  });

  it('[BT_W03] uses the documented multipart conversion API without sending credentials to the page', async () => {
    const f = webFixture(); f.state.type = 'application/pdf'; f.state.content = '%PDF fixture';
    const result = await f.tools.fetch({ url: sourceUrl }, signal());
    const conversion = f.calls[1]!; const file = (conversion.init!.body as FormData).get('files') as File;
    expect(conversion.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${webEnv.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`);
    expect(conversion.init!.redirect).toBe('error'); expect(file.name).toBe('document.pdf'); expect(file.type).toBe('application/pdf');
    expect(await file.text()).toBe('%PDF fixture'); expect(result.output.via).toBe('converted');
    expect(result.text).toContain('<untrusted_web_content>');
  });

  it('[BT_W03] allows credential-free text and raw HTML but reports missing conversion credentials', async () => {
    const f = webFixture({ env: {} });
    expect((await f.tools.fetch({ url: sourceUrl }, signal())).output.via).toBe('markdown-negotiated');
    f.state.type = 'text/html'; f.state.content = '<p>raw</p>';
    expect((await f.tools.fetch({ url: sourceUrl, format: 'raw' }, signal())).output.content).toBe('<p>raw</p>');
    await expect(f.tools.fetch({ url: sourceUrl }, signal())).rejects.toThrow('WEB_TOOLS_NOT_CONFIGURED');
    expect(f.calls.every(call => call.url === sourceUrl)).toBe(true);
  });

  it('[BT_W03] enforces response bytes and keeps HTTP error statuses visible', async () => {
    const f = webFixture({ maxBytes: 50 }); f.state.content = 'x'.repeat(51);
    await expect(f.tools.fetch({ url: sourceUrl }, signal())).rejects.toThrow('web_fetch_too_large');
    f.state.content = 'not found'; f.state.status = 404;
    const result = await f.tools.fetch({ url: sourceUrl }, signal());
    expect(result.output.status).toBe(404); expect(result.text).toContain('404'); expect(result.output.content).toBe('not found');
  });

  it.each(['http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/', 'https://host.internal/'])(
    '[BT_W04] rejects private destination %s before transport', async url => {
      const f = webFixture(); await expect(f.tools.fetch({ url }, signal())).rejects.toThrow('web_fetch_disallowed_url'); expect(f.calls).toHaveLength(0);
    });
  it('[BT_W04] applies host restrictions and rejects HTTPS downgrades', async () => {
    const f = webFixture(); const restricted = new CloudflareWebTools({ transport: f.transport, allowedHosts: ['docs.example'] });
    await expect(restricted.fetch({ url: sourceUrl }, signal())).rejects.toThrow('web_fetch_disallowed_url');
    expect(f.calls).toHaveLength(0); f.state.redirect = 'http://public.example/';
    await expect(f.tools.fetch({ url: sourceUrl }, signal())).rejects.toThrow('web_fetch_disallowed_redirect');
    expect(f.calls).toHaveLength(1);
  });

  it('[BT_W05] distinguishes a valid empty search from malformed provider output', async () => {
    const f = webFixture(); f.state.searchItems = [];
    expect((await f.tools.search({ query: 'SDK' }, signal())).output.items).toEqual([]);
    f.state.custom = async () => Response.json({ message: webEnv.CLOUDFLARE_API_TOKEN });
    await expect(f.tools.search({ query: 'SDK' }, signal())).rejects.toThrow('web_search_unavailable');
  });
  it('[BT_W05] bounds automatic transient retries through the existing task budget', async () => {
    const h = new Harness(configuration({ retries: 1 })); const f = webFixture(); f.state.searchStatus = 503;
    const runner = new WorkRunner(h.engine, { execute: async (_work, sig, scope) => { await scope.webSearch({ query: 'SDK' }, sig); return answer; } }, () => 0, undefined, f.tools);
    for (let n = 0; n < 10 && await runner.runOne(h.room, h.task); n++);
    expect(f.calls).toHaveLength(2); expect(h.context().usage.ordinary).toBe(4);
    expect(h.context().usage.retries).toBe(1); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().candidate).toBeNull(); expect(JSON.stringify(h.context())).not.toContain(webEnv.CLOUDFLARE_API_TOKEN);
  });
  it.each([401, 429, 500])('[BT_W05] sanitizes conversion failure HTTP %s', async status => {
    const f = webFixture(); f.state.custom = async url => String(url).endsWith('/ai/tomarkdown')
      ? new Response(webEnv.CLOUDFLARE_API_TOKEN, { status }) : new Response('<h1>test</h1>', { headers: { 'content-type': 'text/html' } });
    const error = await f.tools.fetch({ url: sourceUrl }, signal()).catch(e => e as WorkFailure);
    expect(error).toBeInstanceOf(WorkFailure); expect(error.message).toBe(`web_fetch_conversion_failed (HTTP ${status})`);
    expect(error.transient).toBe(status !== 401); expect(String(error)).not.toContain(webEnv.CLOUDFLARE_API_TOKEN);
  });
  it('[BT_W06] cancellation during conversion reaches the actual REST request', async () => {
    const f = webFixture(); let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
    const controller = new AbortController(); let aborted = false;
    f.state.custom = async (url, init) => String(url).endsWith('/ai/tomarkdown') ? new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true }); started();
    }) : new Response('<p>convert</p>', { headers: { 'content-type': 'text/html' } });
    const result = f.tools.fetch({ url: sourceUrl }, controller.signal);
    await start; controller.abort(); await expect(result).rejects.toThrow(); expect(aborted).toBe(true);
  });
  it('[BT_W06] pre-aborted calls make no HTTP request', async () => {
    const f = webFixture(); const controller = new AbortController(); controller.abort();
    await expect(f.tools.search({ query: 'SDK' }, controller.signal)).rejects.toThrow();
    await expect(f.tools.fetch({ url: sourceUrl }, controller.signal)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });

  it('[BT_W02] validates model tool arguments before charging or executing', async () => {
    for (const output of [{ type: 'web_search', query: ' ' }, { type: 'web_search', query: 'a', limit: -1 }, { type: 'web_fetch', url: sourceUrl, offset: -1 }, { type: 'web_fetch', url: sourceUrl, format: 'browser' }]) {
      const h = new Harness(webModelConfig()); const f = webFixture(); const model = scriptedModel(h.config, [output]);
      await new WorkRunner(h.engine, model.adapter, () => 0, undefined, f.tools).runOne(h.room, h.task);
      expect(f.calls).toHaveLength(0); expect(h.context().usage.ordinary).toBe(1); expect(h.view().phase).toBe('waitingHuman');
    }
  });
  it('[BT_W09] default capabilities and dotenv switch never persist credentials', () => {
    const config = createTeamConfig(webEnv); expect(config.webTools).toEqual({ enabled: true });
    expect(JSON.stringify(config)).not.toContain(webEnv.CLOUDFLARE_API_TOKEN);
    expect(createTeamConfig({ ...webEnv, SQUAD_WEB_TOOLS_ENABLED: 'false' }).webTools).toEqual({ enabled: false });
    expect(() => createTeamConfig({ SQUAD_WEB_TOOLS_ENABLED: 'perhaps' })).toThrow();
    expect(() => validateConfig({ ...config, webTools: { enabled: 'true' as unknown as boolean } })).toThrow('Invalid web tools configuration');
    delete config.webTools; const h = new Harness(config);
    expect(h.engine.pending(h.room, h.task)[0]!.payload.capabilities).toMatchObject({ webSearch: true, webFetch: true });
  });
});
