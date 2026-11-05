import type { SkillPage } from './local-skills.js';

export interface HostCapabilitySource {
  platform: string;
  arch: string;
  runtimeVersion: string;
  sandbox: { available: boolean; reason?: string };
  skills: SkillPage;
  /** Resolve only; must not launch the command or read account credentials. */
  locate(command: string, execution: 'sandbox' | 'host'): Promise<boolean>;
}

/** Metadata is an observation, not authority or a promise that a later execution will succeed. */
export async function discoverHostCapabilities(source: HostCapabilitySource, commands: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const cli = [];
  for (const command of [...new Set(commands)]) {
    signal.throwIfAborted();
    const sandbox = await source.locate(command, 'sandbox');
    signal.throwIfAborted();
    const host = await source.locate(command, 'host');
    cli.push({ command, sandbox: sandbox ? 'found' : 'not_found', host: host ? 'found' : 'not_found' });
  }
  signal.throwIfAborted();
  return {
    platform: source.platform, arch: source.arch, runtime: { name: 'node', version: source.runtimeVersion },
    skills: source.skills,
    cli: { queriedOnly: true, commands: cli, sandbox: source.sandbox, hostApprovalRequired: true,
      presenceIsNotExecution: true, network: 'sandbox_denied_by_default' },
    mcp: { status: 'not_connected', scope: 'this_service', reason: 'No native MCP transport is configured in this service. A skill may document a separately installed CLI client; discover and use it through the existing CLI interface only.' },
  };
}
