import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCatalog, parseCliCatalog, type CliCatalogEntry } from '../src/cli-catalog.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { SkillRegistry } from '../src/local-skills.js';
import type { discoverHostCapabilities } from '../src/host-capabilities.js';
import { LocalFixture, writeSkill } from './local-tools-fixture.js';

const entry: CliCatalogEntry = { command: 'node', description: 'Read documents from the documented source', domains: ['docs.example.com'],
  helpArgs: ['--version'], examples: [{ description: 'Print installed runtime version before choosing compatible arguments', args: ['--version'] }],
  execution: 'sandbox', requirements: ['No login needed for --version; remote documents need separate network access'] };
type Report = Awaited<ReturnType<typeof discoverHostCapabilities>>;
async function withCatalog(run: (f: LocalFixture) => Promise<void>, entries: CliCatalogEntry[] = [entry]) {
  const f = await LocalFixture.create();
  try {
    await f.runtime.close(); f.runtime = await LocalRuntime.create({ ...f.runtime.options, cliCatalog: entries });
    await run(f);
  } finally { await f.close(); }
}
export async function catalogLookupAcceptance(query: string) {
  let report!: Report;
  await withCatalog(async f => {
    f.replies.push({ type: 'discoverHost', query }, { type: 'answer', text: '已经找到可复用的读取命令。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const op = f.h.context().intents.find(work => work.kind === 'owner')!.localOperations![0]!;
    assert.equal(op.status, 'succeeded'); report = op.result!.data as unknown as Report;
    assert.deepEqual(report.cli.catalog!.entries, [entry]);
    assert.deepEqual(report.cli.commands, [{ command: 'node', sandbox: 'found', host: 'found' }]);
    assert.equal(f.backend.calls.length, 0);
    assert.equal(f.h.context().usage.ordinary, 2);
  });
  return report;
}
export async function catalogExplicitAcceptance() {
  await withCatalog(async f => {
    f.replies.push({ type: 'discoverHost', query: 'uninstalled', commands: ['node'] }, { type: 'answer', text: '已区分缺失命令与当前可见命令。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const report = f.h.context().intents[0]!.localOperations![0]!.result!.data as unknown as Report;
    assert.deepEqual(report.cli.commands, [{ command: 'node', sandbox: 'found', host: 'found' },
      { command: 'squad-uninstalled-catalog-command', sandbox: 'not_found', host: 'not_found' }]);
    assert.equal(report.cli.hostApprovalRequired, true); assert.equal(report.cli.presenceIsNotExecution, true);
    assert.equal(f.backend.calls.length, 0);
  }, [{ command: 'squad-uninstalled-catalog-command', description: 'uninstalled document reader', execution: 'host' }]);
}
export function catalogInvalidConfigAcceptance(problem: string) {
  const values: Record<string, unknown> = {
    命令路径: [{ ...entry, command: '/bin/node' }],
    重复命令: [entry, entry],
    额外凭据字段: [{ ...entry, token: 'must-never-be-exposed' }],
    超出目录上限: Array.from({ length: 201 }, (_, i) => ({ command: `cmd-${i}`, description: 'reader' })),
    说明超出单条上限: [{ ...entry, helpArgs: ['x'.repeat(8192)] }],
  };
  assert.throws(() => parseCliCatalog(values[problem]), /CLI_CATALOG_INVALID/);
}
async function withSkills(run: (registry: SkillRegistry, root: string) => Promise<void>, count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'squad-catalog-'));
  try {
    const skills = join(root, 'source-bank'); await mkdir(skills);
    for (let i = 0; i < count; i++) {
      const name = `reader-${String(i).padStart(2, '0')}`;
      const path = await writeSkill(skills, name, i === 1 ? 'Edit documents' : 'Read documents');
      await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${i === 1 ? 'Edit' : 'Read'} documents\ncompatibility: ${i === 1 ? 'Windows' : 'Linux'}\n---\nDocumentation\n`);
    }
    const registry = await SkillRegistry.discover({ roots: [skills], snapshotRoot: join(root, 'snapshots') });
    assert.equal(registry.list().complete, true); await run(registry, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function skillSearchAcceptance() {
  await withSkills(async registry => {
    const page = registry.list({ query: 'LINUX source-bank documents' });
    assert.deepEqual(page.skills.map(skill => skill.name), ['reader-00']);
    assert.deepEqual(registry.list({ query: 'documents Linux source-bank' }).skills, page.skills);
    assert.equal(registry.list({ query: 'Linux Edit' }).skills.length, 0);
  });
}
function cliPages() {
  const entries = Array.from({ length: 25 }, (_, i) => ({ command: `reader-${String(i).padStart(2, '0')}`, description: `read documents ${'x'.repeat(1880)}` }));
  return { entries, catalog: new CliCatalog(entries) };
}
export async function catalogPaginationAcceptance(kind: string) {
  if (kind === '宿主命令目录') {
    const { catalog, entries } = cliPages();
    const first = catalog.list({ query: 'documents' }); assert.equal(first.entries.length, 20); assert(first.nextCursor);
    const second = catalog.list({ query: 'documents', cursor: first.nextCursor }); assert.equal(second.entries.length, 5); assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.entries, ...second.entries], entries);
    assert.throws(() => catalog.list({ query: 'reader', cursor: first.nextCursor! }), /CLI_CATALOG_CURSOR_INVALID/);
    const updated = new CliCatalog([...entries, { command: 'reader-new', description: 'read documents' }]);
    assert.throws(() => updated.list({ query: 'documents', cursor: first.nextCursor! }), /CLI_CATALOG_CURSOR_INVALID/);
    await withCatalog(async f => {
      f.replies.push({ type: 'discoverHost', query: 'documents' }, { type: 'discoverHost', query: 'documents', cursor: first.nextCursor },
        { type: 'answer', text: '已完整取得命令目录两页。' });
      await f.runner().runOne(f.h.room, f.h.task);
      const operations = f.h.context().intents[0]!.localOperations!;
      assert.equal(operations.length, 2); assert(operations.every(op => op.result?.ok && op.result.code === 'discoverHost'));
      const pages = operations.map(op => (op.result!.data as unknown as Report).cli.catalog!);
      assert.deepEqual(pages.flatMap(page => page.entries), entries);
      assert.equal(pages[0]!.nextCursor, first.nextCursor); assert.equal(pages[1]!.nextCursor, null);
    }, entries);
    return;
  }
  await withSkills(async (registry, root) => {
    const first = registry.list({ query: 'documents' }); assert.equal(first.skills.length, 20); assert(first.nextCursor);
    const second = registry.list({ query: 'documents', cursor: first.nextCursor }); assert.equal(second.skills.length, 5); assert.equal(second.nextCursor, null);
    const ids = [...first.skills, ...second.skills].map(skill => skill.skillId);
    assert.equal(new Set(ids).size, 25); assert.deepEqual(ids, [...first.skills, ...second.skills].map(skill => registry.resolveId(skill.name)));
    assert.throws(() => registry.list({ query: 'reader', cursor: first.nextCursor! }), /SKILL_CURSOR_INVALID/);
    await writeFile(join(root, 'source-bank', 'reader-00', 'references', 'guide.md'), 'Updated version');
    const updated = await SkillRegistry.discover({ roots: [join(root, 'source-bank')], snapshotRoot: join(root, 'snapshots') });
    assert.throws(() => updated.list({ query: 'documents', cursor: first.nextCursor! }), /SKILL_CURSOR_INVALID/);
  }, 25);
}
export async function catalogForgedCursorAcceptance(kind: string) {
  if (kind === '宿主命令目录') {
    assert.throws(() => cliPages().catalog.list({ cursor: '20' }), /CLI_CATALOG_CURSOR_INVALID/); return;
  }
  await withSkills(async registry => { assert.throws(() => registry.list({ cursor: '20' }), /SKILL_CURSOR_INVALID/); });
}
export async function catalogModelLoopAcceptance() {
  await withCatalog(async f => {
    f.replies.push({ type: 'discoverHost', query: 'read documents' },
      { type: 'runCli', executable: 'node', args: ['--version'] }, { type: 'answer', text: '已按宿主说明验证命令版本。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const work = f.h.context().intents[0]!;
    assert.deepEqual(work.localOperations!.map(op => [op.action.type, op.status]), [['discoverHost', 'succeeded'], ['runCli', 'succeeded']]);
    assert.equal(f.backend.calls.length, 1); assert.deepEqual(f.backend.calls[0]!.args, entry.helpArgs);
    assert(f.requests[1]!.messages.some(message => message.content.includes('docs.example.com') && message.content.includes('helpArgs')));
    assert(f.requests[2]!.messages.some(message => message.content.includes(process.version)));
    assert.equal(f.h.context().usage.ordinary, 4);
    await assert.rejects(readFile(join(f.source, 'dist', 'runs.txt')), { code: 'ENOENT' });
  });
}
