import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import type { Intent } from '../src/index.js';
import { configuration } from './helpers.js';

async function until(test: () => boolean) {
  for (let n = 0; n < 150; n++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('网页宿主没有在有界时间内达到预期状态');
}
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { open, wait: (signal: AbortSignal) => Promise.race([promise, new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]) };
}

/** The gates make serial execution fail: all four members must enter before any may return. */
export async function verifyWebDiscussion(order: 'owner-first' | 'discussion-first' | 'stop' = 'discussion-first') {
  const directory = mkdtempSync(join(tmpdir(), 'squad-discussion-web-'));
  const calls: Intent[] = [];
  const owner = gate(); const members = gate();
  let ownerCalls = 0; let memberCalls = 0;
  const service = new WebService(configuration(), join(directory, 'team.sqlite'), { execute: async (work, signal) => {
    calls.push(work);
    if (work.kind === 'owner') {
      if (++ownerCalls === 1) { await owner.wait(signal); return { type: 'deliver', text: 'HTTP 初稿', artifactIds: [] }; }
      const round = work.payload.discussion as { status: string; results: unknown[]; summary: string };
      assert.equal(round.status, 'delivered'); assert.equal(round.results.length, 4); assert(round.summary.includes('协调员整理'));
      assert.equal((work.payload.candidate as { text: string }).text, 'HTTP 初稿');
      return { type: 'deliver', text: '已吸收讨论的最终方案', artifactIds: [] };
    }
    if (work.kind === 'facilitator') return { type: 'decision', decision: { action: 'review', question: '讨论风险和替代方案', expected: '依据与建议', reason: '直接邀请' } };
    if (work.kind === 'assistance') { memberCalls++; await members.wait(signal); return { type: 'answer', text: `${work.target} 的原始意见` }; }
    if (work.kind === 'discussionSummary') return { type: 'answer', text: '协调员整理共识、分歧和证据。' };
    assert.equal(work.kind, 'check'); return { type: 'check', passed: true, gaps: [] };
  } });
  const server = createWebServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, path === '/api/rooms' ? 201 : 200); return response.json();
  };
  try {
    const room = await post('/api/rooms', { title: '后台讨论验收' }) as { id: string };
    const route = `/api/rooms/${room.id}`;
    const task = await post(`${route}/messages`, { id: 'plan', text: '制定离线同步方案' }) as { taskId: string };
    await until(() => ownerCalls === 1);
    await post(`${route}/messages`, { id: 'discussion', text: '所有人都参与讨论一下' });
    await until(() => memberCalls === 4);
    assert.equal(ownerCalls, 1);
    assert.equal(service.engine.view(room.id, task.taskId)!.context.intents.filter(work => work.status === 'inflight').length, 5);
    if (order === 'stop') {
      service.stop(room.id, task.taskId, 'stop');
      await until(() => service.engine.view(room.id, task.taskId)!.context.outcome === 'stopped');
      assert.equal(ownerCalls, 1); assert(!calls.some(work => work.kind === 'discussionSummary' || work.kind === 'check'));
    } else {
      if (order === 'owner-first') {
        owner.open(); await until(() => service.engine.view(room.id, task.taskId)!.context.candidate?.text === 'HTTP 初稿');
        assert(!calls.some(work => work.kind === 'check')); members.open();
      } else {
        members.open(); await until(() => service.engine.view(room.id, task.taskId)!.context.discussion?.status === 'ready');
        assert.equal(ownerCalls, 1); owner.open();
      }
      await until(() => service.engine.view(room.id, task.taskId)!.context.outcome === 'complete');
      assert.equal(ownerCalls, 2); assert.equal(calls.filter(work => work.kind === 'discussionSummary').length, 1);
      assert.equal(calls.filter(work => work.kind === 'check').length, 1);
      assert.equal(service.snapshot(room.id).messages.filter(message => message.kind === 'final').length, 1);
    }
    return { memberCalls, ownerCalls, outcome: service.engine.view(room.id, task.taskId)!.context.outcome };
  } finally {
    owner.open(); members.open();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function verifyRoomIsolation() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-discussion-isolation-'));
  const held = gate(); const signals: AbortSignal[] = [];
  const service = new WebService(configuration(), join(directory, 'team.sqlite'), { execute: async (work, signal) => {
    if (work.kind === 'owner') { signals.push(signal); await held.wait(signal); return { type: 'deliver', text: '独立结果', artifactIds: [] }; }
    return { type: 'check', passed: true, gaps: [] };
  } });
  try {
    const a = service.createRoom('群一'); const b = service.createRoom('群二');
    service.submit(a.id, { id: 'same-id', text: '独立请求' }); service.submit(b.id, { id: 'same-id', text: '独立请求' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(signals.length, 2, '相同工作 ID 不能跨群占用宿主槽位');
    service.stop(a.id, 'task:same-id', 'stop-a');
    await until(() => signals[0]!.aborted);
    assert.equal(signals[1]!.aborted, false);
    held.open();
    await until(() => service.engine.view(b.id, 'task:same-id')!.context.outcome === 'complete');
    return { started: signals.length, otherAborted: signals[1]!.aborted, otherOutcome: service.engine.view(b.id, 'task:same-id')!.context.outcome };
  } finally { held.open(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
}

export async function verifyDeniedClaimYield() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-discussion-denied-'));
  let attempts = 0; let requests = 0;
  const service = new WebService(configuration(), join(directory, 'team.sqlite'), { execute: async work => {
    requests++;
    return work.kind === 'check' ? { type: 'check', passed: true, gaps: [] } : { type: 'deliver', text: '请求正常完成', artifactIds: [] };
  } });
  const original = service.engine.claim.bind(service.engine);
  service.engine.claim = (room, task, id) => ++attempts === 1 ? null : original(room, task, id);
  try {
    const room = service.createRoom('领取竞争'); const command = { id: 'request', text: '正常请求' };
    service.submit(room.id, command);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(attempts, 1, '没有进展时不能在微任务中不断重试领取'); assert.equal(requests, 0);
    const initialAttempts = attempts; const initialRequests = requests;
    service.submit(room.id, command);
    await until(() => service.engine.view(room.id, 'task:request')!.context.outcome === 'complete');
    assert.equal(requests, 2); // One owner request and one independent check.
    return { initialAttempts, initialRequests, totalRequests: requests, outcome: service.engine.view(room.id, 'task:request')!.context.outcome };
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
}
