import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { sandboxPolicy } from '../src/local-cli.js';

const runtimeRoot = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json'));
const helper = join(runtimeRoot, 'vendor', 'seccomp', process.arch, 'apply-seccomp');

describe('trusted sandbox runtime visibility', () => {
  it.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))('[BT_L22] restores only the trusted architecture helper read-only while its installation remains hidden', () => {
    // Given a workspace separate from the service and its dependency installation.
    const input = { workspace: '/task/workspace', skillPath: '/task/skill' };
    // When constructing the production filesystem policy.
    const policy = sandboxPolicy(input);
    // Then the executable is readable but cannot be modified, without exposing its parents.
    expect(policy.filesystem.allowRead).toContainEqual({ path: helper, literal: true });
    expect(policy.filesystem.denyWrite).toContainEqual({ path: helper, literal: true });
    expect(policy.filesystem.allowWrite).toEqual([{ path: input.workspace, literal: true }]);
    expect(policy.filesystem.allowRead).not.toContainEqual({ path: runtimeRoot, literal: true });
    expect(policy.filesystem.allowRead).not.toContainEqual({ path: dirname(dirname(runtimeRoot)), literal: true });
    expect(policy.filesystem.allowRead).not.toContainEqual({ path: '/home', literal: true });
    expect(policy.filesystem.denyRead).toContain('/');
    expect(policy.filesystem.denyRead).toContainEqual({ path: process.cwd(), literal: true });
    expect(policy.network.allowAllUnixSockets).toBe(false);
    expect(policy.enableWeakerNestedSandbox).toBe(false);
    expect(policy.allowNestedUserNamespaces).toBe(false);
  });
});
