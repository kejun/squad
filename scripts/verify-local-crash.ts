import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { localEffectCrashAcceptance } from '../tests/local-effect-crash-fixture.js';

if (process.argv.includes('--negative-controls')) {
  const parent = resolve('work'); await mkdir(parent, { recursive: true });
  const evidence = resolve('reports/kej-103', `negative-controls-${Date.now()}-${process.pid}`);
  await mkdir(evidence, { recursive: true });
  const anchor = '// Absence of a live process does not prove what it wrote. Retain the lease for explicit reconciliation.\n    return null;';
  const mutations = [
    { name: 'blind-replay', replacement: "return { resolution: 'notStarted', detail: 'negative control: replay unknown effect' };" },
    { name: 'invented-receipt', replacement: "return { resolution: 'receipt', result: { ok: true, code: 'succeeded', data: {} }, detail: 'negative control: invent settlement' };" },
  ];
  for (const mutation of mutations) {
    const isolated = await mkdtemp(join(parent, `kej-103-${mutation.name}-`));
    try {
      for (const path of ['src', 'tests', 'package.json', 'team.config.ts', 'tsconfig.json']) await cp(resolve(path), join(isolated, path), { recursive: true });
      await symlink(resolve('node_modules'), join(isolated, 'node_modules'));
      const file = join(isolated, 'src/local-cli.ts'), source = await readFile(file, 'utf8');
      assert.equal(source.split(anchor).length, 2, 'Mutation anchor must identify exactly one recovery decision');
      await writeFile(file, source.replace(anchor, mutation.replacement));
      const env = { ...process.env }; delete env.MODEL_API_KEY;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "const {localEffectCrashAcceptance}=await import('./tests/local-effect-crash-fixture.ts');await localEffectCrashAcceptance('beforeReceipt');"],
      { cwd: isolated, env, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024 });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      await writeFile(join(evidence, `${mutation.name}.log`), output);
      assert.equal(result.error, undefined, 'Negative control must finish, not time out');
      assert.notEqual(result.status, 0, 'Unsafe recovery mutation must fail');
      assert.match(output, /Unknown CLI effects must remain uncertain/, 'Mutation must fail the concrete unknown-effect assertion');
      console.log(`${mutation.name}: detected by unknown-effect recovery assertion`);
    } finally { await rm(isolated, { recursive: true, force: true }); }
  }
  await writeFile(join(evidence, 'run.json'), JSON.stringify({ status: 'detected', mutations, temporaryCopiesRemoved: true }, null, 2));
  console.log(`Negative-control evidence: ${evidence}`);
} else {
  for (const mode of ['beforeReceipt', 'afterJournal', 'stopped'] as const) {
    const result = await localEffectCrashAcceptance(mode); console.log(`${mode}: verified; ${result.evidence}`);
  }
}
