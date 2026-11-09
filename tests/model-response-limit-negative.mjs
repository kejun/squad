import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
const evidence = resolve(process.argv[2] ?? 'reports/kej-105-negative');
mkdirSync(evidence, { recursive: true });
const path = 'src/model-adapter.ts';
const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = hash();
const proof = `${evidence}/fault-applied.jsonl`;
if (existsSync(proof)) unlinkSync(proof);
const run = (name, fault) => {
  const fd = openSync(`${evidence}/${name}.log`, 'w');
  const args = ['--import', 'tsx', ...(fault ? ['--import', './tests/model-response-limit-fault-loader.mjs'] : []),
    'node_modules/@cucumber/cucumber/bin/cucumber.js', 'features/32_model_response_limit.feature', '--import', 'tests/bdd/*.ts',
    '--tags', fault ? '@BT_M47' : '@BT_M46 or @BT_M47 or @BT_M48 or @BT_M49', '--format', 'progress', '--format', `json:${evidence}/${name}.json`];
  const result = spawnSync(process.execPath, args, { timeout: 30000, stdio: ['ignore', fd, fd], env: { ...process.env,
    MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'controlled', MODEL_NO_AUTH: 'true',
    TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json', MODEL_RESPONSE_FAULT_PROOF: proof, MODEL_RESPONSE_EVIDENCE: `${evidence}/${name}-http` } });
  closeSync(fd);
  const failures = JSON.parse(readFileSync(`${evidence}/${name}.json`, 'utf8')).flatMap(feature => feature.elements ?? [])
    .flatMap(scenario => scenario.steps ?? []).filter(step => step.result?.status === 'failed').map(step => step.result.error_message);
  return { status: result.status, signal: result.signal, processError: result.error?.message, failures };
};
const negative = run('negative', true);
const restored = run('restored', false);
const unchanged = before === hash();
const detected = negative.status === 1 && existsSync(proof) && negative.failures.length === 4
  && negative.failures.every(message => message.includes('AssertionError') && message.includes('MODEL_RESPONSE_TOO_LARGE'));
writeFileSync(`${evidence}/result.json`, JSON.stringify({ before, after: hash(), unchanged, detected, negative, restored }, null, 2));
console.log(JSON.stringify({ detected, unchanged, negativeStatus: negative.status, businessFailures: negative.failures.length,
  restoredStatus: restored.status, evidence }));
if (!detected || !unchanged || restored.status !== 0) process.exitCode = 1;
