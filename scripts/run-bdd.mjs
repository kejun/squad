import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runNode } from './check-runner.mjs';
import { build } from './build.mjs';

export async function runBdd() {
  mkdirSync('test-results', { recursive: true });
  const browserContracts = readdirSync('features', { recursive: true }).some(path =>
    typeof path === 'string' && path.endsWith('.feature') && readFileSync(`features/${path}`, 'utf8').includes('@real_browser'));
  if (browserContracts) {
    const built = await build();
    if (built !== 0) return built;
  }
  const gaps = JSON.parse(readFileSync('features/acceptance-gaps.json', 'utf8'));
  const excluded = Object.keys(gaps).map(tag => `@${tag}`);
  const tagArgs = excluded.length ? ['--tags', `not (${excluded.join(' or ')})`] : [];
  const run = await runNode([
    '--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js',
    'features', '--import', 'tests/bdd/*.ts', ...tagArgs,
    '--format', 'progress', '--format', 'json:test-results/cucumber.json',
  ], { env: { ...process.env, TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json' } });
  return run.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runBdd();
