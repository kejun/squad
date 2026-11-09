import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crashEvidenceDirectory, SqliteTransactionCrash, verifyAtomicityNegativeControl } from '../tests/sqlite-transaction-crash.js';

const root = crashEvidenceDirectory('suite');
mkdirSync(root, { recursive: true });
const source = ['src/store.ts', 'src/engine.ts', 'tests/fixtures/crash.ts', 'tests/fixtures/sqlite-transaction-child.ts', 'tests/fixtures/typescript-loader.mjs', 'tests/sqlite-transaction-crash.ts'];
const run = { status: 'running', node: process.version,
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  diff: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
  sourceHashes: Object.fromEntries(source.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  positiveCases: [] as string[], negativeControls: [] as string[] };
try {
  for (const operation of ['report', 'lease'] as const) {
    for (const boundary of ['beforeCommit', 'afterCommit'] as const) {
      const name = `${operation}-${boundary}`;
      const fixture = new SqliteTransactionCrash(operation, boundary, join(root, name));
      try { await fixture.crash(); fixture.verifyBoundary(boundary === 'beforeCommit' ? '全部不可见' : '完整保留'); fixture.verifyReplay(); run.positiveCases.push(name); }
      finally { fixture.cleanup(); }
    }
    await verifyAtomicityNegativeControl(operation, join(root, `${operation}-split-receipt`));
    run.negativeControls.push(`${operation}: ATOMICITY_RECEIPT`);
    const restored = new SqliteTransactionCrash(operation, 'beforeCommit', join(root, `${operation}-restored`));
    try { await restored.crash(); restored.verifyBoundary('全部不可见'); restored.verifyReplay(); run.positiveCases.push(`${operation}-restored`); }
    finally { restored.cleanup(); }
  }
  run.status = 'verified';
  console.log(JSON.stringify({ ...run, evidence: root }));
} catch (error) { run.status = 'failed'; throw error; }
finally { writeFileSync(join(root, 'run.json'), JSON.stringify(run, null, 2)); }
