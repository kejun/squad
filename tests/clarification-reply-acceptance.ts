import assert from 'node:assert/strict';
import { InputIntentFixture, intentConfig, parsedIntent } from './input-intent-fixture.js';
import { processingWindow, taskHumanGate } from '../src/task/resilience.js';

/** Actual Engine, Runner, compatible provider protocol and two Stores; provider HTTP is scripted. */
export async function clarificationReplyEngineAcceptance(mode: 'reply' | 'skip' | 'skipHelp' | 'replyHelp') {
  const rows = [];
  for (const sqlite of [false, true]) {
    const config = intentConfig({ retries: 3 }); config.resilience = { automaticTimeoutMs: 1000, repairTimeoutMs: 20, repairLimit: 2 };
    const f = new InputIntentFixture(config, sqlite);
    try {
      if (mode.endsWith('Help')) {
        assert(f.submit('简单任务').ok); f.prepare('assistance'); f.replies = [new Response('temporary dependency unavailable', { status: 400 })]; assert(await f.run());
        assert.equal(f.context().assists[0]!.status, 'failed');
        assert(f.submit('必须选择一个方案，再组织后续工作', { id: 'clarification-input' }).ok);
      } else assert(f.submit('必须选择一个方案，再组织后续工作').ok);
      f.replies = [{ type: 'interpretation', spec: parsedIntent(f.context().inputAnalyses!.at(-1)!.action, { clarification: '请选择方案甲或乙' }) }]; assert(await f.run());
      const gate = taskHumanGate(f.context())!; assert(gate); assert.equal(gate.kind, 'clarification');
      if (mode.endsWith('Help')) assert(f.engine.submit(f.room, { id: 'retry-before-answer', text: '明确重试B', intent: 'retry', replyToTaskId: f.task, retryAssistanceId: 'intent-help' }).ok);
      const originalWindow = structuredClone(processingWindow(f.context())); const before = f.requests.length;
      const skip = mode.startsWith('skip');
      assert(f.event({ type: 'HUMAN_GATE_DECISION', gateId: gate.id, decision: skip ? 'skip' : 'reply', text: skip ? '明确忽略这部分澄清' : '选择方案甲' }).ok);
      assert(!taskHumanGate(f.context())); if (sqlite) f.reopen();
      if (!skip) {
        assert.equal(f.view().phase, 'interpreting'); f.replies = [{ type: 'interpretation', spec: parsedIntent('supplement', { objective: '选择方案甲' }) }]; assert(await f.run());
        assert.equal(f.requests.at(-1)!.kind, 'interpretation');
        assert.equal(f.context().inputAnalyses!.at(-1)!.rawText, '选择方案甲');
      } else if (mode === 'skipHelp') {
        assert.equal(f.view().phase, 'waitingAssistance'); f.replies = [{ type: 'answer', text: '已保存独立核对意见' }]; assert(await f.run());
        assert.equal(f.requests.at(-1)!.kind, 'assistance'); const savedCount = f.requests.length; assert(await f.run());
        assert.equal(f.requests.length, savedCount, 'Durable result handoff precedes another provider request'); assert.equal(f.context().assists.at(-1)!.status, 'success');
        assert.equal(f.context().results.filter(result => result.consumed).length, 1);
      }
      assert.equal(f.view().phase, 'running');
      const currentOwner = f.engine.pending(f.room, f.task).filter(work => work.kind === 'owner'); assert.equal(currentOwner.length, 1);
      f.replies = [{ type: 'askUser', question: '新的目标已解释，等待下一项明确业务决定' }]; assert(await f.run());
      assert.equal(f.requests.at(-1)!.kind, 'owner'); assert(f.requests.length > before);
      assert.deepEqual(processingWindow(f.context()), originalWindow); assert.equal(f.context().resilience!.window.repairUsed, 0);
      assert.equal(f.context().intents.filter(work => work.kind === 'assistance' && work.status === 'pending').length, 0);
      rows.push({ backend: sqlite ? 'sqlite' : 'memory', mode, executed: f.requests.slice(before).map(request => request.kind), repairUsed: 0, resumedOwner: currentOwner[0]!.id });
    } finally { f.close(); }
  }
  return rows;
}
