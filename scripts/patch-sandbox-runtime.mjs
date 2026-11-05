import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = text => createHash('sha256').update(text).digest('hex');

export function patchRuntimeSource(source, version, patch) {
  if (version !== patch.version) throw new Error('Sandbox runtime version does not match reviewed patch');
  if (hash(source) === patch.patchedSha256) return source;
  if (hash(source) !== patch.originalSha256) throw new Error('Sandbox runtime source hash does not match reviewed patch');
  if (source.split(patch.anchor).length !== 2) throw new Error('Sandbox runtime patch anchor must occur exactly once');
  const patched = source.replace(patch.anchor, patch.insertion + patch.anchor);
  if (hash(patched) !== patch.patchedSha256) throw new Error('Sandbox runtime patched hash does not match reviewed result');
  return patched;
}

export async function patchInstalledRuntime() {
  const patch = JSON.parse(await readFile(new URL('../patches/sandbox-runtime-0.0.81.json', import.meta.url), 'utf8'));
  const manifestPath = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const file = join(dirname(manifestPath), patch.file);
  const source = await readFile(file, 'utf8');
  const patched = patchRuntimeSource(source, manifest.version, patch);
  if (patched !== source) await writeFile(file, patched);
  console.log(`Verified sandbox-runtime ${manifest.version} mount-order patch (${patch.patchedSha256})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await patchInstalledRuntime();
