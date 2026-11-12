import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCatalog, type CliCatalogEntry } from '../src/cli-catalog.js';
import { ToolInventoryStore } from '../src/tool-inventory.js';
import { withToolInventoryReadiness } from '../src/cli-readiness.js';
import { SkillRegistry } from '../src/local-skills.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { LocalFixture, writeSkill } from './local-tools-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import { inventoryObservation } from './tool-inventory-observation.js';

async function automaticFixture(documented = true, unrelatedManual = false) {
  const clock = { now: 100 };
  const root = await mkdtemp(join(tmpdir(), 'squad-auto-catalog-'));
  const bin = join(root, 'bin'), pkg = join(root, 'reader-package');
  await mkdir(bin); await mkdir(join(pkg, 'bin'), { recursive: true });
  const marker = join(root, 'must-not-run');
  const executable = join(pkg, 'bin', 'squad-auto-reader');
  await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`); await chmod(executable, 0o755);
  await symlink(executable, join(bin, 'squad-auto-reader'));
  const description = 'Extract printed text from images for searchable document archives';
  const sandboxDescription = 'Inspect local image dimensions without contacting a service';
  if (documented) await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'squad-reader-fixture', version: '1.0.0',
    description, bin: { 'squad-auto-reader': 'bin/squad-auto-reader' } }));
  const sandboxBin = join(root, 'sandbox-bin'), sandboxPackage = join(root, 'sandbox-package');
  if (documented) {
    await mkdir(sandboxBin); await mkdir(join(sandboxPackage, 'bin'), { recursive: true });
    const executable = join(sandboxPackage, 'bin', 'squad-auto-reader');
    await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`); await chmod(executable, 0o755);
    await symlink(executable, join(sandboxBin, 'squad-auto-reader'));
    await writeFile(join(sandboxPackage, 'package.json'), JSON.stringify({ name: 'sandbox-reader-fixture', version: '2.0.0',
      description: sandboxDescription, bin: { 'squad-auto-reader': 'bin/squad-auto-reader' } }));
  }
  const manualRoot = join(root, 'other-installation', 'share', 'man');
  const systemBin = join(root, 'other-installation', 'bin');
  if (unrelatedManual) {
    await mkdir(join(manualRoot, 'man1'), { recursive: true }); await mkdir(systemBin);
    await writeFile(join(manualRoot, 'man1', 'squad-auto-reader.1'), '.SH NAME\nsquad-auto-reader \\- read system accounting ledger records\n.SH DESCRIPTION\nSystem accounting reader.\n');
    await writeFile(join(systemBin, 'squad-auto-reader'), `#!/bin/sh\nprintf ran > '${marker}'\n`);
    await chmod(join(systemBin, 'squad-auto-reader'), 0o755);
    const packageRoot = join(root, 'no-system-packages'); await mkdir(join(packageRoot, 'info'), { recursive: true });
    await writeFile(join(packageRoot, 'status'), 'Package: squad-man-fixture\nStatus: install ok installed\nVersion: 1.0.0\nDescription: Generic package summary must not replace a command-specific manual\n');
    await writeFile(join(packageRoot, 'info', 'squad-man-fixture.list'), `${join(systemBin, 'squad-auto-reader')}\n${join(manualRoot, 'man1', 'squad-auto-reader.1')}\n`);
  }
  const options = { dataRoot: join(root, 'runtime'), skillRoots: [], catalogRefreshIntervalMs: 0, clock: () => clock.now,
    cliDiscovery: { paths: [bin], ...(documented ? { hostPaths: [bin], sandboxPaths: [sandboxBin] } : {}),
      ...(unrelatedManual ? { hostPaths: [bin], sandboxPaths: [systemBin] } : {}),
      manRoots: unrelatedManual ? [manualRoot] : [], systemPackageRoot: join(root, 'no-system-packages') } };
  const store = new ToolInventoryStore(options, { available: true });
  return { root, bin, sandboxBin, pkg, marker, description, sandboxDescription, clock, store, async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

export async function automaticCatalogAcceptance(documented: boolean, unrelatedManual = false) {
  const f = await automaticFixture(documented, unrelatedManual);
  try {
    await f.store.initialize();
    const snapshot = f.store.snapshot(), entry = snapshot.cli.entries.find(item => item.command === 'squad-auto-reader');
    assert(entry, 'An installed command must appear without manual catalog configuration');
    if (documented) {
      assert.equal(entry.description, f.description, 'Installed static documentation must remain visible as documented usage');
      assert(entry.scenarios?.some(scenario => scenario.includes('输入和目标') && scenario.includes('核对参数')));
      assert.equal(entry.documentation?.state, 'documented', 'Installed static documentation must remain visible as documented usage'); assert.equal(entry.documentation?.source, 'npm');
      assert(entry.documentation?.reference.includes('squad-reader-fixture'));
      assert.equal(entry.discovery?.find(item => item.execution === 'host')?.usage, undefined, 'Same usage must reference entry metadata without repeating it');
      assert.equal(entry.discovery?.find(item => item.execution === 'sandbox')?.usage?.description, f.sandboxDescription);
      assert.notEqual(entry.discovery?.[0]?.path, entry.discovery?.[1]?.path);
    } else {
      assert.equal(entry.documentation?.state, 'unknown', 'A PATH wrapper must not borrow another installation’s same-name manual'); assert.equal(entry.documentation?.source, 'path');
      assert(entry.scenarios?.every(scenario => scenario.includes('未知')));
      if (unrelatedManual) {
        const sandboxUsage = entry.discovery?.find(item => item.execution === 'sandbox')?.usage;
        assert.equal(sandboxUsage?.documentation?.state, 'documented'); assert.equal(sandboxUsage?.documentation?.source, 'man');
        assert.equal(sandboxUsage?.description, 'read system accounting ledger records');
      }
    }
    const model = new LocalModel();
    const ready = withToolInventoryReadiness(model.c, model.work, snapshot).cli.entries.find(item => item.command === entry.command)!;
    assert(ready.variants.every(variant => variant.readiness.installation === 'found' && variant.readiness.authentication === 'unknown' && variant.readiness.network === 'unknown'));
    assert(ready.variants.every(variant => variant.readiness.inventoryObservation?.catalogVersion === snapshot.cli.catalogVersion
      && variant.readiness.inventoryObservation?.observedAt === snapshot.observedAt && variant.readiness.sourceOperationIds.length === 0));
    assert.equal(ready.variants.find(variant => variant.execution === 'host')!.readiness.authorization, 'required');
    assert.equal(snapshot.executionAuthority, false); assert.equal(snapshot.environment.host.approvalRequired, true);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    return { entry, executions: 0, authority: snapshot.executionAuthority };
  } finally { await f.close(); }
}

export async function unlimitedCatalogAcceptance() {
  const entries = Array.from({ length: 211 }, (_, i) => ({ command: `archive-${i}`, description: `read document ${'x'.repeat(10_000)}` }));
  let catalog!: CliCatalog;
  assert.doesNotThrow(() => { catalog = new CliCatalog(entries); }, 'Valid complete catalogs must accept more than 200 entries');
  const page = catalog.list();
  assert.deepEqual(page.entries, entries); assert.equal(page.nextCursor, null);
  const f = await LocalFixture.create();
  try {
    const file = join(f.root, 'large-catalog.json'); await writeFile(file, JSON.stringify(entries));
    await f.runtime.close();
    const { cliCatalog: _catalog, ...options } = f.runtime.options;
    f.runtime = await LocalRuntime.create({ ...options, cliCatalogFile: file, catalogRefreshIntervalMs: 0 });
    assert.deepEqual(f.runtime.toolInventory().cli.entries, entries, 'Catalog file beyond 2 MB must not be replaced by a hidden byte cap');
    for (let i = 0; i < 25; i++) await writeSkill(f.skills, `unlimited-${i}`, 'Unlimited archive workflow');
    const registry = await SkillRegistry.discover({ roots: [f.skills], snapshotRoot: join(f.root, 'skill-snapshots') });
    const skills = registry.list(); assert.equal(skills.skills.length, 26); assert.equal(skills.nextCursor, null);
    return { entries: page.entries.length, skills: skills.skills.length, bytes: JSON.stringify(entries).length };
  } finally { await f.close(); }
}

export async function largeDiscoveryAcceptance() {
  const entries: CliCatalogEntry[] = Array.from({ length: 211 }, (_, i) => ({ command: `squad-discovery-${i}`,
    description: `Static archive command ${'x'.repeat(10_000)}`, scenarios: ['Read local archive data'] }));
  const f = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: entries } });
  try {
    const commands = entries.slice(0, 31).map(entry => entry.command);
    f.replies.push({ type: 'discoverHost', commands }, { type: 'discoverHost', query: 'absent-query', commands },
      { type: 'answer', text: '已取得完整工具目录，尚未执行命令。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const operation = f.h.context().intents[0]!.localOperations![0]!;
    assert.equal(operation.status, 'succeeded'); assert(operation.result?.ok);
    const cli = operation.result.data.cli as { commands: { command: string }[]; catalog: { entries: CliCatalogEntry[]; nextCursor: null } };
    assert.equal(cli.commands.length, entries.length); assert.deepEqual(cli.catalog.entries, entries); assert.equal(cli.catalog.nextCursor, null);
    assert(JSON.stringify(operation.result).length > 1_900_000);
    assert.equal(f.h.context().intents[0]!.localOperations!.length, 2, 'A saved large metadata checkpoint must permit the next valid request');
    assert.equal(f.h.context().intents[0]!.localCheckpoint!.messages.at(-2)!.role, 'assistant');
    assert(f.requests[1]!.messages.some(message => message.content.includes('squad-discovery-210') && message.content.includes('"code":"discoverHost"')));
    assert.deepEqual(inventoryObservation(f.requests[1]!).cli.entries.map(entry => entry.command), entries.map(entry => entry.command));
    assert.equal(f.backend.calls.length, 0); assert.equal(f.h.context().usage.ordinary, 3);
    return { commands: cli.commands.length, entries: cli.catalog.entries.length, executions: f.backend.calls.length };
  } finally { await f.close(); }
}

export async function automaticCatalogRefreshAcceptance() {
  const f = await automaticFixture();
  try {
    await f.store.initialize(); const old = f.store.snapshot();
    const model = new LocalModel(); model.at = 150;
    assert(model.request({ type: 'runCli', executable: 'squad-auto-reader', args: [], execution: 'sandbox' }).ok);
    assert(model.claim().ok);
    assert(model.result({ result: { ok: false, code: 'CLI_NOT_FOUND', data: {} } }).ok);
    const newerFailure = withToolInventoryReadiness(model.c, model.work, old).cli.entries.find(entry => entry.command === 'squad-auto-reader')!
      .variants.find(variant => variant.execution === 'sandbox')!.readiness;
    assert.equal(newerFailure.installation, 'not_found', 'A newer execution failure must override an older installed observation');
    assert.equal(newerFailure.observedAt, 150); assert(newerFailure.sourceOperationIds.includes(model.op!.id));
    const packageFile = join(f.pkg, 'package.json');
    const metadata = JSON.parse(await readFile(packageFile, 'utf8')) as Record<string, unknown>;
    await writeFile(packageFile, JSON.stringify({ ...metadata, description: 'Convert scanned invoices to searchable text' }));
    const extra = join(f.bin, 'squad-added-tool'); await writeFile(extra, '#!/bin/sh\nexit 1\n'); await chmod(extra, 0o755);
    f.clock.now = 200; await f.store.refresh(); const updated = f.store.snapshot();
    const newerInventory = withToolInventoryReadiness(model.c, model.work, updated).cli.entries.find(entry => entry.command === 'squad-auto-reader')!
      .variants.find(variant => variant.execution === 'sandbox')!.readiness;
    assert.equal(newerInventory.installation, 'found', 'A newer inventory observation must supersede a settled old NOT_FOUND receipt');
    assert.equal(newerInventory.observedAt, 200); assert.deepEqual(newerInventory.sourceOperationIds, []);
    assert.equal(newerInventory.authentication, 'unknown'); assert.equal(newerInventory.network, 'unknown');
    assert.equal(newerFailure.authentication, 'unknown'); assert.equal(newerFailure.network, 'unknown');
    assert.notEqual(updated.catalogVersion, old.catalogVersion);
    assert.equal(updated.cli.entries.length, 2); assert.equal(old.cli.entries.length, 1);
    assert.equal(old.cli.entries[0]!.description, f.description);
    assert(updated.cli.entries.find(entry => entry.command === 'squad-auto-reader')!.description.includes('invoices'));
    await rm(join(f.bin, 'squad-auto-reader')); await f.store.refresh();
    assert.deepEqual(f.store.snapshot().cli.entries.map(entry => entry.command), ['squad-added-tool', 'squad-auto-reader']);
    assert.deepEqual(f.store.snapshot().cli.entries.find(entry => entry.command === 'squad-auto-reader')!.discovery!.map(item => item.execution), ['sandbox']);
    await rm(join(f.sandboxBin, 'squad-auto-reader')); await f.store.refresh();
    assert.deepEqual(f.store.snapshot().cli.entries.map(entry => entry.command), ['squad-added-tool']);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    return { oldEntries: old.cli.entries.length, updatedEntries: updated.cli.entries.length, finalEntries: f.store.snapshot().cli.entries.length, executions: 0 };
  } finally { await f.close(); }
}
