import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNode } from './check-runner.mjs';
import { captureSource, recordBuild } from '../.agents/skills/verify-squad/scripts/build-proof.mjs';

export async function build() {
  const before = captureSource();
  for (const args of [
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    ['node_modules/typescript/bin/tsc', '-p', 'web/tsconfig.json'],
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'web/vite.config.ts'],
  ]) {
    const result = await runNode(args, { idleTimeout: 90_000, maxDuration: 90_000 });
    if (result.status !== 0) return result.status;
  }
  recordBuild(process.cwd(), before);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await build();
