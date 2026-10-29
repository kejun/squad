import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, type TaskSnapshot } from '../src/task.machine.js';
import type { TaskEvent, TaskInput } from '../src/types.js';
import type { LocalAction } from '../src/local-operation.js';

export function simulateLocalTools() {
  let transitions = 0;
  const traces: { role: string; action: string; branch: string; states: string[]; ordinary: number; checks: number }[] = [];
  const roles = ['owner', 'member', 'builder', 'newBot', 'assistance', 'facilitator', 'check', 'discussion'];
  const branches = ['success', 'failure', 'cancel', 'crashBeforeClaim', 'crashAfterClaim', 'crashAfterReceipt', 'staleResult', 'revoked'];
  const actions: LocalAction[] = [{ type: 'listSkills' }, { type: 'loadSkill', skillId: 'skill1' }, { type: 'readSkillResource', skillId: 'skill1', path: 'references/a.md' }, { type: 'runCli', executable: 'node', args: ['script.js'] }];
  for (const role of roles) for (const action of actions) for (const branch of branches) {
    const input: TaskInput = { taskId: 'local-simulation', owner: role === 'member' ? 'B' : role === 'builder' ? 'builder' : role === 'newBot' ? 'newBot' : 'A', at: 0,
      goal: { text: '验证本地操作', constraints: [], criteria: [], requiredArtifacts: 0 },
      message: { id: 'M', taskId: 'local-simulation', author: 'user', text: '验证本地操作', kind: 'user', at: 0 },
      config: { version: 'v1', toolVersion: 'v1', defaultBot: 'A', inputAnalysis: { enabled: false },
        bots: ['A', 'B', 'builder', 'newBot'].map(id => ({ id, name: id, instructions: '', tools: ['read'] })),
        limits: { ordinary: 100, checks: 10, assists: 10, replans: 5, retries: 5, workTimeoutMs: 1000, progressIntervalMs: 1000, repeatThreshold: 3 } } };
    let snapshot = initialTask(input), seq = 0;
    const states: string[] = [];
    const send = (event: Record<string, unknown>) => {
      snapshot = restoreTask(structuredClone(persistTask(stepTask(snapshot, { id: `e${++seq}`, at: 1, ...event } as TaskEvent)))); transitions++;
      assert(snapshot.context.usage.ordinary <= 100); assert(snapshot.context.usage.checks <= 10);
      states.push(`${event.type}:${taskPhase(snapshot)}:${snapshot.context.intents.flatMap(w => w.localOperations ?? []).at(-1)?.status ?? '-'}`);
      return snapshot.context.reply;
    };
    if (role === 'assistance') send({ type: 'HELP', requestId: 'H', caller: 'A', target: 'B', question: '核查', expected: '结果' });
    if (role === 'facilitator') send({ type: 'BLOCKED', reason: '需要协调' });
    if (role === 'check') send({ type: 'DELIVER', text: 'candidate', artifactIds: [] });
    if (role === 'discussion') {
      send({ type: 'CLAIM', intentId: snapshot.context.intents[0]!.id }); send({ type: 'USER_INPUT', text: '所有人讨论', reviewTargets: ['B'] });
      const coordinator = snapshot.context.intents.at(-1)!; send({ type: 'CLAIM', intentId: coordinator.id });
      send({ type: 'DISCUSSION_PLAN', workId: coordinator.id, fence: coordinator, discussionId: coordinator.discussionId, decision: { action: 'review', question: '核查', expected: '证据', reason: '用户邀请' } });
    }
    let work = snapshot.context.intents.filter(w => w.status === 'pending' && w.kind !== 'cancel').at(-1)!;
    assert(send({ type: 'CLAIM', intentId: work.id }).ok);
    work = snapshot.context.intents.find(w => w.id === work.id)!;
    assert(send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'op', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action, parentAttempt: work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], workspaceId: 'workspace', fence: work }).ok);
    const op = () => snapshot.context.intents.find(w => w.id === work.id)!.localOperations![0]!;
    if (branch === 'crashBeforeClaim') {
      send({ type: 'RECOVER', config: input.config }); assert.equal(op().status, 'queued');
    } else {
      assert(send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'op', sessionId: 'session', parentAttempt: work.attempt, leaseAvailable: true, fence: work }).ok);
      const result = { ok: branch !== 'failure', code: branch === 'failure' ? 'failed' : 'succeeded', data: action.type === 'loadSkill' ? { skillId: 'skill1', skillVersion: 'b'.repeat(64) } : { stdout: 'actual' } };
      if (branch === 'crashAfterClaim') {
        send({ type: 'RECOVER', config: input.config }); assert.equal(op().status, 'uncertain');
        assert(send({ type: 'LOCAL_RECONCILE', intentId: work.id, operationId: 'op', sessionId: 'session', resolution: 'notStarted', detail: 'host proved no launch' }).ok); assert.equal(op().status, 'queued');
      } else {
        assert(send({ type: 'LOCAL_STARTED', intentId: work.id, operationId: 'op', sessionId: 'session' }).ok);
        if (branch === 'cancel') { send({ type: 'STOP' }); assert.equal(op().status, 'cancelling'); assert.equal(send({ type: 'SETTLE', intentId: work.id }).ok, false); }
        if (branch === 'staleResult') snapshot.context.goalVersion++;
        if (branch === 'revoked') { const config = structuredClone(input.config); config.localTools = { enabled: false }; send({ type: 'RECOVER', config }); }
        assert(send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'op', sessionId: 'session', result, settled: true, effectsKnown: true }).ok);
        assert(['succeeded', 'failed'].includes(op().status));
        const usage = snapshot.context.usage.ordinary;
        assert.equal(send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'op', sessionId: 'session', result, settled: true, effectsKnown: true }).ok, false);
        assert.equal(snapshot.context.usage.ordinary, usage);
        if (branch === 'crashAfterReceipt') { send({ type: 'RECOVER', config: input.config }); assert.equal(op().status, 'succeeded'); }
        if (['cancel', 'staleResult', 'revoked'].includes(branch)) assert.equal(snapshot.context.candidate?.text ?? null, role === 'check' ? 'candidate' : null);
      }
    }
    traces.push({ role, action: action.type, branch, states, ordinary: snapshot.context.usage.ordinary, checks: snapshot.context.usage.checks });
  }
  return { model: Object.fromEntries(['task.machine.ts', 'local-operation.ts', 'types.ts'].map(file => [file, createHash('sha256').update(readFileSync(new URL(`../src/${file}`, import.meta.url))).digest('hex')])), cases: traces.length, transitions, traces };
}
if (process.argv[1]?.endsWith('simulate-local-tools.ts')) {
  const report = simulateLocalTools(); mkdirSync('reports', { recursive: true }); writeFileSync('reports/local-tools-simulation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ model: report.model, cases: report.cases, transitions: report.transitions, report: 'reports/local-tools-simulation.json' }, null, 2));
}
