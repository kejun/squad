import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js';

// Generate the actual pinned runtime's command; never execute the sandbox here.
async function withMounts(deny, check) {
  const root = await mkdtemp(join(tmpdir(), 'squad-mount-order-'));
  const output = join(root, 'dist'), locked = join(output, 'locked');
  await mkdir(locked, { recursive: true });
  try {
    const command = await wrapCommandWithSandboxLinux({
      command: 'true', needsNetworkRestriction: false, allowAllUnixSockets: false,
      readConfig: { denyOnly: ['/'], allowWithinDeny: [root, '/usr', '/bin', '/lib', '/lib64'] },
      writeConfig: { allowOnly: [output], denyWithinAllow: deny === 'ancestor' ? [root] : deny === 'child' ? [locked] : [] },
      binShell: '/bin/bash',
    });
    check(command, root, output, locked);
  } finally {
    cleanupBwrapMountPoints();
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')('pinned SRT read/write mount integration', () => {
  it('[BT_L22] restores an explicitly writable output after its read-only parent', async () => {
    await withMounts('none', (command, root, output) => {
      const parentRead = command.lastIndexOf(`--ro-bind ${root} ${root}`);
      const childWrite = command.lastIndexOf(`--bind ${output} ${output}`);
      expect(parentRead).toBeGreaterThanOrEqual(0);
      expect(childWrite).toBeGreaterThan(parentRead);
      expect(command).not.toContain(`--bind ${root} ${root}`);
    });
  });
  it('[BT_L22] preserves a denied child after restoring the writable output', async () => {
    await withMounts('child', (command, root, output, locked) => {
      expect(command.lastIndexOf(`--bind ${output} ${output}`)).toBeGreaterThan(command.lastIndexOf(`--ro-bind ${root} ${root}`));
      expect(command.lastIndexOf(`--ro-bind ${locked} ${locked}`)).toBeGreaterThan(command.lastIndexOf(`--bind ${output} ${output}`));
    });
  });
  it('[BT_L22] preserves an ancestor write denial over the explicitly writable output', async () => {
    await withMounts('ancestor', (command, _root, output) => {
      expect(command.lastIndexOf(`--ro-bind ${output} ${output}`)).toBeGreaterThan(command.lastIndexOf(`--bind ${output} ${output}`));
    });
  });
});
