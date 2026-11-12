import { withFixtureAcceptance } from './delivery-protocol-fixture.js';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRuntime } from '../src/local-runtime.js';
import { runProcess, type CliBackend, type CliInvocation, type ProcessIdentity } from '../src/local-cli.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import type { LocalAction } from '../src/local-operation.js';
import { configuration, Harness } from './helpers.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { SqliteStore } from '../src/store.js';
import type { Intent, TeamConfig } from '../src/types.js';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { SandboxCliBackend } from '../src/local-cli.js';
import type { CliAcquisitionReader } from '../src/acquisition-readers.js';
import type { CliCatalogEntry } from '../src/cli-catalog.js';

// Isolated fixtures verify local builds, never npm's own network update check.
export const localFixtureCommandEnv = { npm: { NPM_CONFIG_UPDATE_NOTIFIER: 'false' } };

export const skillScript = `import fs from 'node:fs';
fs.mkdirSync('dist', {recursive:true}); fs.appendFileSync('dist/runs.txt', 'once\\n');
fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/result.txt','built');
fs.mkdirSync('test-results', {recursive:true}); fs.writeFileSync('test-results/result.txt','passed');
console.log('skill-ok');`;
export async function writeSkill(root: string, name = 'local-check', description = '验证工程的本地技能') {
  const path = join(root, name); await mkdir(join(path, 'scripts'), { recursive: true }); await mkdir(join(path, 'references'), { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n先读取 references/guide.md，再运行 scripts/run.mjs。\n`);
  await writeFile(join(path, 'references/guide.md'), '真实引用资料；不得扩大宿主权限。'); await writeFile(join(path, 'scripts/run.mjs'), skillScript);
  return path;
}
export function localConfig(): TeamConfig {
  const config = configuration(); config.inputAnalysis = { enabled: false };
  config.models = { default: 'local-model', services: { 'local-model': { baseUrl: 'https://local-model.example/v1', model: 'fixture' } } };
  return config;
}
/** Only process lifecycle is real here. This explicitly injected fixture makes NO OS isolation claim. */
export class ControlledProcessBackend implements CliBackend {
  readonly available = true; calls: CliInvocation[] = []; before?: ((input: CliInvocation) => void) | undefined;
  async execute(input: CliInvocation, signal: AbortSignal, onSpawn: (identity: ProcessIdentity) => Promise<void>) {
    this.calls.push(input); this.before?.(input); return runProcess(input, signal, onSpawn);
  }
}
/** Force the external dependency boundary to fail; never depend on the host lacking a sandbox. */
export async function unavailableNativeSandbox() {
  const original = SandboxManager.checkDependenciesAsync;
  SandboxManager.checkDependenciesAsync = async () => ({ errors: ['controlled missing dependency'], warnings: [] });
  try { return await SandboxCliBackend.create(); }
  finally { SandboxManager.checkDependenciesAsync = original; }
}
export class LocalFixture {
  readonly backend = new ControlledProcessBackend();
  readonly requests: { messages: { role: string; content: string }[] }[] = [];
  readonly replies: unknown[] = [];
  beforeModelResponse?: ((request: LocalFixture['requests'][number], index: number) => Promise<void>) | undefined;
  runtime!: LocalRuntime; h!: Harness; source!: string; skills!: string; skillId!: string;
  private constructor(readonly root: string) {}
  static async create(role = '方案师', sqlite = false, serviceClock = false, options: { backend?: CliBackend; ordinaryLimit?: number;
    runtimeOptions?: { acquisitionReaders?: CliAcquisitionReader[]; cliCatalog?: CliCatalogEntry[] } } = {}): Promise<LocalFixture> {
    const f = new LocalFixture(await mkdtemp(join(tmpdir(), 'squad-local-')));
    f.source = join(f.root, 'source'); f.skills = join(f.root, 'skills'); await mkdir(f.source); await mkdir(f.skills); await writeSkill(f.skills);
    await writeFile(join(f.source, 'source.txt'), 'authoritative'); await writeFile(join(f.source, '.env'), 'SECRET_FILE=do-not-copy');
    const config = localConfig();
    if (options.ordinaryLimit !== undefined) config.limits.ordinary = options.ordinaryLimit;
    if (serviceClock) { config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000; }
    if (role === '核查员') config.defaultBot = 'B';
    if (role === 'Builder') config.defaultBot = 'builder-1';
    if (role === '新增成员') { config.bots.push({ id: 'new-bot', name: '新增成员', instructions: '', tools: [] }); config.defaultBot = 'new-bot'; }
    f.h = new Harness(config, sqlite ? new SqliteStore(join(f.root, 'team.sqlite')) : undefined, serviceClock ? Date.now() : 0);
    if (role === '最终检查') {
      await writeFile(join(f.source, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node build.mjs' } }));
      await writeFile(join(f.source, 'build.mjs'), skillScript);
      assert(f.h.event({ type: 'USER_INPUT', text: '运行 npm run build' }).ok);
      const owner = f.h.claim('owner');
      assert(f.h.event({ type: 'DELIVER', workId: owner.id, fence: owner, text: 'candidate', artifactIds: [] }).ok);
    }
    if (role === '协调员') f.h.event({ type: 'BLOCKED', reason: '需要协调' });
    if (role === '后台讨论') {
      f.h.claim(); f.h.event({ type: 'USER_INPUT', text: '所有人参与讨论', reviewTargets: ['B'] });
      const coordinator = f.h.claim('facilitator'); f.h.event({ type: 'DISCUSSION_PLAN', workId: coordinator.id, fence: coordinator, discussionId: coordinator.discussionId!,
        decision: { action: 'review', question: '验证', expected: '证据', reason: '直接邀请' } });
    }
    f.runtime = await LocalRuntime.create({ dataRoot: join(f.root, 'runtime'), skillRoots: [f.skills], workspaceRoot: f.source,
      // Unrelated process fixtures intentionally hold catalog metadata outside their slice.
      cliCatalog: [],
      commandEnv: localFixtureCommandEnv,
      backend: options.backend ?? f.backend, clock: () => f.h.now, redact: ['host-model-secret'], ...options.runtimeOptions });
    f.skillId = f.runtime.catalog().skills[0]!.skillId;
    f.backend.before = () => {
      const current = f.h.context().intents.flatMap(w => w.localOperations ?? []).find(o => o.status === 'running');
      assert(current, 'process I/O must follow persisted LOCAL_STARTED'); assert.equal(current.action.type, 'runCli');
    };
    return f;
  }
  actions(): LocalAction[] { return [{ type: 'loadSkill', skillId: this.skillId }, { type: 'readSkillResource', skillId: this.skillId, path: 'references/guide.md' },
    { type: 'runCli', executable: 'node', args: ['@skill/scripts/run.mjs'], skillId: this.skillId }]; }
  runner(final?: unknown) {
    const adapter = new OpenAICompatibleAdapter(this.h.config, { clock: () => this.h.now, transport: async (_url, init) => {
      this.requests.push(JSON.parse(String(init?.body)) as typeof this.requests[number]);
      await this.beforeModelResponse?.(this.requests.at(-1)!, this.requests.length - 1);
      assert(this.replies.length || final, 'scripted model exhausted'); return modelResponse(withFixtureAcceptance(this.replies.length ? this.replies.shift() : final, this.requests.at(-1)));
    } });
    return new WorkRunner(this.h.engine, adapter, () => this.h.now, globalThis.fetch, undefined, this.runtime);
  }
  async flow() {
    const work = this.h.engine.pending(this.h.room, this.h.task).find(w => w.kind !== 'cancel')!;
    const final = work.kind === 'check' ? { type: 'check', passed: true, gaps: [] } : work.kind === 'facilitator'
      ? { type: 'decision', decision: { action: 'continue', reason: '已验证' } } : { type: 'answer', text: '真实 CLI 验证完成' };
    this.replies.push(...(work.kind === 'check' ? [] : this.actions()), final);
    await this.runner().runOne(this.h.room, this.h.task, work.id);
    return this.h.context().intents.find(w => w.id === work.id)!;
  }
  async close() { await this.runtime?.close(); this.h?.store.close(); await removeFixture(this.root); }
}
export function assertFlow(f: LocalFixture, work: Intent) {
  assert.equal(f.backend.calls.length, 1);
  if (work.kind === 'check') {
    assert.deepEqual(work.localOperations?.map(op => op.action.type), ['runCli', 'verifyWorkspace']);
    assert(work.localOperations!.every(op => op.status === 'succeeded' && op.attempt === 1 && op.result?.ok));
    assert.equal(f.requests.length, 1);
    assert(f.requests[0]!.messages.some(message => message.content.includes('skill-ok')));
    assert.equal(f.h.context().usage.ordinary, 3);
    assert.equal(f.h.context().usage.checks, 1);
    assert.equal(f.h.context().outcome, 'complete');
    return;
  }
  assert.equal(work.localOperations?.length, 3);
  assert(work.localOperations.every(o => o.status === 'succeeded' && o.attempt === 1 && o.result?.ok));
  assert(work.localCheckpoint?.messages.some(m => m.content.includes('skill-ok')));
  assert(f.requests.at(-1)?.messages.some(m => m.content.includes('skill-ok')));
  assert.equal(f.requests.length, 4);
  assert.equal(f.h.context().usage.ordinary, work.discussionId ? 9 : 7);
  assert.equal(f.h.context().usage.checks, 0);
}

export async function removeFixture(path: string): Promise<void> {
  async function writable(dir: string) { for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(dir, entry.name)); await chmod(dir, 0o700); }
  await writable(path); await rm(path, { recursive: true, force: true });
}
