import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { LocalRuntime } from '../src/local-runtime.js';
import { identityAlive, processIdentity } from '../src/local-cli.js';
import { SkillRegistry } from '../src/local-skills.js';
import { WebService } from '../src/web/service.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { localConfig, removeFixture, writeSkill } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

const execute = promisify(execFile);
const rootDirectory = async () => realpath(await mkdtemp(join(tmpdir(), 'squad-native-')));

export async function nativeStartupAcceptance() {
  const root = await rootDirectory(); let runtime: LocalRuntime | undefined, service: WebService | undefined;
  try {
    const skills = join(root, 'skills'), source = join(root, 'source'); await mkdir(skills); await mkdir(source); await writeSkill(skills);
    runtime = await LocalRuntime.create({ dataRoot: join(root, 'runtime'), skillRoots: [skills], workspaceRoot: source });
    assert(runtime.backend.available, runtime.backend.unavailableReason);
    const id = runtime.catalog().skills[0]!.skillId;
    const replies = [{ type: 'loadSkill', skillId: id }, { type: 'readSkillResource', skillId: id, path: 'references/guide.md' },
      { type: 'runCli', executable: 'node', args: ['@skill/scripts/run.mjs'], skillId: id },
      { type: 'deliver', text: '原生沙箱命令已完成', artifactIds: [] }, { type: 'check', passed: true, gaps: [] }];
    const config = localConfig(); let calls = 0;
    const adapter = new OpenAICompatibleAdapter(config, { env: {}, transport: async () => modelResponse(replies[calls++]) });
    service = new WebService(config, join(root, 'team.sqlite'), adapter, undefined, true, runtime); await service.ready();
    const room = service.createRoom('原生本地工具验收'); service.submit(room.id, { id: 'native', text: '执行本地验证' });
    for (let n = 0; n < 200 && service.snapshot(room.id).tasks[0]?.outcome !== 'complete'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const snapshot = service.snapshot(room.id);
    assert.equal(snapshot.tasks[0]?.outcome, 'complete', JSON.stringify(snapshot.events.filter(event => event.kind === 'error')));
    assert(snapshot.events.some(event => event.detail.includes('skill-ok')));
    assert.equal(snapshot.events.filter(event => event.kind === 'error').length, 0);
    assert.equal(await readFile(join(source, 'dist/runs.txt'), 'utf8'), 'once\n');
    const context = service.engine.view(room.id, snapshot.tasks[0]!.id)!.context;
    const operations = context.intents.flatMap(work => work.localOperations ?? []);
    assert.deepEqual(operations.map(op => op.status), ['succeeded', 'succeeded', 'succeeded']);
    assert(operations.every(op => op.attempt === 1 && op.result?.ok));
    assert.equal((await processIdentity(process.pid)).platform, process.platform);
  } finally { await service?.close(); await runtime?.close(); await removeFixture(root); }
}

export async function nativeIdentityAcceptance() {
  const root = await rootDirectory(); let runtime: LocalRuntime | undefined;
  const dataRoot = join(root, 'runtime'), lock = join(dataRoot, 'service.lock');
  const backend = { available: false, execute: async () => { throw new Error('lock inspection cannot execute CLI'); } };
  try {
    const identity = await processIdentity(process.pid);
    assert.equal(await identityAlive(identity), true);
    const oldStart = process.platform === 'darwin' ? '1:1' : '1';
    assert.equal(await identityAlive({ ...identity, startTime: oldStart }), false);
    assert.equal(await identityAlive({ ...identity, bootId: '00000000-0000-0000-0000-000000000000' }), false);
    assert.equal(await identityAlive({ ...identity, platform: process.platform === 'darwin' ? 'linux' : 'darwin' }), 'unknown');
    assert.equal(await identityAlive({ ...identity, procPid: '../invalid' }), 'unknown');
    runtime = await LocalRuntime.create({ dataRoot, skillRoots: [], backend });
    await assert.rejects(LocalRuntime.create({ dataRoot, skillRoots: [], backend }), /LOCAL_RUNTIME_IN_USE/);
    await runtime.close(); runtime = undefined;
    await writeFile(lock, JSON.stringify({ token: 'old', identity: { ...identity, startTime: oldStart } }));
    runtime = await LocalRuntime.create({ dataRoot, skillRoots: [], backend }); await runtime.close(); runtime = undefined;
    await writeFile(lock, JSON.stringify({ token: 'unknown', identity: { ...identity, platform: 'unsupported' } }));
    await assert.rejects(LocalRuntime.create({ dataRoot, skillRoots: [], backend }), /LOCAL_RUNTIME_IN_USE/);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'unknown'); await rm(lock);
    if (process.platform === 'darwin') {
      // Deny only the host identity probe in a child; production code must fail before creating a lock.
      const code = `import {LocalRuntime} from ${JSON.stringify(new URL('../src/local-runtime.ts', import.meta.url).href)};
        import {existsSync} from 'node:fs';let failed=false;
        try{await LocalRuntime.create({dataRoot:${JSON.stringify(dataRoot)},skillRoots:[],backend:{available:false,execute:async()=>{throw Error()}}})}catch{failed=true}
        console.log(JSON.stringify({failed,lock:existsSync(${JSON.stringify(lock)})}));`;
      const loader = createRequire(import.meta.url).resolve('tsx');
      const { stdout } = await execute('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny process-exec (literal "/usr/bin/python3"))',
        process.execPath, '--import', loader, '--input-type=module', '-e', code], { timeout: 8000, env: { PATH: process.env.PATH, HOME: root } });
      assert.deepEqual(JSON.parse(stdout), { failed: true, lock: false });
    }
    await assert.rejects(access(lock));
  } finally { await runtime?.close(); await removeFixture(root); }
}

export async function nativePathAcceptance() {
  const root = await rootDirectory();
  try {
    const skills = join(root, 'skills'); await mkdir(skills); await writeSkill(skills);
    await symlink(skills, join(root, 'skill-alias'));
    await mkdir(join(root, 'snapshots')); await symlink(join(root, 'snapshots'), join(root, 'snapshot-alias'));
    const registry = await SkillRegistry.discover({ roots: [join(root, 'skill-alias')], snapshotRoot: join(root, 'snapshot-alias') });
    const skill = await registry.load('local-check');
    assert((await registry.read(skill.skillId, 'references/guide.md', skill.skillVersion)).content.includes('真实引用'));
    await assert.rejects(registry.read(skill.skillId, '../private', skill.skillVersion), /SKILL_PATH_INVALID/);
    await writeFile(join(root, 'private'), 'must-not-read'); await symlink(join(root, 'private'), join(skills, 'local-check/escape'));
    const escaped = await SkillRegistry.discover({ roots: [skills], snapshotRoot: join(root, 'other-snapshots') });
    assert.equal(escaped.list().skills.length, 0); assert(escaped.diagnostics.some(d => d.code === 'SKILL_PATH_ESCAPE'));
  } finally { await removeFixture(root); }
}

export async function nativeSandboxAcceptance() {
  const { stdout } = await execute(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), resolve('scripts/verify-local-sandbox.ts')],
    { timeout: 15_000, maxBuffer: 32_000 });
  assert(stdout.includes('OS sandbox file, snapshot-write, credential, network, check-source and cancellation boundaries passed'));
}
