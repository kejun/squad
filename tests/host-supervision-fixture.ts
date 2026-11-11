import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runSupervisedHost } from '../scripts/supervise.js';
import { MemoryStore, SqliteStore, TeamEngine } from '../src/index.js';
import { localModelInput } from './local-model-fixture.js';
import { DiscussionFixture } from './background-discussion-fixture.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!test()) { assert(Date.now() < deadline, 'bounded host observation timed out'); await pause(10); }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
export async function superviseActualProcess(fault: string, stopOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'squad-watchdog-'));
  const marker = join(root, 'boots'); const port = await freePort();
  const worker = join(root, 'worker.mjs');
  writeFileSync(worker, `import {createServer} from 'node:http';import {readFileSync,writeFileSync} from 'node:fs';
let boots=0;try{boots=Number(readFileSync(process.env.BOOTS,'utf8'));}catch{}writeFileSync(process.env.BOOTS,String(++boots));
process.on('SIGTERM',()=>{});
if(boots===1&&process.env.FAULT==='启动永远不就绪'){while(true){}}
createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({healthy:true,hostId:process.env.SQUAD_SUPERVISION_ID}));}).listen(Number(process.env.WEB_PORT),'127.0.0.1');
if(boots===1&&process.env.FAULT==='进程退出')setTimeout(()=>process.exit(7),100);
if(boots===1&&process.env.FAULT==='健康检查超时')setTimeout(()=>{while(true){}},100);`);
  const pids: number[] = [];
  const host = runSupervisedHost({ args: [worker], env: { BOOTS: marker, FAULT: fault, WEB_PORT: String(port) },
    probeMs: 10, probeTimeoutMs: 25, policy: { startupMs: 350, graceMs: 40, retryMs: 10, failureLimit: 2 }, stdio: 'ignore',
    onSpawn: pid => { pids.push(pid); } });
  try {
    await until(() => stopOnly ? host.status().phase === 'healthy' : host.status().generation >= 2 && host.status().phase === 'healthy');
    const beforeStop = host.status(); const start = Date.now(); host.stop(); await host.done;
    assert(Date.now() - start < 500, 'supervisor stop exceeds configured bound');
    await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    const boots = Number(readFileSync(marker, 'utf8')); await pause(40);
    assert.equal(Number(readFileSync(marker, 'utf8')), boots, 'stopped supervisor respawned a worker');
    assert.equal(host.status().phase, 'stopped');
    if (!stopOnly) assert(beforeStop.restarts >= 1);
    return { beforeStop, boots, allProcessesGone: true, stopBounded: true };
  } finally { host.stop(); await host.done; rmSync(root, { recursive: true, force: true }); }
}
export function rejectMissingTarget(command: string) {
  const store = new MemoryStore(), engine = new TeamEngine(store, localModelInput().config, () => 1);
  const created = engine.submit('room', { id: 'real', text: '当前有效任务' }); assert(created.ok);
  const before = structuredClone(engine.view('room', created.taskId)!);
  const reply = engine.submit('room', { id: 'missing', text: command === '停止' ? '停止' : '输入', replyToTaskId: 'missing',
    intent: command === '继续' ? 'continue' : command === '人类决策' ? 'decision' : 'supplement' });
  assert.equal(reply.code, 'TASK_NOT_FOUND'); assert.equal(store.read('room').activeTaskId, created.taskId);
  assert.equal(Object.keys(store.read('room').tasks).length, 1); assert.deepEqual(engine.view('room', created.taskId), before);
  return reply;
}
export function rejectOldPointer() {
  const store = new MemoryStore(), engine = new TeamEngine(store, localModelInput().config, () => 1);
  const old = engine.submit('room', { id: 'old', text: '旧任务' }); assert(old.taskId);
  assert(engine.send('room', old.taskId, { id: 'exhaust', type: 'EXHAUSTED', at: 1, reason: '已耗尽' }).ok);
  const current = engine.submit('room', { id: 'new', text: '新任务' }); assert(current.taskId);
  const reply = engine.send('room', old.taskId, { id: 'late', type: 'COORDINATE', at: 2, decision: { action: 'continue', reason: '旧决定' } });
  assert(!reply.ok); assert.equal(store.read('room').activeTaskId, current.taskId); return reply;
}
export async function temporaryClaimRetries() {
  const f = new DiscussionFixture();
  try {
    f.invite(); await f.one();
    const member = f.engine.claim(f.room, f.task, f.pending().find(w => w.target === 'B')!.id); assert(member);
    assert(f.engine.send(f.room, f.task, { type: 'HELP', id: 'primary-help', at: f.now, workId: f.ownerWork.id, fence: f.ownerWork,
      caller: 'A', target: 'B', requestId: 'primary-B', question: '独立核查', expected: '核查资料' }).ok);
    const primary = f.context().intents.find(w => w.kind === 'assistance' && !w.discussionId)!;
    assert.equal(f.engine.claim(f.room, f.task, primary.id), null); assert.equal(f.context().reply.code, 'WORK_BUSY');
    assert(f.engine.send(f.room, f.task, { type: 'DISCUSSION_RESULT', id: 'background-done', at: f.now, workId: member.id,
      attempt: member.attempt, fence: member, discussionId: member.discussionId!, text: '背景核查完成', status: 'success' }).ok);
    const accepted = f.engine.claim(f.room, f.task, primary.id); assert(accepted);
    const usage = structuredClone(f.context().usage);
    const duplicate = f.engine.send(f.room, f.task, { id: `claim:${primary.id}:1`, type: 'CLAIM', intentId: primary.id, at: f.now });
    assert(duplicate.ok && duplicate.duplicate); assert.deepEqual(f.context().usage, usage);
    return { accepted: true, duplicate: true, costsPreserved: true };
  } finally { f.close(); }
}

