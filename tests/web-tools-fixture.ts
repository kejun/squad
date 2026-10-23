import { CloudflareWebTools, OpenAICompatibleAdapter, type WorkOutput } from '../src/index.js';
import { configuration } from './helpers.js';

export const webEnv = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'cloudflare-test-secret', CLOUDFLARE_WEB_SEARCH_PROVIDER: 'exa', CLOUDFLARE_AI_GATEWAY_ID: 'squad' };
export const sourceUrl = 'https://evidence.example/report';
export function webFixture(options: { timeoutMs?: number; pageChars?: number; maxBytes?: number; env?: Record<string, string | undefined> } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const state = { type: 'text/markdown', content: '# Evidence\nSupported by the source.', converted: '# Converted evidence', status: 200,
    searchStatus: 200, redirect: '', errorCode: 'web_search_unauthorized', aborted: false,
    searchItems: [{ url: sourceUrl, title: 'Evidence', description: 'Read this report.' }],
    wait: false, notify: () => {}, custom: undefined as typeof fetch | undefined };
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (state.custom) return state.custom(url, init);
    if (state.wait) return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      const abort = () => { state.aborted = true; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      state.notify();
    });
    if (String(url).endsWith('/ai/websearch/')) {
      if (state.searchStatus !== 200) return Response.json({ error: { code: state.errorCode, message: `raw-provider-echo ${webEnv.CLOUDFLARE_API_TOKEN}` } }, { status: state.searchStatus });
      return Response.json({ items: state.searchItems, metadata: { query: 'SDK', requestId: 'search-1', latencyMs: 5 } });
    }
    if (String(url).endsWith('/ai/tomarkdown')) return Response.json({ success: true, result: [{ format: 'markdown', data: state.converted }] });
    if (state.redirect) return new Response(null, { status: 302, headers: { location: state.redirect } });
    return new Response(state.content, { status: state.status, headers: { 'content-type': state.type } });
  };
  return { state, calls, transport, tools: new CloudflareWebTools({ ...options, env: options.env ?? webEnv, transport }) };
}
export function webModelConfig() {
  const config = configuration();
  config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'test' } } };
  return config;
}
export function scriptedModel(config = webModelConfig(), outputs: unknown[] = [
  { type: 'web_search', query: 'SDK', limit: 99 },
  { type: 'web_fetch', url: sourceUrl },
  { type: 'answer', text: `依据 ${sourceUrl}` },
]) {
  const requests: { messages: { role: string; content: string }[]; model: string }[] = [];
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => 0, transport: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const output = outputs.shift();
    if (!output) throw new Error('Scripted model exhausted');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
  } });
  return { adapter, requests };
}
export const answer: WorkOutput = { type: 'answer', text: '联网工作已完成' };
