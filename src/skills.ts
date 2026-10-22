/** Read-only discovery through the same endpoint used by vercel-labs/skills. */
export interface FoundSkill { id: string; name: string; source: string; installs: number; url: string }
export type SkillSearchTransport = typeof fetch;

export async function findSkills(query: string, signal: AbortSignal, transport: SkillSearchTransport = globalThis.fetch): Promise<FoundSkill[]> {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Skill search requires a query');
  signal.throwIfAborted();
  const url = new URL('https://skills.sh/api/search');
  url.search = new URLSearchParams({ q: query.trim(), limit: '20' }).toString();
  const response = await transport(url, { signal });
  if (!response.ok) throw new Error(`Skill search HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('skills' in data) || !Array.isArray(data.skills)) throw new Error('Invalid skill search response');
  return data.skills.slice(0, 20).map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid skill search result');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || typeof item.name !== 'string' || !item.name.trim() || typeof item.source !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(item.source)
      || typeof item.installs !== 'number' || !Number.isSafeInteger(item.installs) || item.installs < 0) throw new Error('Invalid skill search result');
    return { id: item.id, name: item.name, source: item.source, installs: item.installs,
      url: `https://skills.sh/${item.source}/${encodeURIComponent(item.id.split('/').at(-1)!)}` };
  }).sort((a, b) => b.installs - a.installs);
}
