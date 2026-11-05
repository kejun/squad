import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { sandboxPolicy } from '../src/local-cli.js';

describe.skipIf(process.platform !== 'linux')('production sandbox write-deny conversion', () => {
  it('[BT_L22] keeps an empty hooks ancestor read-only even when its child is an explicit output and no HEAD exists', async () => {
    // Given the same empty Git hooks/output layout as the real OS acceptance.
    const workspace = await mkdtemp(join(tmpdir(), 'squad-production-deny-'));
    const output = join(workspace, '.git', 'hooks', 'output');
    await mkdir(output, { recursive: true });
    try {
      // When the actual production policy passes through the public SRT manager.
      const policy = sandboxPolicy({ workspace, writeRoots: [output] });
      const wrapped = await SandboxManager.wrapWithSandboxArgv('true', '/bin/bash', policy, undefined, workspace);
      const command = wrapped.argv.join(' ');
      // Then a final read-only output mount overrides all of its writable mounts.
      expect(policy.filesystem.denyWrite).toContainEqual({ path: join(workspace, '.git', 'hooks'), literal: true });
      expect(policy.filesystem.denyWrite).toContainEqual({ path: join(workspace, '.git', 'config'), literal: true });
      expect(command.lastIndexOf(`--ro-bind ${output} ${output}`)).toBeGreaterThan(command.lastIndexOf(`--bind ${output} ${output}`));
    } finally {
      SandboxManager.cleanupAfterCommand();
      await SandboxManager.reset();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
