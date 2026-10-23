import { spawnSync } from 'node:child_process';
for (const args of [
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  ['node_modules/typescript/bin/tsc', '-p', 'web/tsconfig.json'],
  ['node_modules/typescript/bin/tsc', '-p', 'tests/bdd/tsconfig.json'],
  ['scripts/test.mjs'],
  ['--import', 'tsx', 'scripts/spec-coverage.ts'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 90000 });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
