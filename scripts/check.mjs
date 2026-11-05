import { runNode } from './check-runner.mjs';
import { runTests } from './test.mjs';

for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  ['node_modules/typescript/bin/tsc', '-p', 'web/tsconfig.json'],
  ['node_modules/typescript/bin/tsc', '-p', 'tests/tsconfig.json'],
]) {
  const result = await runNode(args, { idleTimeout: 90000, maxDuration: 90000 });
  if (result.status !== 0) process.exit(result.status);
}
const status = await runTests();
if (status !== 0) process.exit(status);
const coverage = await runNode(['--import', 'tsx', 'scripts/spec-coverage.ts'], { idleTimeout: 90000, maxDuration: 90000 });
process.exitCode = coverage.status;
