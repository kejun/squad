import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const evidence = resolve(process.argv[2] ?? join('reports/service-composition-negative', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
assert(!existsSync(evidence)); mkdirSync(evidence, { recursive: true });
const cases = [
  ['drop-recovery-close', 'BT_K03', '', 'CloseDuringStartup', '/src/web/service.ts'],
  ['drop-execution-close', 'BT_K04', '', 'CloseBeforeMicrotask', '/src/web/service.ts'],
  ['drop-pump-dedupe', 'BT_K05', '定时、重复、完成', 'PumpDedupe', '/src/web/service.ts'],
  ['drop-instance-failstop', 'BT_K06', '', 'InstanceStorageFailStop', '/src/engine.ts'],
  ['drop-room-failstop', 'BT_K07', '', 'RoomHostFailStop', '/src/web/service.ts'],
];
const report = { status: 'running', evidence, mutations: [], restored: [] };
function run(name, scenario, order, mutation = 'observe') {
  const result = spawnSync(process.execPath, ['--import', './tests/service-composition-fault-loader.mjs', '--import', 'tsx', 'tests/service-composition-driver.mjs',
    '--case', scenario, '--variant', order, '--evidence', join(evidence, name)], {
    cwd: process.cwd(), env: { ...process.env, SERVICE_COMPOSITION_MUTATION: mutation }, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? ''); writeFileSync(join(evidence, name + '.log'), output);
  assert(!result.error, String(result.error)); assert.equal(result.signal, null, 'Timeout or process termination is not a behavioral counterexample');
  const proof = JSON.parse(readFileSync(join(evidence, name, 'run.json'), 'utf8'));
  assert(Object.values(proof.cleanup).every(Boolean), 'Every controlled service, runtime and SQLite connection must be closed');
  return { result, output, proof };
}
try {
  for (const [mutation, scenario, order, marker, suffix] of cases) {
    const { result, output } = run(mutation, scenario, order, mutation);
    assert.notEqual(result.status, 0, 'The mutated guard must fail the original probe');
    assert(output.includes(marker), 'The expected behavioral assertion must detect ' + mutation + ': ' + output);
    const boundaries = readFileSync(join(evidence, mutation, 'module-boundaries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(boundaries.some(boundary => boundary.path.endsWith(suffix) && boundary.original !== boundary.changed), 'The selected production source mutation must actually load');
    report.mutations.push({ mutation, scenario, marker, suffix });
  }
  for (const scenario of ['BT_K03', 'BT_K04', 'BT_K05', 'BT_K06', 'BT_K07']) {
    const orders = scenario === 'BT_K05' ? ['定时、重复、完成', '定时、完成、重复', '重复、定时、完成', '重复、完成、定时', '完成、定时、重复', '完成、重复、定时'] : [''];
    for (const [index, order] of orders.entries()) {
      const { result, output } = run('restored-' + scenario + '-' + index, scenario, order);
      assert.equal(result.status, 0, output); report.restored.push({ scenario, order });
    }
  }
  report.status = 'verified';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { writeFileSync(join(evidence, 'run.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
