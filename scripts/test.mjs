import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('test-results', { recursive: true });
for (const args of [
  ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=test-results/vitest.json'],
  ['scripts/run-bdd.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 60000 });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
