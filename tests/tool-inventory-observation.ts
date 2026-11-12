import assert from 'node:assert/strict';
import type { CliCatalogEntry } from '../src/cli-catalog.js';
import type { LocalFixture } from './local-tools-fixture.js';

export interface InventoryReadiness {
  installation: string; authentication: string; authorization: string; network: string;
  observedAt: number | null; sourceOperationIds: string[];
}
export interface InventoryObservation {
  type: 'tool_inventory'; untrusted: true; schemaVersion: 1; catalogVersion: string; observedAt: number;
  metadataOnly: true; executionAuthority: false;
  cli: { configuration: { state: string; entryCount: number; source?: 'automatic' | 'configured' }; catalogVersion: string;
    entries: (CliCatalogEntry & { toolId: string; entryVersion: string;
      variants: { execution: 'sandbox' | 'host'; approvalRequired: boolean; readiness: InventoryReadiness }[] })[] };
  skills: { catalogVersion: string; complete: boolean; skills: { name: string; skillId: string; skillVersion: string }[];
    diagnostics: { code: string }[] };
  environment: { sandbox: { available: boolean }; host: { approvalRequired: true } };
  refresh: { status: 'current' | 'failed'; checkedAt: number; error?: string };
  interfaces: { type: string }[];
}
export function inventoryObservation(request: LocalFixture['requests'][number]): InventoryObservation {
  const observations = request.messages.filter(message => message.role === 'user' && message.content.startsWith('{'))
    .map(message => JSON.parse(message.content) as { type?: string });
  let inventory = observations.find(observation => observation.type === 'tool_inventory') as InventoryObservation | undefined;
  assert(inventory, 'Every authorized model decision must receive the complete unified tool inventory');
  // Decode the documented model wire protocol independently of its producer.
  const encoded = inventory.cli as unknown as { encoding?: string; usageGroups: Record<string, unknown>[];
    variantDefaults: Record<string, Record<string, unknown>>; entries: Record<string, unknown>[] };
  if (encoded.encoding) {
    assert.equal(encoded.encoding, 'shared_cli_metadata_v1');
    const inherit = (base: Record<string, unknown> = {}, own: Record<string, unknown>): Record<string, unknown> => {
      const result = { ...base };
      for (const [key, value] of Object.entries(own)) result[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? inherit(base[key] as Record<string, unknown>, value as Record<string, unknown>) : value;
      return result;
    };
    inventory = { ...inventory, cli: { ...inventory.cli, entries: encoded.entries.map(entry => {
      const { usageRef, variants, ...own } = entry;
      assert(Number.isSafeInteger(usageRef) && encoded.usageGroups[usageRef as number]);
      return { ...inherit(encoded.usageGroups[usageRef as number], own),
        variants: (variants as Record<string, unknown>[]).map(variant => inherit(encoded.variantDefaults[String(variant.execution)], variant)) };
    }) as InventoryObservation['cli']['entries'] } };
  }

  assert.equal(inventory.metadataOnly, true); assert.equal(inventory.executionAuthority, false);
  assert.equal(inventory.schemaVersion, 1); assert.equal(inventory.untrusted, true);
  return inventory;
}

