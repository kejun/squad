import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore, TeamEngine, type TaskEvent } from '../src/index.js';
import { localModelInput } from './local-model-fixture.js';
import { taskHumanGate, processingWindow } from '../src/task/resilience.js';

/** Actual Engine transactions and SQLite reopening; no provider/process is called. */
export function configurationEngineAcceptance(response?: string, materials = '已保存当前成果', keepCleanup = false) {
  return (['memory', 'sqlite'] as const).map(backend => {
    const directory = mkdtempSync(join(tmpdir(), 'squad-configuration-recovery-')), config = localModelInput().config;
    let store = backend === 'memory' ? new MemoryStore() : new SqliteStore(join(directory, 'state.sqlite'));
    let at = 0, sequence = 0; const room = 'configuration-room';
    let engine = new TeamEngine(store, config, () => at);
    const created = engine.submit(room, { id: 'create', text: '保留原任务的执行协议' }); assert(created.ok); const task = created.taskId!;
    const send = (body: Record<string, unknown>) => engine.send(room, task, { id: `config:${++sequence}`, at, ...body } as TaskEvent);
    if (materials !== '没有可用成果') assert(send({ type: 'ARTIFACT', artifact: { id: 'saved', name: 'saved.md', content: '已保存但尚未核验' } }).ok);
    if (materials.includes('未知操作') || keepCleanup) {
      const work = engine.claim(room, task, engine.pending(room, task)[0]!.id)!; assert(work);
      const op = engine.requestLocal(room, task, work.id, work.attempt, { type: 'runCli', executable: 'node', args: ['effect.js'] }, [], 'workspace:configuration');
      const claimed = engine.claimLocal(room, task, work.id, op.id, work.attempt); assert(claimed.response.ok);
      assert(send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: claimed.operation!.sessionId }).ok);
      assert(send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: claimed.operation!.sessionId, effectsKnown: false, settled: true,
        result: { ok: false, code: 'unknown', data: {} } }).ok);
    }
    const changed = structuredClone(config); changed.toolVersion = 'new-host-tools'; engine = new TeamEngine(store, changed, () => at); engine.recover(room);
    const initial = engine.view(room, task)!, gate = taskHumanGate(initial.context)!; assert(gate); const window = structuredClone(processingWindow(initial.context));
    try {
      if (keepCleanup) { at = window.hardDeadline + 1; assert(send({ type: 'SUPERVISE', trigger: 'timer' }).ok); const wake = engine.nextWake(room); assert(wake !== null && wake > at); }
      else if (!response) assert(send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: 'skip', text: '明确跳过剩余业务' }).ok);
      else if (response === '普通补充' || response === '普通人类决定' || response === '继续命令') {
        const reply = engine.submit(room, { id: `human:${response}`, text: '继续处理', replyToTaskId: task,
          intent: response === '普通补充' ? 'supplement' : response === '普通人类决定' ? 'decision' : 'continue' });
        assert.equal(reply.ok, response !== '继续命令');
      } else assert.equal(send({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: response.includes('新窗口') ? 'newWindow' : 'reply', text: '继续', newWindowMs: 100 }).code, 'HUMAN_GATE_DECISION_NOT_ALLOWED');
      if (backend === 'sqlite') { store.close(); store = new SqliteStore(join(directory, 'state.sqlite')); engine = new TeamEngine(store, changed, () => at); }
      const after = engine.view(room, task)!; assert.deepEqual(processingWindow(after.context), window);
      if (!response && !keepCleanup) { assert.equal(after.phase, 'ended'); assert.equal(after.context.outcome, materials === '没有可用成果' ? 'failed' : 'partial'); }
      else { assert.equal(after.phase, 'waitingHuman'); assert.equal(taskHumanGate(after.context)?.id, gate.id); assert.equal(after.context.outcome, null); }
      return { backend, phase: after.phase, outcome: after.context.outcome, gate: taskHumanGate(after.context)?.id ?? null, cleanup: after.context.resilience!.cleanup.length };
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
