import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../src/local-skills.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { sandboxPolicy, minimalCliEnvironment, SandboxCliBackend } from '../src/local-cli.js';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { LocalFixture, assertFlow, removeFixture, writeSkill } from './local-tools-fixture.js';
import { configuration, Harness } from './helpers.js';
const fixtures: LocalFixture[] = [], dirs: string[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); for (const dir of dirs.splice(0)) await removeFixture(dir); });
async function fixture(role?: string) { const f = await LocalFixture.create(role); fixtures.push(f); return f; }
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'squad-registry-')); dirs.push(dir); return dir; }

describe('local skill registry and real child-process integration', () => {
  it('[BT_L01] discovers once, supports top-level links, reports YAML failures and pins resources', async () => {
    const dir = await directory(), roots = join(dir, 'skills'); await mkdir(roots); const source = await writeSkill(roots);
    await symlink(source, join(roots, 'alias')); await mkdir(join(roots, 'broken')); await writeFile(join(roots, 'broken', 'SKILL.md'), '---\nname: [\n---\nbad');
    const registry = await SkillRegistry.discover({ roots: [roots], snapshotRoot: join(dir, 'snapshots') });
    expect(registry.list().skills).toHaveLength(1); expect(registry.diagnostics).toHaveLength(1);
    const skill = await registry.load('local-check'); const ref = await registry.read(skill.skillId, 'references/guide.md', skill.skillVersion);
    expect(ref.content).toContain('真实引用'); await writeFile(join(source, 'references/guide.md'), 'new version');
    expect((await registry.read(skill.skillId, 'references/guide.md', skill.skillVersion)).content).toContain('真实引用');
    expect(registry.catalogVersion).toBe(registry.list().catalogVersion);
  });
  it.each(['方案师', '核查员', 'Builder', '新增成员', '协调员', '最终检查', '后台讨论'])('[BT_L02] %s continues after skill loading and a real script', async role => {
    const f = await fixture(role); const work = await f.flow(); assertFlow(f, work);
  });
  it('[BT_L07] format regeneration uses the original receipt and never repeats a CLI write', async () => {
    const f = await fixture(); f.replies.push(...f.actions(), '{bad', { type: 'answer', text: '已核对真实输出' });
    await f.runner().runOne(f.h.room, f.h.task); expect(f.backend.calls).toHaveLength(1);
    expect(await readFile(join(f.source, 'runs.txt'), 'utf8')).toBe('once\n');
    expect(f.requests.at(-1)!.messages.some(m => m.content.includes('skill-ok'))).toBe(true);
  });
  it('[BT_L08] activation rejects a changed startup version, escapes and ambiguous names', async () => {
    const dir = await directory(), roots = join(dir, 'skills'), other = join(dir, 'other'); await mkdir(roots); await mkdir(other);
    const source = await writeSkill(roots); await writeSkill(other);
    const registry = await SkillRegistry.discover({ roots: [roots, other], snapshotRoot: join(dir, 'snapshots') });
    await expect(registry.load('local-check')).rejects.toThrow('SKILL_AMBIGUOUS');
    const id = registry.list().skills[0]!.skillId; await writeFile(join(source, 'references/guide.md'), 'updated');
    await expect(registry.load(id)).rejects.toThrow('SKILL_VERSION_CHANGED');
    const fresh = await SkillRegistry.discover({ roots: [roots], snapshotRoot: join(dir, 'fresh') }); const loaded = await fresh.load('local-check');
    await expect(fresh.read(loaded.skillId, '../private', loaded.skillVersion)).rejects.toThrow('SKILL_PATH_INVALID');
    await expect(fresh.load(loaded.skillId, 'unknown')).rejects.toThrow('SKILL_VERSION_UNAVAILABLE');
  });
  it('[BT_L09] check and background discussion build in writable copies and pin the tested revision', async () => {
    for (const role of ['最终检查', '后台讨论']) {
      const f = await fixture(role); const work = await f.flow(); assertFlow(f, work);
      await expect(readFile(join(f.source, 'runs.txt'))).rejects.toThrow();
      expect(await readFile(join(f.backend.calls[0]!.workspace, 'dist/result.txt'), 'utf8')).toBe('built');
      await expect(readFile(join(f.backend.calls[0]!.workspace, '.env'))).rejects.toThrow();
      const result = work.localOperations?.at(-1)?.result!; expect(result.data.isolated).toBe(true); expect(result.data.workspaceRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(result.data.outputFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'dist/result.txt' })]));
    }
  });
  it('[BT_L13] constructs deny-by-default policy and never inherits host secrets', async () => {
    const policy = sandboxPolicy({ workspace: '/task', skillPath: '/snapshot' });
    expect(policy.filesystem.denyRead).toContain('/'); expect(policy.network.allowedDomains).toEqual([]); expect(policy.network.deniedDomains).toContain('*');
    const env = minimalCliEnvironment('/task'); expect(env).not.toHaveProperty('OPENAI_API_KEY'); expect(env.HOME).toBe('/task/.home');
    expect(policy.filesystem.allowRead).not.toContain('/root');
    const backend = await SandboxCliBackend.create();
    if (!backend.available) {
      const result = await backend.execute({ executable: '/bin/echo', args: ['never'], cwd: '/task', workspace: '/task', env, timeoutMs: 100, sessionId: 'unavailable', logPath: '/unused' }, new AbortController().signal, async () => { throw new Error('must not spawn'); });
      expect(result.result.code).toBe('CLI_SANDBOX_UNAVAILABLE');
    }
    await backend.close();
  });
});
