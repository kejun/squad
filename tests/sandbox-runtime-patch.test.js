import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { patchRuntimeSource } from '../scripts/patch-sandbox-runtime.mjs';

const root = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json'));
const patch = JSON.parse(await readFile(new URL('../patches/sandbox-runtime-0.0.81.json', import.meta.url), 'utf8'));
const installed = await readFile(join(root, patch.file), 'utf8');

describe('reviewed sandbox-runtime patch integrity', () => {
  it('keeps the reviewed installed patch unchanged on repeated installation', () => {
    expect(patchRuntimeSource(installed, '0.0.81', patch)).toBe(installed);
  });
  it('reconstructs exactly the reviewed patched file from the original source', () => {
    const original = installed.replace(patch.insertion, '');
    expect(patchRuntimeSource(original, '0.0.81', patch)).toBe(installed);
  });
  it('rejects a different dependency version even when its bytes match', () => {
    expect(() => patchRuntimeSource(installed, '0.0.82', patch)).toThrow('version');
  });
  it('rejects modified installed bytes rather than guessing an applicable patch', () => {
    expect(() => patchRuntimeSource(`${installed}\n`, '0.0.81', patch)).toThrow('source hash');
  });
  it('rejects a patch that does not produce the reviewed target hash', () => {
    const original = installed.replace(patch.insertion, '');
    expect(() => patchRuntimeSource(original, '0.0.81', { ...patch, insertion: `${patch.insertion}\n` })).toThrow('patched hash');
  });
});
