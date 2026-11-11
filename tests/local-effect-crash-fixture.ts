import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalRuntime } from '../src/local-runtime.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WebService } from '../src/web/service.js';
import { ControlledProcessBackend, localConfig } from './local-tools-fixture.js';
import { withFixtureAcceptance } from './delivery-protocol-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { identityAlive, type CliCompletion } from '../src/local-cli.js';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { heldLocalResourceLeases } from '../src/local-operation.js';

interface Barrier { type: 'barrier'; window: string; hostPid: number; roomId: string; taskId: string; workId: string;
  operationId: string; sessionId: string; workspaceId: string; completion: CliCompletion }
type Mode = 'beforeReceipt' | 'afterJournal' | 'stopped';
interface ModelRequest { messages: { content: string }[] }
const modelRole = (request: ModelRequest) => /executing (\w+) work/.exec(request.messages[0]!.content)?.[1];

function childBarrier(child: ChildProcess): Promise<Barrier> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Host did not reach the effect/receipt barrier in 15s')), 15_000);
    child.once('message', message => { clearTimeout(timer); accept(message as Barrier); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Host exited before barrier: ${code}/${signal}`)); });
  });
}
function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Killed host did not exit in 5s')), 5_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); accept({ code, signal }); });
  });
}
function processGroupGone(pid: number) {
  try { process.kill(-pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}
function sqliteProof(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { rooms: db.prepare('SELECT id,data FROM rooms').all(), receipts: db.prepare('SELECT * FROM receipts').all(),
    leases: db.prepare("SELECT key,owner,'write' AS mode,'execute' AS phase,'legacy' AS registry FROM workspace_leases UNION ALL SELECT key,owner,mode,phase,'resources' AS registry FROM resource_leases ORDER BY key,owner,phase").all() }; }
  finally { db.close(); }
}
function active(service: WebService, barrier: Barrier) {
  const context = service.engine.view(barrier.roomId, barrier.taskId)!.context;
  const work = context.intents.find(item => item.id === barrier.workId)!;
  return { context, work, op: work.localOperations!.find(item => item.id === barrier.operationId)! };
}
async function assertUnknownResourceProtection(service: WebService, runtime: LocalRuntime, root: string, barrier: Barrier) {
  const { op } = active(service, barrier), proof = sqliteProof(join(root, 'team.sqlite'));
  const expected = op.resourceLeases?.length ? heldLocalResourceLeases(op)
    : [{ key: barrier.workspaceId, mode: 'write', phase: 'execute' }];
  const leases = proof.leases as { key: string; owner: string; mode: string; phase: string }[];
  const resource = ({ key, mode, phase }: { key: string; mode: string; phase: string }) => ({ key, mode, phase });
  const sorted = (values: { key: string; mode: string; phase: string }[]) => values.map(resource).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert(expected.length > 0, 'Unknown physical effects must retain a persisted conflict resource');
  assert.deepEqual(sorted(leases), sorted(expected), 'Unknown effects must retain every actual source/global lease, including the current registry');
  assert.equal(new Set(leases.map(lease => lease.owner)).size, 1, 'The original operation must still own its entire atomic conflict set');
  const contenderStore = new SqliteStore(join(root, 'team.sqlite'));
  try {
    const engine = new TeamEngine(contenderStore, localConfig(), Date.now), room = `crash-contention:${randomUUID()}`;
    const created = engine.submit(room, { id: 'contender', text: '尝试领取仍未结算的真实源资源' }); assert(created.ok && created.taskId);
    const task = created.taskId, work = engine.claim(room, task, engine.pending(room, task)[0]!.id)!; assert(work);
    const namespace = engine.localNamespace(room, task), action = op.action;
    const queued = engine.requestLocal(room, task, work.id, work.attempt, action, [], runtime.workspaceId(work, namespace), runtime.resourcePolicy(work, action, namespace));
    const claim = engine.claimLocal(room, task, work.id, queued.id, work.attempt);
    assert.equal(claim.response.code, 'WORKSPACE_BUSY', 'A second public Engine must not obtain an execution permit for unknown conflicting effects');
    assert.equal(claim.response.ok, false); assert.equal(claim.operation!.status, 'queued');
    assert.equal(claim.operation!.startedAt, undefined); assert.equal(claim.operation!.sessionId, undefined);
    assert.deepEqual(sqliteProof(join(root, 'team.sqlite')).leases, proof.leases, 'A rejected atomic claim must not take or release any actual resource');
    assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x');
    return { leases: proof.leases, contender: { code: claim.response.code, status: claim.operation!.status, started: false }, effectLedger: 'x' };
  } finally { contenderStore.close(); }
}
function settledProjection(service: WebService, barrier: Barrier) {
  const { context, work } = active(service, barrier);
  return { messages: context.messages, artifacts: context.artifacts, candidate: context.candidate,
    ownerWorks: context.intents.filter(item => item.kind === 'owner').map(item => ({ id: item.id, status: item.status, attempt: item.attempt })),
    checkpoint: work.localCheckpoint, operations: work.localOperations };
}
async function waitComplete(service: WebService, b: Barrier) {
  for (let count = 0; count < 200; count++) {
    if (service.engine.view(b.roomId, b.taskId)!.context.outcome !== null) break;
    await delay(10);
  }
  assert.equal(active(service, b).context.outcome, 'complete', 'Trusted receipt must resume the original parent to completion');
}

/** Actual SQLite, files, CLI and SIGKILL; injected backend makes no OS-sandbox claim. */
export async function localEffectCrashAcceptance(mode: Mode = 'beforeReceipt') {
  const root = await mkdtemp(join(tmpdir(), 'squad-effect-crash-'));
  const evidence = resolve('reports/kej-103', `${Date.now()}-${process.pid}-${randomUUID()}`);
  await mkdir(evidence, { recursive: true }); await mkdir(join(root, 'source'));
  const proof: Record<string, unknown> = { mode, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDiff: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }), node: process.version, evidence };
  let child: ChildProcess | undefined, runtime: LocalRuntime | undefined, service: WebService | undefined;
  let hostOutput = '', hostExited = false;
  const backend = new ControlledProcessBackend(); const modelRequests: ModelRequest[] = [];
  try {
    child = spawn(process.execPath, ['--experimental-transform-types', '--loader', './tests/fixtures/typescript-loader.mjs', 'tests/fixtures/local-effect-crash-host.ts', root,
      mode === 'afterJournal' ? 'afterJournal' : 'beforeReceipt'], { cwd: process.cwd(), detached: true,
      env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout!.on('data', data => { hostOutput += String(data); }); child.stderr!.on('data', data => { hostOutput += String(data); });
    const barrier = await childBarrier(child); assert.equal(barrier.type, 'barrier'); assert.equal(barrier.hostPid, child.pid);
    proof.barrier = barrier; proof.beforeKill = sqliteProof(join(root, 'team.sqlite'));
    assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x', 'Barrier must follow the actual non-idempotent effect');
    const termination = exited(child); process.kill(-child.pid!, 'SIGKILL'); proof.exit = await termination; hostExited = true;
    assert.deepEqual(proof.exit, { code: null, signal: 'SIGKILL' });
    assert(processGroupGone(child.pid!), 'Killed host process group must have no surviving descendants');
    runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), workspaceRoot: join(root, 'source'), skillRoots: [], backend });
    const record = await runtime.journal.read(barrier.sessionId); proof.journalAfterKill = record;
    assert.equal(record?.phase, mode === 'afterJournal' ? 'settled' : 'spawned', 'Fault must land on the declared durable receipt boundary');
    assert(record?.identity); assert.equal(await identityAlive(record.identity), false, 'CLI must have exited before operator acknowledgement');
    const adapter = new OpenAICompatibleAdapter(localConfig(), { transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as ModelRequest; modelRequests.push(request);
      const role = modelRole(request), check = role === 'check';
      if (role === 'facilitator') {
        const current = active(service!, barrier);
        assert(['succeeded', 'failed', 'cancelled'].includes(current.op.status), 'Coordinator may resume the owner only after trusted physical settlement');
        assert(!current.context.resilience?.cleanup.some(item => item.operationId === barrier.operationId && item.state !== 'settled'));
        assert.equal(current.context.stopped, false); assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x');
        return modelResponse({ type: 'decision', decision: { action: 'continue', reason: '原操作已可信核对，交原负责人依据回执完成交付' } });
      }
      assert(['owner', 'check'].includes(role ?? ''), 'The crash fixture accepts only the original owner, its check and a bounded recovery coordinator');
      if (role === 'owner') assert(request.messages.some(message => message.content.includes(mode === 'afterJournal' ? 'real-effect-receipt' : 'CLI_EFFECTS_RECONCILED')),
        'Parent model must see the original trusted receipt, not ask to execute the command again');
      return modelResponse(withFixtureAcceptance(check ? { type: 'check', passed: true, gaps: [] }
        : { type: 'answer', text: '已依据持久化回执核对隔离账本效果' }, request));
    } });
    const reopen = async () => {
      service = new WebService(localConfig(), join(root, 'team.sqlite'), adapter, undefined, false, runtime);
      await service.ready();
    };
    await reopen();
    if (mode === 'afterJournal') {
      await waitComplete(service!, barrier);
      assert(service!.snapshot(barrier.roomId).events.some(event => event.title === '已核对本地操作回执' && event.detail.includes('real-effect-receipt')));
    } else {
      const first = active(service!, barrier); assert.equal(first.op.status, 'uncertain', 'Unknown CLI effects must remain uncertain');
      assert.equal(first.work.status, 'uncertain'); assert.equal(first.context.candidate, null); assert.equal(modelRequests.length, 0);
      proof.firstResourceContention = await assertUnknownResourceProtection(service!, runtime, root, barrier);
      assert(service!.snapshot(barrier.roomId).events.some(event => event.title === '本地操作等待核对'));
      proof.firstRecovery = { snapshot: service!.snapshot(barrier.roomId), sqlite: sqliteProof(join(root, 'team.sqlite')) };
      await service!.close(); service = undefined; await reopen();
      const second = active(service!, barrier); assert.equal(second.op.status, 'uncertain', 'Repeated recovery must not replay or settle unknown effects');
      assert.equal(modelRequests.length, 0); assert.equal(backend.calls.length, 0, 'Recovery must not execute the non-idempotent CLI again');
      proof.repeatedResourceContention = await assertUnknownResourceProtection(service!, runtime, root, barrier);
      if (mode === 'stopped') service!.stop(barrier.roomId, barrier.taskId, 'stop-before-ack');
      const review = await runtime.reviewOperation(second.work, second.op); assert.equal(review.processState, 'exited');
      const receipt = await runtime.acknowledgeOperation(second.work, second.op, review.reviewDigest); proof.operatorReview = review;
      const response = service!.engine.send(barrier.roomId, barrier.taskId, { type: 'LOCAL_RECONCILE', id: 'trusted-ack', at: Date.now(),
        intentId: barrier.workId, operationId: barrier.operationId, sessionId: barrier.sessionId, ...receipt });
      assert(response.ok, response.code);
      if (mode === 'stopped') {
        const late = service!.engine.send(barrier.roomId, barrier.taskId, { type: 'LOCAL_RESULT', id: 'late-success', at: Date.now(),
          intentId: barrier.workId, operationId: barrier.operationId, sessionId: barrier.sessionId, ...barrier.completion });
        proof.lateReceipt = late;
        assert.equal(active(service!, barrier).context.candidate, null, 'Stopped task must never publish a late CLI result');
      }
      await service!.close(); service = undefined; await reopen();
      if (mode === 'stopped') {
        const stopped = active(service!, barrier); assert.equal(stopped.context.outcome, 'stopped'); assert.equal(stopped.context.candidate, null);
        assert.equal(modelRequests.length, 0, 'Stopped parent must not resume the model');
      } else await waitComplete(service!, barrier);
    }
    const checkRequests = modelRequests.filter(request => modelRole(request) === 'check').length;
    const ownerRequests = modelRequests.filter(request => modelRole(request) === 'owner').length;
    const coordinatorRequests = modelRequests.filter(request => modelRole(request) === 'facilitator').length;
    assert.equal(ownerRequests, mode === 'stopped' ? 0 : 1, 'Trusted receipt must resume the original owner exactly once');
    assert(coordinatorRequests <= 1, 'A settled crash may need at most one successful recovery coordinator, never a retry loop');
    if (mode === 'stopped') assert.equal(coordinatorRequests, 0, 'Stopped parent cannot be resumed through a coordinator');
    assert.equal(checkRequests, mode === 'stopped' ? 0 : 1, 'Receipt recovery must publish through exactly one original candidate check');
    const requestsAfterSettlement = modelRequests.length;
    const settledBeforeRestart = settledProjection(service!, barrier); proof.settledBeforeRestart = settledBeforeRestart;
    await service!.close(); service = undefined; await reopen();
    assert.equal(modelRequests.length, requestsAfterSettlement, 'Repeated recovery of a settled task must not request the model again');
    assert.deepEqual(settledProjection(service!, barrier), settledBeforeRestart,
      'Repeated known-receipt recovery must preserve owner identity, receipt/checkpoint and publication without duplication');
    assert.equal(await readFile(join(root, 'source', 'once.txt'), 'utf8'), 'x', 'Recovery must produce exactly one external ledger effect');
    assert.equal(backend.calls.length, 0, 'All post-crash execution must use the original receipt');
    const final = active(service!, barrier);
    assert.equal(final.work.localOperations!.filter(op => op.action.type === 'runCli').length, 1);
    assert.equal(sqliteProof(join(root, 'team.sqlite')).leases.length, 0, 'Trusted settlement must release the original workspace lease');
    proof.final = { context: final.context, snapshot: service!.snapshot(barrier.roomId), sqlite: sqliteProof(join(root, 'team.sqlite')),
      effectLedger: await readFile(join(root, 'source', 'once.txt'), 'utf8'), modelRequests, ownerRequests, checkRequests, coordinatorRequests,
      backendExecutionsAfterCrash: backend.calls.length };
    proof.status = 'verified';
    return { policy: mode === 'afterJournal' ? '使用原回执' : '核对不确定操作', evidence };
  } catch (error) {
    proof.status = 'failed'; proof.error = String(error);
    proof.modelRequests = modelRequests;
    const barrier = proof.barrier as Barrier | undefined;
    if (service && barrier) proof.failureSnapshot = service.engine.view(barrier.roomId, barrier.taskId);
    throw error;
  }
  finally {
    if (child && !hostExited) { try { const termination = exited(child); process.kill(-child.pid!, 'SIGKILL'); await termination; hostExited = true; } catch { /* Original failure is retained. */ } }
    await service?.close(); await runtime?.close();
    await writeFile(join(evidence, 'host.log'), hostOutput);
    await rm(root, { recursive: true, force: true });
    proof.cleanup = { hostExited, processGroupGone: child?.pid ? processGroupGone(child.pid) : true,
      temporaryDirectoryRemoved: true, runtimeClosed: true, serviceClosed: true };
    await writeFile(join(evidence, 'run.json'), JSON.stringify(proof, null, 2));
  }
}
