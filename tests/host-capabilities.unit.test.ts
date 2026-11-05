import { describe, expect, it, vi } from 'vitest';
import { discoverHostCapabilities, type HostCapabilitySource } from '../src/host-capabilities.js';

const source = (locate: HostCapabilitySource['locate']): HostCapabilitySource => ({
  platform: 'linux', arch: 'arm64', runtimeVersion: 'v24.22.1', sandbox: { available: false, reason: 'No namespaces' },
  skills: { catalogVersion: 'catalog', skills: [], nextCursor: '20', diagnostics: [], complete: false }, locate,
});

describe('host capability metadata', () => {
  it('[BT_L56] keeps sandbox and host presence distinct without implying execution', async () => {
    const result = await discoverHostCapabilities(source(async (_name, mode) => mode === 'host'), ['tool'], new AbortController().signal);
    expect(result.cli.commands).toEqual([{ command: 'tool', sandbox: 'not_found', host: 'found' }]);
    expect(result.cli.sandbox).toEqual({ available: false, reason: 'No namespaces' });
    expect(result.cli.hostApprovalRequired).toBe(true);
    expect(result.cli.presenceIsNotExecution).toBe(true);
    expect(result.cli.queriedOnly).toBe(true);
    expect(result.mcp.status).toBe('not_connected');
    expect(result.mcp.scope).toBe('this_service');
  });

  it('[BT_L56] preserves incomplete skill metadata and pagination', async () => {
    const result = await discoverHostCapabilities(source(async () => true), [], new AbortController().signal);
    expect(result.skills.complete).toBe(false);
    expect(result.skills.nextCursor).toBe('20');
    expect(result.cli.commands).toEqual([]);
  });

  it('[BT_L56] probes a repeated command once in each execution environment', async () => {
    const locate = vi.fn(async () => true);
    const result = await discoverHostCapabilities(source(locate), ['node', 'node'], new AbortController().signal);
    expect(result.cli.commands).toEqual([{ command: 'node', sandbox: 'found', host: 'found' }]);
    expect(locate.mock.calls).toEqual([['node', 'sandbox'], ['node', 'host']]);
  });

  it('[BT_L57] does not inspect anything after an already cancelled request', async () => {
    const locate = vi.fn(async () => true);
    await expect(discoverHostCapabilities(source(locate), ['node'], AbortSignal.abort())).rejects.toThrow();
    expect(locate).not.toHaveBeenCalled();
  });

  it('[BT_L57] stops before the next environment when cancellation happens during a probe', async () => {
    const controller = new AbortController();
    const locate = vi.fn(async () => { controller.abort(); return true; });
    await expect(discoverHostCapabilities(source(locate), ['node'], controller.signal)).rejects.toThrow();
    expect(locate.mock.calls).toEqual([['node', 'sandbox']]);
  });
});
