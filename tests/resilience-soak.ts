/** Integration soak: public service lifecycle + real SQLite, isolated process. No provider or fabricated DB rows. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebService } from '../src/web/service.js';
import { localModelInput } from './local-model-fixture.js';
import { fixtureCheck } from './delivery-protocol-fixture.js';
const rounds = Number(process.env.SQUAD_SOAK_ROUNDS ?? 25);
assert(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 1000);
const root = mkdtempSync(join(tmpdir(), 'squad-resilience-soak-')), path = join(root, 'team.sqlite');
const config = localModelInput().config; config.resilience = { cancelGraceMs: 10 };
const timers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
const baselineTimers = timers();
const deleted: string[] = [];
let controlRoom = '', controlTask = '', requests = 0, previousHeap = 0;
const heap: number[] = [];
const until = async (test: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!test()) { assert(Date.now() < deadline, 'soak progress deadline exceeded'); await new Promise(resolve => setTimeout(resolve, 2)); }
};
try {
  for (let round = 0; round < rounds; round++) {
    const service = new WebService(config, path, { execute: async work => {
      requests++; return work.kind === 'check' ? fixtureCheck(work.payload.candidate) : { type: 'deliver', text: '受控验收的实际持久交付', artifactIds: [] };
    } }, undefined, true);
    try {
      await service.ready();
      if (!round) {
        controlRoom = service.createRoom('保留会话').id;
        controlTask = service.submit(controlRoom, { id: 'control', text: '保留原有内容' }).taskId!;
        await until(() => service.engine.view(controlRoom, controlTask)?.context.outcome === 'complete');
      }
      const ordinary = service.createRoom(`交付${round}`);
      const task = service.submit(ordinary.id, { id: `normal-${round}`, text: '生成可核验方案' }).taskId!;
      await until(() => service.engine.view(ordinary.id, task)?.context.outcome === 'complete');
      const human = service.createRoom(`人类门${round}`);
      const waiting = service.engine.submit(human.id, { id: `human-${round}`, text: '缺少的一部分内容可以跳过' }).taskId!;
      const work = service.engine.claim(human.id, waiting, service.engine.pending(human.id, waiting)[0]!.id)!;
      assert(service.engine.send(human.id, waiting, { type: 'WAIT_USER', id: `question-${round}`, at: Date.now(), workId: work.id, question: '这一部分无法取得，是否跳过？' }).ok);
      const gate = service.snapshot(human.id).blockers!.find(g => g.status === 'open')!;
      service.decideBlocker(human.id, { id: `skip-${round}`, taskId: waiting, blockerId: gate.id, blockerVersion: gate.version, actionId: 'skip' });
      await until(() => service.engine.view(human.id, waiting)?.context.outcome !== null);
      assert.equal(service.engine.view(human.id, waiting)!.context.outcome, 'partial', 'skipped content must never become complete after a model check');
      for (const room of [ordinary, human]) {
        const archived = service.setRoomArchived(room.id, `archive-${room.id}`, true);
        await service.deleteRoom(room.id, { id: `delete-${round}-${room.id}`, expectedArchiveVersion: archived.archiveVersion! });
        await until(() => service.deletedRooms().some(value => value.roomId === room.id));
        deleted.push(room.id);
        assert.throws(() => service.snapshot(room.id), /已删除/);
      }
      assert.equal(service.engine.view(controlRoom, controlTask)!.context.outcome, 'complete');
      assert.equal(service.snapshot(controlRoom).messages.at(-1)!.text, '受控验收的实际持久交付');
    } finally { await service.close(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(timers(), baselineTimers, 'service restart leaked active timers');
    if (globalThis.gc) globalThis.gc();
    previousHeap = process.memoryUsage().heapUsed; heap.push(previousHeap);
    const db = new DatabaseSync(path);
    try {
      for (const roomId of deleted) for (const [table, column] of [['rooms', 'id'], ['receipts', 'room_id'], ['web_rooms', 'id'], ['web_events', 'roomId']])
        assert.equal((db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(roomId) as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM resource_leases').get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM workspace_leases').get() as { n: number }).n, 0);
    } finally { db.close(); }
  }
  const result = { status: 'passed', rounds, tasksCompleted: rounds + 1, tasksPartial: rounds, roomsDeleted: deleted.length,
    requests, source: 'real WebService and SQLite; controlled adapter; no external provider', activeTimerGrowth: timers() - baselineTimers,
    heapBytes: heap, finalHeapBytes: previousHeap, gcEnabled: !!globalThis.gc,
    limit: 'bounded process-local exercise; no production-scale SLO, unbounded liveness or media erasure claim' };
  mkdirSync('reports/kej-113-114', { recursive: true }); writeFileSync('reports/kej-113-114/soak.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, heapBytes: { first: heap[0], last: heap.at(-1), max: Math.max(...heap) } }));
} finally { rmSync(root, { recursive: true, force: true }); }
