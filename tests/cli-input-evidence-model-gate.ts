import { assertFixedCheckRejectsAddedStdin, assertFrozenInputRefRejects, assertTrustedInputProjection, assertUnknownInputDoesNotBlockPureRequest } from './cli-input-evidence-model-fixture.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
assertTrustedInputProjection();
for (const change of ['执行参数', '执行环境', '输入路径', '输入大小', '输入哈希', '调用元数据', '输入指纹', '校验事实', '原始操作', '旧引用缺少调用快照']) assertFrozenInputRefRejects(change);
assertUnknownInputDoesNotBlockPureRequest();
assertFixedCheckRejectsAddedStdin();
const sourceHashes = Object.fromEntries(['src/task.machine.ts', 'src/local-operation.ts', 'src/task/evidence.ts', 'src/task/verification.ts', 'src/cli-failure.ts']
  .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
console.log(JSON.stringify({ status: 'passed', model: 'real taskMachine', sourceHashes,
  boundary: 'Controlled host events plus real persisted-snapshot round trips; outer gate reads source hashes only.',
  scenarios: ['Y151 receipt-only projection and fixed verification scope', 'Y152 unknown bytes request', 'Y153 frozen identity changes/removal'] }));
