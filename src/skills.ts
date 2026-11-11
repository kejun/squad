/** Read-only discovery through the same endpoint used by vercel-labs/skills. */
export interface FoundSkill { id: string; name: string; source: string; installs: number; url: string }
export type SkillSearchTransport = typeof fetch;
export class SkillSearchFailure extends Error {
  constructor(readonly code: string, readonly transient: boolean, message = code) { super(message); }
}
const repositorySource = /^[\w.-]+\/[\w.-]+$/;
// The public registry also indexes skills hosted directly on a domain.
const domainSource = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export async function findSkills(query: string, signal: AbortSignal, transport: SkillSearchTransport = globalThis.fetch): Promise<FoundSkill[]> {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Skill search requires a query');
  signal.throwIfAborted();
  const url = new URL('https://skills.sh/api/search');
  url.search = new URLSearchParams({ q: query.trim(), limit: '20' }).toString();
  let response: Response;
  try { response = await transport(url, { signal }); }
  catch {
    signal.throwIfAborted();
    throw new SkillSearchFailure('SKILL_SEARCH_UNAVAILABLE', true);
  }
  signal.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel();
    throw new SkillSearchFailure(`SKILL_SEARCH_HTTP_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500,
      `Skill search HTTP ${response.status}`);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { signal.throwIfAborted(); throw new SkillSearchFailure('SKILL_SEARCH_INVALID_RESPONSE', false); }
  signal.throwIfAborted();
  if (!data || typeof data !== 'object' || !('skills' in data) || !Array.isArray(data.skills)) throw new Error('Invalid skill search response');
  return data.skills.slice(0, 20).map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid skill search result');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || !item.name.trim() || typeof item.source !== 'string' || !(repositorySource.test(item.source) || domainSource.test(item.source))
      || typeof item.installs !== 'number' || !Number.isSafeInteger(item.installs) || item.installs < 0) throw new Error('Invalid skill search result');
    return { id: item.id, name: item.name, source: item.source, installs: item.installs,
      url: `https://skills.sh/${item.source}/${encodeURIComponent(item.id.split('/').at(-1)!)}` };
  }).sort((a, b) => b.installs - a.installs);
}