export async function httpContinuationBudget(extra: number) {
  const { WebService } = await import('../src/web/service.js');
  const { createWebServer } = await import('../src/web/http.js');
  const { WorkFailure } = await import('../src/runner.js');
  const root = mkdtempSync(join(tmpdir(), 'squad-http-budget-'));
  const config = localModelInput().config; config.limits.ordinary = 1;
  const service = new WebService(config, join(root, 'team.sqlite'), { execute: async (_work, signal) => new Promise((_, reject) => {
    const abort = () => reject(new WorkFailure('已停止'));
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  }) });
  const server = createWebServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const room = service.createRoom('HTTP额度'); const task = service.engine.submit(room.id, { id: 'task', text: '工作' }); assert(task.taskId);
    const work = service.engine.claim(room.id, task.taskId, service.engine.pending(room.id, task.taskId)[0]!.id); assert(work);
    assert(service.engine.send(room.id, task.taskId, { type: 'SETTLE', id: 'settle-previous', intentId: work.id, at: Date.now() }).ok);
    assert(service.engine.send(room.id, task.taskId, { type: 'EXHAUSTED', id: 'exhausted', at: Date.now(), reason: '额度耗尽' }).ok);
    const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/rooms/${room.id}/messages`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'continue', text: '继续', intent: 'continue', replyToTaskId: task.taskId, extraOrdinary: extra }) });
    assert.equal(response.status, 200, await response.text());
    const current = service.engine.view(room.id, task.taskId)!;
    assert.equal(current.context.config.limits.ordinary, 1 + extra); assert(current.context.usage.ordinary >= 1);
    return { authorized: extra, limit: current.context.config.limits.ordinary, priorUsagePreserved: true };
  } finally { await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}

export function repeatedClaimDoesNotInventNoStart(sqlite: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'squad-claim-race-'));
  const store = sqlite ? new SqliteStore(join(root, 'team.sqlite')) : new MemoryStore();
  let now = 0;
  const config = localModelInput().config, engine = new TeamEngine(store, config, () => now), peer = new TeamEngine(store, config, () => now);
  try {
    const task = engine.submit('room', { id: 'claim-race', text: '只能实际执行一次' }).taskId!;
    const candidate = engine.pending('room', task)[0]!;
    const winner = peer.claim('room', task, candidate.id)!; assert(winner);
    const initialUsage = structuredClone(engine.view('room', task)!.context.usage);
    assert.equal(engine.claim('room', task, candidate.id), null, 'A stale projection cannot claim the already-reserved work');
    const futureDenial = engine.send('room', task, { type: 'CLAIM', id: `claim:${winner.id}:2`, at: now, intentId: winner.id });
    assert.equal(futureDenial.code, 'WORK_NOT_PENDING');
    assert(peer.beginExecution('room', task, winner));
    const denied = engine.executionNotStarted('room', task, winner, 'This second runner did not start its own adapter');
    assert.equal(denied.code, 'EXECUTION_START_UNVERIFIED');
    assert.equal(engine.executionPhase('room', task, winner), 'running');
    assert.equal(engine.view('room', task)!.context.intents.find(w => w.id === winner.id)!.status, 'inflight');
    assert.deepEqual(engine.view('room', task)!.context.usage, initialUsage);
    now = 1; peer.recover('room');
    const retried = engine.claim('room', task, winner.id); assert(retried, 'Prior WORK_NOT_PENDING cannot cache a future claim rejection');
    assert.equal(retried.attempt, 2); assert.equal(engine.view('room', task)!.context.usage.ordinary, initialUsage.ordinary + 1);
    assert(engine.beginExecution('room', task, retried)); assert.equal(peer.beginExecution('room', task, retried), false);
    return { storage: sqlite ? 'SQLite' : 'Memory', rejectedFalseNoStart: true, recoveredAttempt: 2, duplicateCosts: 0 };
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}
