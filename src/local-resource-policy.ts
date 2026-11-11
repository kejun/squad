/** Pure host resource contract. Model output cannot declare actual backend confinement. */
export interface ResourceLease {
  key: string; mode: 'read' | 'write'; phase: 'prepare' | 'execute';
}
export interface LocalResourcePolicyInput {
  workspaceId: string;
  copyId?: string;
  isolatedWork: boolean;
  execution: 'sandbox' | 'host';
  sandboxConfinesWorkspace: boolean;
  action: 'runCli' | 'verifyWorkspace';
  sharedResources?: { key: string; mode: 'read' | 'write' }[];
}
export interface LocalResourcePolicy {
  conflictKey: string;
  preparationKey?: string;
  resourceLeases: ResourceLease[];
}
export const unconfinedEffectsKey = 'squad:unconfined-external-effects';

/** Same-key reads coexist; a write conflicts regardless of preparation/execution phase. */
export function localResourceLeasesConflict(left: readonly ResourceLease[], right: readonly ResourceLease[]): boolean {
  return left.some(a => right.some(b => a.key === b.key && (a.mode === 'write' || b.mode === 'write')));
}

function compactLeases(leases: ResourceLease[]): ResourceLease[] {
  const byKey = new Map<string, ResourceLease>();
  for (const lease of leases) {
    const identity = JSON.stringify([lease.key, lease.phase]), existing = byKey.get(identity);
    if (!existing) byKey.set(identity, { ...lease });
    else byKey.set(identity, { key: lease.key,
      mode: existing.mode === 'write' || lease.mode === 'write' ? 'write' : 'read', phase: lease.phase });
  }
  return [...byKey.values()];
}

export function resolveLocalResourcePolicy(input: LocalResourcePolicyInput): LocalResourcePolicy {
  const actualCopy = input.execution === 'sandbox' && input.sandboxConfinesWorkspace && input.isolatedWork
    && !!input.copyId && input.copyId !== input.workspaceId;
  let leases: ResourceLease[];
  if (input.action === 'verifyWorkspace') {
    leases = [{ key: unconfinedEffectsKey, mode: 'read', phase: 'execute' },
      { key: input.workspaceId, mode: 'read', phase: 'execute' },
      ...(input.copyId ? [{ key: input.copyId, mode: 'read' as const, phase: 'execute' as const }] : [])];
  } else if (actualCopy) {
    leases = [{ key: unconfinedEffectsKey, mode: 'read', phase: 'execute' },
      { key: input.workspaceId, mode: 'read', phase: 'prepare' },
      { key: input.copyId!, mode: 'write', phase: 'execute' }];
  } else {
    leases = [{ key: input.workspaceId, mode: 'write', phase: 'execute' },
      { key: unconfinedEffectsKey, mode: !input.sandboxConfinesWorkspace || input.execution === 'host' ? 'write' : 'read', phase: 'execute' }];
  }
  leases.push(...(input.sharedResources ?? []).map(resource => ({ ...resource, phase: 'execute' as const })));
  return { conflictKey: actualCopy && input.action === 'runCli' ? input.copyId! : input.workspaceId,
    ...(actualCopy && input.action === 'runCli' ? { preparationKey: input.workspaceId } : {}),
    resourceLeases: compactLeases(leases) };
}

/** Only a trusted LOCAL_PREPARED receipt may use this projection to release preparation reads. */
export const localExecutionLeases = (leases: readonly ResourceLease[]) => leases.filter(lease => lease.phase === 'execute');

export interface ResourceLeaseRow extends ResourceLease { owner: string }
export interface LegacyResourceLease { key: string; owner: string }

/** Pure all-or-nothing authorization; the Store must check and insert in one transaction. */
export function canAcquireResourceLeases(rows: readonly ResourceLeaseRow[], requests: readonly ResourceLease[], owner: string,
  legacyRows: readonly LegacyResourceLease[] = []): boolean {
  return resourceLeaseBlockerOwners(rows, requests, owner, legacyRows).length === 0;
}

/** The same conflict predicate serves authorization and its read-only explanation. */
export function resourceLeaseBlockerOwners(rows: readonly ResourceLeaseRow[], requests: readonly ResourceLease[], owner: string,
  legacyRows: readonly LegacyResourceLease[] = []): string[] {
  return [...new Set([
    ...legacyRows.filter(row => row.owner !== owner
      && requests.some(request => request.key === row.key || request.key === unconfinedEffectsKey)),
    ...rows.filter(row => row.owner !== owner && localResourceLeasesConflict([row], requests)),
  ].map(row => row.owner))];
}
