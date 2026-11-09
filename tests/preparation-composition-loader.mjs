import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
const shim = new URL('./preparation-composition-fs.mjs', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!/\/src\/local-(?:skills|runtime)\.ts$/.test(new URL(url).pathname)) return result;
  let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const fault = process.env.PREPARATION_MUTATION;
  const target = fault === 'skip-existing-permissions' && url.endsWith('/src/local-skills.ts')
    ? /await readonlyDirectories\(path\)/
    : fault === 'skip-scratch-reentry' && url.endsWith('/src/local-runtime.ts')
      ? /await prepareScratch\(copy\)/
      : fault === 'skip-check-output-preparation' && url.endsWith('/src/local-runtime.ts')
        ? /await mkdir\(join\(workspace\.path,\s*dir\),\s*\{\s*recursive:\s*true\s*\}\)/ : undefined;
  if (target) {
    const original = source;
    source = source.replace(target, 'void 0');
    if (source === original) throw new Error(`Preparation source fault did not match: ${fault}`);
    const hash = value => createHash('sha256').update(value).digest('hex');
    process.send?.({ type: 'mutation', fault, originalHash: hash(original), mutatedHash: hash(source) });
  }
  if (!/['"]node:fs\/promises['"]/.test(source)) throw new Error('Preparation filesystem import boundary was not found');
  return { ...result, source: source.replace(/['"]node:fs\/promises['"]/g, JSON.stringify(shim)) };
} });
