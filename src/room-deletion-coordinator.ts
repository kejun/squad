import { randomUUID } from 'node:crypto';
import type { TeamEngine } from './engine.js';
import type { DeletionStore } from './store.js';
import { restoreRoomDeletion, deletionStatus, type DeletionIntent, type RoomDeletionEvent, type RuntimeCleanupInventory,
  type RuntimeCleanupAsset, type SavedRoomDeletion } from './room-deletion.machine.js';

export interface DeletionHost {
  prepare(roomId: string): Promise<void>;
  inventory(roomId: string, previous: SavedRoomDeletion): Promise<RuntimeCleanupInventory>;
  remove(claim: { roomId: string; deletionId: string; intentId: string; attempt: number; asset: RuntimeCleanupAsset }, signal: AbortSignal): Promise<{ assetId: string; identityVerified: true; result: 'deleted' | 'absent' }>;
  filesGone(inventory: RuntimeCleanupInventory): Promise<boolean>;
  retire(roomId: string): void;
  projectionsGone(roomId: string): boolean;
  failed(roomId: string): void;
}
const inventoryOf = (saved: SavedRoomDeletion): RuntimeCleanupInventory => ({ tasks: saved.context.tasks, sessions: saved.context.sessions,
  assets: saved.context.assets, complete: true, executionsSettled: saved.context.blockers.length === 0, blockers: saved.context.blockers });

/** Runs only committed, claimed deletion intents. The job survives outside the room being erased. */
export class RoomDeletionCoordinator {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  constructor(private readonly store: DeletionStore, private readonly engine: TeamEngine, private readonly host: DeletionHost) {}
  resume() {
    for (const saved of this.store.listDeletions()) if (!['idle', 'deleted'].includes(saved.value)) {
      this.store.stepDeletion(saved.context.roomId, { type: 'RECOVER', id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId! });
      this.kick(saved.context.roomId);
    }
  }
  tick() {
    for (const saved of this.store.listDeletions()) {
      if (['idle', 'deleted'].includes(saved.value)) continue;
      if (saved.context.nextWake !== null && saved.context.nextWake <= Date.now() && ['waiting', 'paused'].includes(saved.value))
        this.store.stepDeletion(saved.context.roomId, { type: 'TICK', id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId! });
      this.kick(saved.context.roomId);
    }
  }
  kick(roomId: string) {
    if (this.controller.signal.aborted || this.jobs.has(roomId)) return;
    const job = Promise.resolve().then(() => this.pump(roomId)).catch(() => this.host.failed(roomId)).finally(() => { this.jobs.delete(roomId); });
    this.jobs.set(roomId, job);
  }
  private event(roomId: string, intent: DeletionIntent, event: Record<string, unknown>) {
    const saved = this.store.readDeletion(roomId)!;
    return this.store.stepDeletion(roomId, { id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!, intentId: intent.id,
      attempt: intent.attempt, ...event } as RoomDeletionEvent);
  }
  private async pump(roomId: string) {
    while (!this.controller.signal.aborted) {
      let saved = this.store.readDeletion(roomId); if (!saved || ['idle', 'deleted', 'waiting', 'paused'].includes(saved.value)) return;
      const pending = saved.context.intents.find(intent => intent.status === 'pending'); if (!pending) return;
      saved = this.store.stepDeletion(roomId, { type: 'CLAIM', id: randomUUID(), at: Date.now(), deletionId: saved.context.deletionId!, intentId: pending.id });
      if (!saved.context.reply.ok) return;
      const intent = saved.context.intents.find(intent => intent.id === pending.id)!;
      try {
        if (intent.kind === 'prepare') {
          this.engine.prepareRoomDeletion(roomId, saved.context.deletionId!, intent);
          await this.host.prepare(roomId);
          if (this.controller.signal.aborted) return;
          this.engine.prepareRoomDeletion(roomId, saved.context.deletionId!, intent, true);
          const inventory = await this.host.inventory(roomId, saved);
          const leases = this.store.deletionLeases(roomId);
          if (leases.length) { inventory.executionsSettled = false; inventory.blockers.push({ id: 'workspace-leases', kind: 'effects', human: true, reason: `仍有${leases.length}项执行资源租约需要精确核对` }); }
          this.event(roomId, intent, { type: 'PREPARED', inventory, nextWake: Date.now() + 5000 });
        } else if (intent.kind === 'removeAsset') {
          const asset = saved.context.assets.find(asset => asset.id === intent.assetId); if (!asset) throw new Error('DELETION_ASSET_MISSING');
          const result = await this.host.remove({ roomId, deletionId: saved.context.deletionId!, intentId: intent.id, attempt: intent.attempt, asset }, this.controller.signal);
          if (this.controller.signal.aborted) return;
          this.event(roomId, intent, { type: 'ASSET_REMOVED', ...result });
        } else if (intent.kind === 'eraseData') {
          this.host.retire(roomId);
          this.event(roomId, intent, { type: 'DATA_ERASED' });
        } else {
          const filesGone = await this.host.filesGone(inventoryOf(saved));
          if (this.controller.signal.aborted) return;
          const checks = { inventoryComplete: saved.context.blockers.length === 0, filesGone,
            databaseGone: this.store.verifyDeletionDataGone(roomId), executionsSettled: this.store.deletionLeases(roomId).length === 0,
            projectionsCleared: this.host.projectionsGone(roomId), dependenciesPreserved: filesGone };
          if (!Object.values(checks).every(Boolean)) throw new Error('DELETION_VERIFICATION_INCOMPLETE');
          this.event(roomId, intent, { type: 'VERIFIED', checks });
        }
      } catch (error) {
        if (this.controller.signal.aborted) return;
        const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : '清理未完成，可重试原删除流程';
        this.event(roomId, intent, { type: 'FAILED', reason, retryAt: Date.now() + 5000 });
        return;
      }
    }
  }
  async close(graceMs: number) {
    this.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...this.jobs.values()]), new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  status(roomId: string) { const saved = this.store.readDeletion(roomId); return saved ? deletionStatus(restoreRoomDeletion(saved)) : null; }
}
