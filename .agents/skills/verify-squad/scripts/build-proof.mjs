import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function files(root, path) {
  if (!existsSync(join(root, path))) return [];
  if (statSync(join(root, path)).isFile()) return [path];
  return readdirSync(join(root, path)).sort().flatMap(name => files(root, join(path, name)));
}
function sourceInputs(root) {
  const paths = ['src', 'web/src', 'web/public', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'scripts/web.ts', 'team.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/build.mjs', '.agents/skills/verify-squad/scripts/build-proof.mjs'];
  return paths.flatMap(path => files(root, path)).map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }));
}
function bundles(root) {
  return files(root, 'dist/web').filter(path => !path.endsWith('/build-proof.json')).map(path => ({ path: relative('dist/web', path), sha256: hash(readFileSync(join(root, path))) }));
}
export function captureSource(root = process.cwd()) {
  const inputs = sourceInputs(root);
  return { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceInputSha256: hash(JSON.stringify(inputs)), inputs };
}
export function recordBuild(root = process.cwd(), before = undefined) {
  const current = captureSource(root);
  if (before) assert.deepEqual(current, before, 'Source changed during build; rebuild from stable inputs');
  const proof = { ...current, bundles: bundles(root), builtAt: new Date().toISOString() };
  assert(proof.bundles.length > 1, 'A production web bundle must exist');
  writeFileSync(join(root, 'dist/web/build-proof.json'), JSON.stringify(proof, null, 2));
  return proof;
}
export function verifyBuild(root = process.cwd()) {
  const proof = JSON.parse(readFileSync(join(root, 'dist/web/build-proof.json'), 'utf8'));
  assert.equal(proof.source, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), 'Build must belong to this source commit; run npm run build');
  assert.equal(proof.sourceInputSha256, hash(JSON.stringify(sourceInputs(root))), 'Build inputs changed; run npm run build');
  assert.deepEqual(proof.bundles, bundles(root), 'Built assets changed after the recorded build');
  return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) recordBuild();
