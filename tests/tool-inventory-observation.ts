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
  const inventory = observations.find(observation => observation.type === 'tool_inventory') as InventoryObservation | undefined;
  assert(inventory, 'Every authorized model decision must receive the complete unified tool inventory');
  assert.equal(inventory.metadataOnly, true); assert.equal(inventory.executionAuthority, false);
  assert.equal(inventory.schemaVersion, 1); assert.equal(inventory.untrusted, true);
  return inventory;
}

