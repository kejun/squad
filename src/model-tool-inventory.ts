import { createHash } from 'node:crypto';
import type { ToolInventoryView } from './cli-readiness.js';

interface ToolInterface {
  type: string;
  description: string;
  input: string;
  output: string;
  environment: 'service' | 'local_metadata' | 'selected';
}
interface ToolPermissions { local: boolean; search: boolean; fetch: boolean; findSkills: boolean }
const localInterfaces: ToolInterface[] = [
  { type: 'discoverHost', description: 'Inspect registered CLI metadata or resolve explicitly named commands without executing them.',
    input: '{commands?: string[], query?: string, cursor?: string}', output: 'Platform, environment observations and paginated metadata.', environment: 'local_metadata' },
  { type: 'listSkills', description: 'Inspect the local skill metadata catalog, optionally by query or page.',
    input: '{query?: string, cursor?: string}', output: 'Skill IDs, versions, descriptions, completeness and continuation cursor.', environment: 'local_metadata' },
  { type: 'loadSkill', description: 'Read and pin a local skill before following its instructions or using its resources.',
    input: '{skillId: string}', output: 'Pinned skill instructions and resource metadata.', environment: 'local_metadata' },
  { type: 'readSkillResource', description: 'Read a resource belonging to an already activated skill.',
    input: '{skillId: string, path: string, offset?: number}', output: 'A bounded resource page and continuation offset.', environment: 'local_metadata' },
  { type: 'readEvidence', description: 'Read saved execution evidence visible to this work without reacquiring the source.',
    input: '{sourceOperationId: string, stream: "stdout"|"stderr", cursor?: string}', output: 'Saved receipt content, provenance and continuation cursor.', environment: 'local_metadata' },
  { type: 'readArtifact', description: 'Read a saved report visible to this work.',
    input: '{artifactId: string, cursor?: string}', output: 'Saved artifact content, version and continuation cursor.', environment: 'local_metadata' },
  { type: 'runCli', description: 'Execute structured argv in the explicitly selected sandbox or host environment. Host execution requires approval of the concrete call; no prior sandbox failure is required.',
    input: '{executable: string, args: string[], execution: "sandbox"|"host", reason?: string, cwd?: string, timeoutMs?: number, skillId?: string}',
    output: 'A persisted operation receipt, or a pending exact host approval before any process starts.', environment: 'selected' },
];
const webInterfaces: ToolInterface[] = [
  { type: 'web_search', description: 'Search public web sources using the configured service. Provider configuration and network access are required; unknown readiness is not proof of availability.',
    input: '{query: string, limit?: number<=5}', output: 'At most five public source links and descriptions.', environment: 'service' },
  { type: 'web_fetch', description: 'Read a public HTTP(S) URL. Login and JavaScript interaction are unsupported. HTML/document conversion may require the configured conversion service.',
    input: '{url: string, offset?: number, format?: "auto"|"raw"}', output: 'Page text, continuation offset and host-verified acquisition status; HTTP success alone does not establish target acquisition.', environment: 'service' },
  { type: 'findSkills', description: 'Search public skill metadata. Searching does not install or activate a skill.',
    input: '{query: string}', output: 'Public skill references for subsequent inspection.', environment: 'service' },
];

/** Build one complete observation from already captured host metadata and current work permissions. */
export function modelToolInventory(snapshot: ToolInventoryView | undefined, permissions: ToolPermissions) {
  const interfaces = [
    ...(permissions.local ? localInterfaces : []),
    ...webInterfaces.filter(tool => tool.type === 'web_search' ? permissions.search
      : tool.type === 'web_fetch' ? permissions.fetch : permissions.findSkills),
  ];
  if (!snapshot && !interfaces.length) return undefined;
  const metadata = snapshot ?? { schemaVersion: 1 as const, metadataOnly: true as const, executionAuthority: false as const,
    catalogVersion: createHash('sha256').update(JSON.stringify(interfaces)).digest('hex') };
  return { ...metadata, interfaces, localTools: snapshot ? 'connected' as const
    : permissions.local ? 'not_configured' as const : 'not_allowed' as const };
}

/** A changed unrelated entry never invalidates this choice; unregistered explicit commands remain supported. */
export function selectedToolMetadataChanged(before: ToolInventoryView | undefined, current: ToolInventoryView | undefined, executable: string): boolean {
  const original = before?.cli.entries.find(entry => entry.command === executable);
  // Hidden observations can mean stopped, expired or revoked work; its execution guard owns that refusal.
  return !!original && !!current && original.entryVersion !== current.cli.entries.find(entry => entry.command === executable)?.entryVersion;
}
