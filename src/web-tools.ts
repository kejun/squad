import { createHTTPWebSearch, renderWebSearchResults, WebSearchError, type WebSearchToolInput, type WebSearchToolOutput, type WebSearchProvider } from 'agents/websearch';
import { fetchWeb, windowWebFetchPage, renderWebFetchPage, WebFetchError, type DirectWebFetchOptions, type WebFetchToolInput, type WebFetchToolOutput } from 'agents/webfetch';
import { WorkFailure } from './runner.js';
import { readModelEnv, type ModelEnvironment } from './model-env.js';

export type { WebSearchToolInput, WebSearchToolOutput, WebFetchToolInput, WebFetchToolOutput };
export interface WebToolResult<T> { output: T; text: string }
export interface WebTools {
  search(input: WebSearchToolInput, signal: AbortSignal): Promise<WebToolResult<WebSearchToolOutput>>;
  fetch(input: WebFetchToolInput, signal: AbortSignal): Promise<WebToolResult<WebFetchToolOutput>>;
}
export interface CloudflareWebToolsOptions {
  env?: Record<string, string | undefined>;
  transport?: typeof fetch;
  timeoutMs?: number;
  pageChars?: number;
  maxBytes?: number;
  allowedHosts?: string[];
}
export function validWebSearchInput(input: unknown): input is WebSearchToolInput {
  if (!input || typeof input !== 'object') return false;
  const { query, limit } = input as WebSearchToolInput;
  return typeof query === 'string' && query.trim().length > 0 && query.trim().length <= 1024
    && (limit === undefined || (Number.isSafeInteger(limit) && limit > 0));
}
export function validWebFetchInput(input: unknown): input is WebFetchToolInput {
  if (!input || typeof input !== 'object') return false;
  const { url, offset, format } = input as WebFetchToolInput;
  return typeof url === 'string' && url.trim().length > 0 && url.trim().length <= 2000
    && (offset === undefined || (Number.isSafeInteger(offset) && offset >= 0))
    && (format === undefined || format === 'auto' || format === 'raw');
}

