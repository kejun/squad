import { describe, expect, it, vi } from 'vitest';
import { findSkills, WorkRunner, TeamEngine } from '../src/index.js';
import { configuration, Harness } from './helpers.js';

const result = { id: 'owner/repo/review', name: 'review', source: 'owner/repo', installs: 1200 };
const transport = () => vi.fn<typeof fetch>(async () => Response.json({ skills: [result] }));

describe('default find skills capability', () => {
  it('exposes discovery to owners, helpers and facilitators, including new members', () => {
    const c = configuration(); c.bots.push({ id: 'C', name: 'C', instructions: '', tools: [] });
    const h = new Harness(c);
    expect(h.engine.pending(h.room, h.task)[0]?.payload.capabilities).toEqual({ findSkills: true });
    h.help(); expect(h.engine.pending(h.room, h.task)[0]?.payload.capabilities).toEqual({ findSkills: true });
    h.result(); h.event({ type: 'BLOCKED', reason: 'missing skill' });
    expect(h.engine.pending(h.room, h.task)[0]?.payload.capabilities).toEqual({ findSkills: true });
    h.engine.submit('other', { id: 'C1', text: 'find a skill', mentions: ['C'] });
    expect(h.engine.pending('other', 'task:C1')[0]?.payload.capabilities).toEqual({ findSkills: true });
  });

  it('executes skill discovery through the driver and charges each search', async () => {
    const h = new Harness(); const http = transport();
    const runner = new WorkRunner(h.engine, { async execute(_work, _signal, scope) {
      const results = await scope.findSkills('react testing');
      return { type: 'answer', text: results[0]!.url };
    } }, () => 0, http);
    await runner.runOne(h.room, h.task);
    expect(http).toHaveBeenCalledTimes(1);
    expect(new URL(String(http.mock.calls[0]![0])).searchParams.get('q')).toBe('react testing');
    expect(h.context().usage.ordinary).toBe(2);
    expect(h.context().candidate?.text).toBe('https://skills.sh/owner/repo/review');
    expect(h.view().phase).toBe('checking');
  });

  it('refuses the search before HTTP when execution budget is exhausted', async () => {
    const h = new Harness(configuration({ ordinary: 1 })); const http = transport();
    const runner = new WorkRunner(h.engine, { async execute(_work, _signal, scope) {
      await scope.findSkills('review'); return { type: 'answer', text: 'unreachable' };
    } }, () => 0, http);
    await runner.runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.context().usage.ordinary).toBe(1);
    expect(h.view().phase).toBe('waitingHuman');
  });

  it('allows disabling discovery through configuration', async () => {
    const c = configuration(); c.skillSearch = { enabled: false };
    const h = new Harness(c); const http = transport();
    expect(h.engine.pending(h.room, h.task)[0]?.payload.capabilities).toEqual({ findSkills: false });
    const runner = new WorkRunner(h.engine, { async execute(_work, _signal, scope) {
      await scope.findSkills('review'); return { type: 'answer', text: 'unreachable' };
    } }, () => 0, http);
    await runner.runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.context().reason).toContain('SKILL_SEARCH_DISABLED');
  });

  it('does not issue search requests after stop', async () => {
    const h = new Harness(); const http = transport();
    const runner = new WorkRunner(h.engine, { async execute(_work, _signal, scope) {
      h.event({ type: 'STOP' });
      await scope.findSkills('review'); return { type: 'answer', text: 'unreachable' };
    } }, () => 0, http);
    await runner.runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled(); expect(h.context().usage.ordinary).toBe(1);
    expect(h.context().outcome).toBe('stopped');
  });

  it('uses current configuration when discovery is revoked on recovery', async () => {
    const h = new Harness(); const c = configuration(); c.skillSearch = { enabled: false };
    const engine = new TeamEngine(h.store, c, () => 0); engine.recover(h.room);
    const http = transport();
    const runner = new WorkRunner(engine, { async execute(_work, _signal, scope) {
      await scope.findSkills('review'); return { type: 'answer', text: 'unreachable' };
    } }, () => 0, http);
    await runner.runOne(h.room, h.task);
    expect(http).not.toHaveBeenCalled();
  });

  it('distinguishes failed searches from valid empty results', async () => {
    const signal = new AbortController().signal;
    await expect(findSkills('review', signal, async () => Response.json({ skills: [] }))).resolves.toEqual([]);
    await expect(findSkills('review', signal, async () => new Response('', { status: 503 }))).rejects.toThrow('503');
    await expect(findSkills('review', signal, async () => Response.json({ skills: [{}] }))).rejects.toThrow('Invalid skill search result');
    const http = transport();
    await expect(findSkills(' ', signal, http)).rejects.toThrow('requires a query');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(findSkills('review', cancelled.signal, http)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
});
