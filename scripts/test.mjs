import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runNode } from './check-runner.mjs';
import { runBdd } from './run-bdd.mjs';

export async function runTests() {
  mkdirSync('test-results', { recursive: true });
  const result = await runNode([
    'node_modules/vitest/vitest.mjs', 'run', '--dir', 'tests', '--maxWorkers=1',
    '--reporter=default', '--reporter=json', '--outputFile=test-results/vitest.json',
  ]);
  if (result.status !== 0) return result.status;
  return runBdd();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runTests();
