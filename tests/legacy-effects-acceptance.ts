import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamEngine, MemoryStore, SqliteStore, type Intent } from '../src/index.js';
import { resolveLocalResourcePolicy } from '../src/local-resource-policy.js';
import { localModelInput } from './local-model-fixture.js';

export function legacyEffectsAcceptance(sqlite: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'squad-legacy-effects-'));
  let store = sqlite ? new SqliteStore(join(directory, 'team.sqlite')) : new MemoryStore();
  let now = 0;
  const config = localModelInput().config; config.resilience = { automaticTimeoutMs: 100, repairTimeoutMs: 20 };
  let engine = new TeamEngine(store, config, () => now);
  const room = 'legacy', task = engine.submit(room, { id: 'work', text: '自定义工具执行' }).taskId!;
  try {
    const owner = engine.claim(room, task, engine.pending(room, task)[0]!.id)!;
    assert(engine.send(room, task, { type: 'ARTIFACT', id: 'draft', at: now, artifact: { id: 'draft', name: 'draft.md', content: '已有未核验材料' } }).ok);
    assert(engine.send(room, task, { type: 'TOOL', id: 'unsafe', at: now, workId: owner.id, fence: owner, tool: 'read', replay: 'unsafe', payload: {} }).ok);
    const unsafe = engine.claim(room, task, engine.pending(room, task).find(w => w.kind === 'tool')!.id)!;
    assert(engine.send(room, task, { type: 'RECOVER', id: 'recover-unsafe', at: now, config }).ok);
    now = 101; engine.tick(room);
    assert.equal(engine.view(room, task)!.context.resilience!.cleanup[0]!.kind, 'legacyWork');
    assert(engine.nextWake(room) !== null);
    if (sqlite) { store.close(); store = new SqliteStore(join(directory, 'team.sqlite')); engine = new TeamEngine(store, config, () => now); engine.recover(room); }
    assert(engine.submit(room, { id: 'new-window', text: '在未知效果隔离下继续内容', intent: 'continue', replyToTaskId: task, newWindowMs: 100 }).ok);
    const resumed = engine.claim(room, task, engine.pending(room, task).find(w => w.kind === 'owner')!.id)!; assert(resumed);
    const prepare = (targetRoom: string, targetTask: string, work: Intent) => {
      const policy = resolveLocalResourcePolicy({ workspaceId: `workspace:${targetRoom}`, isolatedWork: false, execution: 'sandbox', sandboxConfinesWorkspace: true, action: 'runCli' });
      return engine.requestLocal(targetRoom, targetTask, work.id, work.attempt, { type: 'runCli', executable: 'node', args: ['never-executed.mjs'] }, [], `workspace:${targetRoom}`, policy);
    };
    const op = prepare(room, task, resumed);
    assert.equal(engine.claimLocal(room, task, resumed.id, op.id, resumed.attempt).response.code, 'WORKSPACE_BUSY');
    const otherTask = engine.submit('other', { id: 'other', text: '另一房间' }).taskId!;
    const other = engine.claim('other', otherTask, engine.pending('other', otherTask)[0]!.id)!;
    const otherOp = prepare('other', otherTask, other);
    assert.equal(engine.claimLocal('other', otherTask, other.id, otherOp.id, other.attempt).response.code, 'WORKSPACE_BUSY');
    const before = engine.view(room, task)!.context.intents.filter(w => w.kind === 'owner').length;
    assert(engine.send(room, task, { type: 'RECONCILE', id: 'provider-receipt', at: now, intentId: unsafe.id, resolution: 'confirmed', detail: '受信工具提供方已核对原效果' }).ok);
    assert.equal(engine.view(room, task)!.context.resilience!.cleanup[0]!.state, 'settled');
    assert.equal(engine.view(room, task)!.context.intents.filter(w => w.kind === 'owner').length, before, 'Late effect settlement cannot schedule another owner');
    assert(engine.claimLocal('other', otherTask, other.id, otherOp.id, other.attempt).response.ok);
    return { store: sqlite ? 'SQLite' : 'Memory', ownRoomIsolated: true, otherRoomIsolated: true, contentProceeding: true, trustedSettlementOnly: true, processesLaunched: 0 };
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1]?.endsWith('legacy-effects-acceptance.ts')) console.log(JSON.stringify([legacyEffectsAcceptance(false), legacyEffectsAcceptance(true)]));
