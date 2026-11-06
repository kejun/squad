import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { minimalCliEnvironment, sandboxPolicy } from '../src/local-cli.js';

export class SandboxPolicyContract {
  readonly workspace = '/task/workspace';
  policy?: ReturnType<typeof sandboxPolicy>;
  environment?: Record<string, string>;
  construct() {
    this.policy = sandboxPolicy({ workspace: this.workspace, skillPath: '/task/skill' });
    this.environment = minimalCliEnvironment(this.workspace);
  }
  verifyDefaultDenial() {
    const policy = this.policy, environment = this.environment;
    assert(policy && environment);
    assert(policy.filesystem.allowRead);
    assert(policy.filesystem.denyRead.includes('/'));
    assert.deepEqual(policy.network.allowedDomains, []);
    assert(policy.network.deniedDomains?.includes('*'));
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.HOME, join(this.workspace, '.home'));
    assert(!policy.filesystem.allowRead.includes('/root'));
    assert.equal(policy.network.allowAllUnixSockets, false);
    assert.equal(policy.enableWeakerNestedSandbox, false);
    assert.equal(policy.allowNestedUserNamespaces, false);
  }
  verifyTrustedHelper() {
    const policy = this.policy; assert(policy);
    const { allowRead, denyWrite } = policy.filesystem;
    assert(allowRead && denyWrite);
    const runtimeRoot = dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json'));
    const helper = join(runtimeRoot, 'vendor', 'seccomp', process.arch, 'apply-seccomp');
    const supported = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);
    const hasLiteral = (values: NonNullable<typeof policy.filesystem.allowRead>, path: string) => values.some(value =>
      typeof value === 'object' && value.path === path && value.literal === true);
    assert.equal(hasLiteral(allowRead, helper), supported);
    assert.equal(hasLiteral(denyWrite, helper), supported);
    assert.deepEqual(policy.filesystem.allowWrite, [{ path: this.workspace, literal: true }]);
    assert(!hasLiteral(allowRead, runtimeRoot));
    assert(!hasLiteral(allowRead, dirname(dirname(runtimeRoot))));
    assert(!hasLiteral(allowRead, '/home'));
    assert(hasLiteral(policy.filesystem.denyRead, process.cwd()));
  }
}