/** Node host for the SDK's public sources. No Worker deployment or model-provider change is required. */
export class CloudflareWebTools implements WebTools {
  private readonly timeoutMs: number;
  private readonly pageChars: number;
  private readonly maxBytes: number;
  constructor(private readonly options: CloudflareWebToolsOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pageChars = options.pageChars ?? 20_000;
    this.maxBytes = options.maxBytes ?? 5_000_000;
    for (const value of [this.timeoutMs, this.pageChars, this.maxBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid web tool limit');
    }
  }
  private get transport() { return this.options.transport ?? globalThis.fetch; }
  private credentials(env: ModelEnvironment) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
    if (!accountId || !apiToken) throw new WorkFailure('WEB_TOOLS_NOT_CONFIGURED: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env');
    if (!/^[a-f0-9]{32}$/i.test(accountId) || /\s/.test(apiToken)) throw new WorkFailure('INVALID_CLOUDFLARE_CREDENTIALS');
    return { accountId, apiToken };
  }
  private async run<T>(operation: 'web_search' | 'web_fetch', signal: AbortSignal, action: (signal: AbortSignal, env: ModelEnvironment) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener('abort', onAbort, { once: true });
    });
    let env: ModelEnvironment = {};
    try {
      try { env = this.options.env ? { ...this.options.env } : readModelEnv(); }
      catch { throw new WorkFailure('WEB_TOOLS_ENV_UNAVAILABLE'); }
      const value = await Promise.race([action(combined, env), cancelled]);
      combined.throwIfAborted();
      return value;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (deadline.aborted) throw new WorkFailure(`${operation}_timeout`, true);
      if (error instanceof WorkFailure) throw error;
      // The SDK retains raw provider bodies in errors. Persist only a short, sanitized code.
      if (error instanceof WebSearchError || error instanceof WebFetchError) {
        if (error.cause instanceof WorkFailure) throw error.cause;
        const token = env.CLOUDFLARE_API_TOKEN?.trim();
        const code = /^(?:web_(?:search|fetch)_[a-z_]+|invalid_web_(?:search|fetch)_input)$/.test(error.code)
          && error.code.length <= 80 && !(token && error.code.includes(token)) ? error.code : `${operation}_failed`;
        throw new WorkFailure(`${code} (HTTP ${error.status})`, error.retryable);
      }
      throw new WorkFailure(`${operation}_unavailable`, true);
    } finally { combined.removeEventListener('abort', onAbort); }
  }
  async search(input: WebSearchToolInput, signal: AbortSignal): Promise<WebToolResult<WebSearchToolOutput>> {
    if (!validWebSearchInput(input)) throw new WorkFailure('invalid_web_search_input');
    return this.run('web_search', signal, async (requestSignal, env) => {
      const provider = env.CLOUDFLARE_WEB_SEARCH_PROVIDER?.trim() || undefined;
      const gateway = env.CLOUDFLARE_AI_GATEWAY_ID?.trim() || undefined;
      const byokAlias = env.CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS?.trim() || undefined;
      if (provider && !['ceramic', 'exa', 'linkup'].includes(provider)) throw new WorkFailure('INVALID_CLOUDFLARE_WEB_SEARCH_PROVIDER');
      if (byokAlias && !/^[A-Za-z0-9_-]{1,64}$/.test(byokAlias)) throw new WorkFailure('INVALID_CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS');
      const source = createHTTPWebSearch({ ...this.credentials(env),
        ...(provider ? { provider: provider as WebSearchProvider } : {}), ...(gateway ? { gateway } : {}), ...(byokAlias ? { byokAlias } : {}),
        fetch: (url, init) => this.transport(url, { ...init, redirect: 'error' }),
      });
      const limit = Math.min(input.limit ?? 5, 5);
      const response = await source.search({ query: input.query.trim(), limit }, { signal: requestSignal });
      const output: WebSearchToolOutput = { ...response, items: response.items.slice(0, limit), ...(source.provider ? { provider: source.provider } : {}) };
      return { output, text: renderWebSearchResults(output, { maxDescriptionChars: 600 }) };
    });
  }
  async fetch(input: WebFetchToolInput, signal: AbortSignal): Promise<WebToolResult<WebFetchToolOutput>> {
    if (!validWebFetchInput(input)) throw new WorkFailure('invalid_web_fetch_input');
    return this.run('web_fetch', signal, async (requestSignal, env) => {
      // fetchWeb only uses binding.toMarkdown. Bridge that method to the documented REST API.
      // Markdown, JSON, raw and plain-text responses do not invoke it and need no credentials.
      const binding = { toMarkdown: async (file: { name: string; blob: Blob }) => {
        const { accountId, apiToken } = this.credentials(env);
        const body = new FormData(); body.append('files', file.blob, file.name);
        const response = await this.transport(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/tomarkdown`, {
          method: 'POST', signal: requestSignal, redirect: 'error', headers: { authorization: `Bearer ${apiToken}` }, body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new WorkFailure(`web_fetch_conversion_failed (HTTP ${response.status})`, response.status === 429 || response.status >= 500);
        }
        const data = await response.json() as { success?: boolean; result?: { format?: string; data?: string }[] };
        const converted = data?.result?.[0];
        if (data?.success !== true || converted?.format !== 'markdown' || typeof converted.data !== 'string') throw new WorkFailure('web_fetch_conversion_failed');
        return { format: 'markdown', data: converted.data };
      } } as DirectWebFetchOptions['binding'];
      const page = await fetchWeb({ url: input.url, ...(input.format ? { format: input.format } : {}) }, {
        binding, fetch: (url, init) => this.transport(url, init), signal: requestSignal,
        timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, maxRedirects: 5,
        ...(this.options.allowedHosts ? { allowedHosts: this.options.allowedHosts } : {}),
      });
      const output = windowWebFetchPage(page, { offset: input.offset ?? 0, pageChars: this.pageChars });
      return { output, text: renderWebFetchPage(output) };
    });
  }
}
