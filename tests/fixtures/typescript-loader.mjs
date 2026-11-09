import { existsSync } from 'node:fs';

// Run the crash writer with Node's native type transformation. A SIGKILL must not
// orphan tsx's external compiler service; the fixture needs only .js -> .ts lookup.
export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (candidate.protocol === 'file:' && existsSync(candidate)) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
}
