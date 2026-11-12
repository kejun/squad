import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillRegistry } from '../src/local-skills.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { TeamEngine, MemoryStore } from '../src/index.js';
import { createTeamConfig } from '../team.config.js';
import type { CliBackend, CliInvocation } from '../src/local-cli.js';
import type { LocalAction } from '../src/local-operation.js';
import type { Intent } from '../src/types.js';

const root = process.env.PREPARATION_ROOT;
assert(root, 'An isolated preparation root is required');
const kind = process.argv[2];
const body = '---\nname: preparation-check\ndescription: Preparation fixture\n---\nRead references/guide.md before scripts/run.mjs.\n';
const guide = 'immutable preparation guide';
const script = 'throw new Error("preparation must never run this script");\n';
async function readonlyTree(path: string): Promise<void> {
  assert.equal((await stat(path)).mode & 0o222, 0, `Published skill directory must be read-only: ${path}`);
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await readonlyTree(join(path, entry.name));
}
async function verifySkill(registry: SkillRegistry) {
  const catalog = registry.list().skills[0]; assert(catalog);
  const results = await Promise.all(Array.from({ length: 4 }, async () => {
    const loaded = await registry.load(catalog.skillId);
    assert.equal(loaded.content, body);
    const resource = await registry.read(loaded.skillId, 'references/guide.md', loaded.skillVersion);
    const code = await registry.read(loaded.skillId, 'scripts/run.mjs', loaded.skillVersion);
    assert.equal(resource.content, guide); assert.equal(code.content, script);
    assert.equal(resource.skillVersion, loaded.skillVersion); assert.equal(code.skillVersion, loaded.skillVersion);
    const snapshot = await registry.snapshot(loaded.skillId, loaded.skillVersion);
    await readonlyTree(snapshot.path);
    return { id: loaded.skillId, version: loaded.skillVersion, body: loaded.content, guide: resource.content, script: code.content };
  }));
  assert(results.every(item => item.version === results[0]!.version));
  return { callers: results.length, version: results[0]!.version, contents: 'complete', directories: 'read-only' };
}
async function skills() {
  const registry = await SkillRegistry.discover({ roots: [join(root!, 'skills')], snapshotRoot: join(root!, 'snapshots') });
  if (process.env.PREPARATION_EXPECT_CHANGE === 'yes') {
    const id = registry.list().skills[0]!.skillId;
    const attempted = await Promise.allSettled([registry.load(id), registry.load(id)]);
    assert(attempted.every(result => result.status === 'rejected' && String(result.reason).includes('SKILL_VERSION_CHANGED')),
      'A changed source must reject every in-progress activation rather than return mixed versions');
    process.send?.({ type: 'retry-ready', reason: 'all concurrent activations rejected the changed version' });
    await new Promise<void>(done => {
      const release = (message: { type?: string }) => { if (message?.type === 'retry') { process.off('message', release); done(); } };
      process.on('message', release);
    });
  }
  return verifySkill(registry);
}
async function workspace() {
  const checking = kind === 'check-workspace';
  const store = new MemoryStore(); const config = createTeamConfig({}); config.inputAnalysis = { enabled: false };
  const engine = new TeamEngine(store, config, () => 0); const room = 'preparation';
  const submitted = engine.submit(room, { id: 'begin', text: checking ? '运行 npm run build' : '形成方案' }); assert(submitted.ok);
  const task = submitted.taskId!; const initial = engine.claim(room, task, engine.pending(room, task)[0]!.id); assert(initial);
  let work: Intent;
  if (checking) {
    assert(engine.send(room, task, { id: 'deliver', at: 0, type: 'DELIVER', workId: initial.id, attempt: initial.attempt, fence: initial, text: '待检查候选', artifactIds: [] }).ok);
    work = engine.claim(room, task, engine.pending(room, task).find(item => item.kind === 'check')!.id)!; assert.equal(work.kind, 'check');
  } else {
    assert(engine.send(room, task, { id: 'review', at: 0, type: 'USER_INPUT', text: '请B检查资料', reviewTargets: ['B'] }).ok);
    const planner = engine.claim(room, task, engine.pending(room, task).find(item => item.kind === 'facilitator')!.id); assert(planner);
    assert(engine.send(room, task, { id: 'plan', at: 0, type: 'DISCUSSION_PLAN', workId: planner.id, attempt: planner.attempt, fence: planner,
      discussionId: planner.discussionId!, decision: { action: 'review', question: '检查资料', expected: '保留资料', reason: '直接用户请求' } }).ok);
    work = engine.claim(room, task, engine.pending(room, task).find(item => item.kind === 'assistance')!.id)!; assert(work.discussionId);
  }
  const observed: { input?: CliInvocation; complete?: boolean; missing?: string[] } = {};
  const backend: CliBackend = { available: true, execute: async input => {
    observed.input = input;
    const missing: string[] = [];
    for (const name of ['a.txt', 'z.txt']) {
      try { assert.equal(await readFile(join(input.workspace, name), 'utf8'), name === 'a.txt' ? 'alpha' : 'omega'); } catch { missing.push(name); }
    }
    for (const path of [input.env.HOME!, input.env.TMPDIR!]) {
      try { assert((await stat(path)).isDirectory()); } catch { missing.push(path.split('/').at(-1)!); }
    }
    if (checking) {
      assert.equal(input.cwd, input.workspace, 'The user-authorized check action must keep its default cwd');
      assert.deepEqual(input.writeRoots!.map(path => path.split('/').at(-1)).sort(), ['.home', '.tmp', 'coverage', 'dist', 'reports', 'test-results']);
      for (const path of input.writeRoots!) {
        try { assert((await stat(path)).isDirectory()); } catch { missing.push(path.split('/').at(-1)!); }
      }
      try { assert.equal(await readFile(join(input.workspace, 'build.mjs'), 'utf8'), 'console.log("build-fixture");\n'); } catch { missing.push('build.mjs'); }
    }
    observed.complete = missing.length === 0; observed.missing = missing;
    return { result: { ok: observed.complete, code: observed.complete ? 'PREPARATION_COMPLETE' : 'PREPARATION_INCOMPLETE', data: { missing, noProcessSpawned: true } }, settled: true, effectsKnown: true };
  } };
  // The controlled preparation backend does not need machine-dependent tool discovery.
  const runtime = await LocalRuntime.create({ dataRoot: join(root!, 'runtime'), skillRoots: [], cliCatalog: [], workspaceRoot: join(root!, 'source'), backend, clock: () => 0 });
  try {
    const execute = async (suffix: string) => {
      const plan = work.payload.verification as { status: string; action: LocalAction } | undefined;
      if (checking) assert.equal(plan?.status, 'required');
      const action: LocalAction = checking ? plan!.action : { type: 'runCli', executable: process.execPath, args: [] };
      const op = engine.requestLocal(room, task, work.id, work.attempt, action, [], runtime.workspaceId(work));
      const claim = engine.claimLocal(room, task, work.id, op.id, work.attempt); assert(claim.response.ok && claim.operation);
      const result = await runtime.execute(work, claim.operation, new AbortController().signal, metadata => {
        assert(engine.send(room, task, { id: `started-${suffix}`, at: 0, type: 'LOCAL_STARTED', intentId: work.id, operationId: op.id, sessionId: claim.operation!.sessionId!, ...metadata }).ok);
      });
      assert(engine.send(room, task, { id: `result-${suffix}`, at: 0, type: 'LOCAL_RESULT', intentId: work.id, operationId: op.id, sessionId: claim.operation.sessionId!, ...result }).ok);
      return result;
    };
    if (process.env.PREPARATION_EXPECT_CHANGE === 'yes') {
      const failed = await execute('failed'); assert.equal(failed.result.code, 'WORKSPACE_REVISION_CHANGED'); assert.equal(observed.input, undefined);
      process.send?.({ type: 'retry-ready', reason: 'the changed workspace was not passed to execution' });
      await new Promise<void>(done => {
        const release = (message: { type?: string }) => { if (message?.type === 'retry') { process.off('message', release); done(); } };
        process.on('message', release);
      });
    }
    const result = await execute('complete');
    assert.equal(result.result.code, 'PREPARATION_COMPLETE', `Execution boundary must receive a complete isolated copy: ${JSON.stringify(result.result)}`);
    assert(result.result.ok); assert.equal(result.isolated, true); assert.notEqual(observed.input!.workspace, join(root!, 'source'));
    await assert.rejects(access(join(observed.input!.workspace, '.env')));
    assert.equal(await readFile(join(root!, 'source', 'a.txt'), 'utf8'), 'alpha');
    return { workId: work.id, kind: work.kind, isolated: result.isolated, contents: 'complete', scratch: 'ready',
      validationOutputs: checking ? 'all four ready before backend' : 'not applicable', source: 'unchanged', processSpawned: false };
  } finally { await runtime.close(); store.close(); }
}
try {
  const result = kind === 'skill' ? await skills() : await workspace();
  process.send?.({ type: 'complete', result });
  process.disconnect?.();
} catch (error) {
  const failure = { name: error instanceof Error ? error.name : 'Error', message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.send?.({ type: 'failure', failure }); process.exitCode = 1; process.disconnect?.();
}
