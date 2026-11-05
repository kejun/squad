import { describe, it, expect } from 'vitest';
import { LocalModel } from './local-model-fixture.js';

const action = { type: 'discoverHost', commands: ['node', 'missing-tool'] };
function request(m: LocalModel, selected: unknown = action) {
  return m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64),
    action: selected, parentAttempt: m.work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(selected) }], fence: m.work });
}

describe('host discovery through the persisted taskMachine', () => {
  it('[BT_L56] saves and returns metadata without workspace or execution quota', () => {
    const m = new LocalModel(i => { i.config.limits.ordinary = 1; });
    const saved = request(m);
    expect(saved.ok).toBe(true);
    expect(m.op?.status).toBe('queued');
    expect(m.claim(false).ok).toBe(true);
    expect(m.op?.status).toBe('claimed');
    expect(m.result({ result: { ok: true, code: 'discoverHost', data: { platform: 'linux', mcp: { status: 'not_connected' } } } }).ok).toBe(true);
    expect(m.op?.status).toBe('succeeded');
    expect(m.c.usage.ordinary).toBe(1);
    expect(m.op?.workspaceId).toBeUndefined();
    expect(m.c.intents[0]?.localCheckpoint?.messages.at(-1)?.content).toContain('not_connected');
  });

  it.each([
    { name: 'stopped', code: 'STOPPED', prepare: () => { const m = new LocalModel(); m.send({ type: 'STOP' }); return m; } },
    { name: 'stale goal', code: 'STALE_WORK', prepare: () => { const m = new LocalModel(); m.c.goalVersion++; return m; } },
    { name: 'disabled tools', code: 'LOCAL_TOOLS_DISABLED', prepare: () => new LocalModel(i => { i.config.localTools = { enabled: false }; }) },
    { name: 'interpretation', code: 'LOCAL_TOOLS_NOT_ALLOWED', prepare: () => { const m = new LocalModel(); m.work.kind = 'interpretation'; return m; } },
    { name: 'missing authorization', code: 'LOCAL_TOOLS_NOT_AUTHORIZED', prepare: () => { const m = new LocalModel(); delete (m.work.payload.capabilities as Record<string, unknown>).localTools; return m; } },
  ])('[BT_L57] rejects $name without creating an operation', ({ prepare, code }) => {
    const m = prepare();
    expect(request(m).code).toBe(code);
    expect(m.op).toBeUndefined();
    expect(m.c.usage.ordinary).toBe(1);
  });

  it.each([
    { commands: ['/usr/bin/node'] }, { commands: ['../node'] }, { commands: ['node --version'] },
    { commands: ['$(whoami)'] }, { commands: Array(21).fill('node') }, { commands: [''] },
    { commands: ['node'], execution: 'host' }, { commands: ['node'], approval: true },
  ])('[BT_L57] rejects invalid or authority-expanding discovery %j', payload => {
    const m = new LocalModel();
    expect(request(m, { type: 'discoverHost', ...payload }).code).toBe('INVALID_LOCAL_REQUEST');
    expect(m.op).toBeUndefined();
  });

  it('[BT_L57] settles a late read after stop without resuming work', () => {
    const m = new LocalModel();
    expect(request(m).ok).toBe(true);
    expect(m.claim().ok).toBe(true);
    m.send({ type: 'STOP' });
    expect(m.op?.status).toBe('cancelling');
    expect(m.result({ result: { ok: false, code: 'cancelled', data: {} } }).ok).toBe(true);
    expect(m.op?.status).toBe('cancelled');
    expect(m.c.candidate).toBeNull();
    expect(request(m).code).toBe('STOPPED');
  });
});
