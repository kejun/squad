#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const evidence = resolve(process.argv[2]); mkdirSync(evidence, { recursive: true });
const { localEffectCrashAcceptance } = await import('./local-effect-crash-fixture.ts');
const { SqliteTransactionCrash } = await import('./sqlite-transaction-crash.ts');
const records = [];
for (const mode of ['beforeReceipt', 'afterJournal', 'stopped']) {
  const result = await localEffectCrashAcceptance(mode);
  const destination = join(evidence, 'kej-103', mode); cpSync(result.evidence, destination, { recursive: true });
  const record = JSON.parse(readFileSync(join(destination, 'run.json'), 'utf8'));
  assert.equal(record.status, 'verified'); assert(Object.values(record.cleanup).every(Boolean));
  records.push({ domain: 'KEJ-103', mode, evidence: destination, status: 'verified' });
}
for (const operation of ['lease', 'report']) for (const boundary of ['beforeCommit', 'afterCommit']) {
  const destination = join(evidence, 'kej-104', `${operation}-${boundary}`);
  const fixture = new SqliteTransactionCrash(operation, boundary, destination);
  try { await fixture.crash(); fixture.verifyBoundary(boundary === 'beforeCommit' ? '全部不可见' : '完整保留'); fixture.verifyReplay(); }
  finally { fixture.cleanup(); }
  records.push({ domain: 'KEJ-104', operation, boundary, evidence: destination, status: 'verified' });
}
writeFileSync(join(evidence, 'bridges.json'), JSON.stringify({ status: 'verified', records, scope: 'Actual controlled CLI/SIGKILL and SQLite processes; no OS-sandbox, hardware or external provider exactly-once proof.' }, null, 2));
console.log(JSON.stringify({ status: 'verified', bridges: records.length }));
