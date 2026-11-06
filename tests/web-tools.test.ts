import { describe, expect, it } from 'vitest';
import { WorkRunner } from '../src/index.js';
import { createTeamConfig } from '../team.config.js';
import { Harness, configuration } from './helpers.js';
import { scriptedModel, sourceUrl, webEnv, webFixture, webModelConfig, answer } from './web-tools-fixture.js';

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
  it('[BT_W05] bounds automatic transient retries through the existing task budget', async () => {
    const h = new Harness(configuration({ retries: 1 })); const f = webFixture(); f.state.searchStatus = 503;
    const runner = new WorkRunner(h.engine, { execute: async (_work, sig, scope) => { await scope.webSearch({ query: 'SDK' }, sig); return answer; } }, () => 0, undefined, f.tools);
    for (let n = 0; n < 10 && await runner.runOne(h.room, h.task); n++);
    expect(f.calls).toHaveLength(2); expect(h.context().usage.ordinary).toBe(4);
    expect(h.context().usage.retries).toBe(1); expect(h.view().phase).toBe('waitingHuman');
    expect(h.context().candidate).toBeNull(); expect(JSON.stringify(h.context())).not.toContain(webEnv.CLOUDFLARE_API_TOKEN);
  });

  it('[BT_W02] [BT_M11] regenerates malformed tool arguments without executing or charging a tool call', async () => {
    for (const output of [{ type: 'web_search', query: ' ' }, { type: 'web_search', query: 'a', limit: -1 }, { type: 'web_fetch', url: sourceUrl, offset: -1 }, { type: 'web_fetch', url: sourceUrl, format: 'browser' }]) {
      const h = new Harness(webModelConfig()); const f = webFixture(); const model = scriptedModel(h.config, [output, answer]);
      await new WorkRunner(h.engine, model.adapter, () => 0, undefined, f.tools).runOne(h.room, h.task);
      expect(f.calls).toHaveLength(0); expect(model.requests).toHaveLength(2);
      expect(h.context().usage.ordinary).toBe(2); expect(h.context().usage.retries).toBe(1);
      expect(h.view().phase).toBe('checking'); expect(h.context().candidate?.text).toBe(answer.text);
    }
  });
  it('[BT_W09] default capabilities and dotenv switch never persist credentials', () => {
    const config = createTeamConfig(webEnv);
    delete config.webTools; const h = new Harness(config);
    expect(h.engine.pending(h.room, h.task)[0]!.payload.capabilities).toMatchObject({ webSearch: true, webFetch: true });
  });
});
