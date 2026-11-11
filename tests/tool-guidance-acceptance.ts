import assert from 'node:assert/strict';
import { LocalRuntime } from '../src/local-runtime.js';
import type { CliCatalogEntry } from '../src/cli-catalog.js';
import type { LocalAction } from '../src/local-operation.js';
import type { CliBackend } from '../src/local-cli.js';
import type { withCliReadiness } from '../src/cli-readiness.js';
import { LocalFixture, writeSkill } from './local-tools-fixture.js';

const nodeEntry: CliCatalogEntry = { command: 'node', description: 'Read documents 查询仓库问题', domains: ['github.com'],
  helpArgs: ['--help'], execution: 'sandbox', requirements: ['The installed runtime must support the chosen arguments'] };
type Recommendations = ReturnType<typeof withCliReadiness>;
interface Guidance { type: 'tool_guidance'; untrusted: boolean; recommendations: Recommendations;
  failures: { operationId: string; category: string; nextStep: string; failureCount: number }[] }

function guidance(request: LocalFixture['requests'][number]): Guidance {
  const message = request.messages.find(item => item.role === 'user' && item.content.includes('"type":"tool_guidance"'));
  assert(message, 'Every authorized member request should receive the current tool guidance');
  const observation = JSON.parse(message.content) as Guidance;
  assert.equal(observation.type, 'tool_guidance'); assert.equal(observation.untrusted, true);
  return observation;
}
function useGoal(f: LocalFixture, text: string) {
  f.h.room = 'guidance-room';
  const submitted = f.h.engine.submit(f.h.room, { id: 'guidance-input', text,
    goal: { text, constraints: [], criteria: ['保留真实工具结果'], requiredArtifacts: 0 } });
  assert(submitted.ok && submitted.taskId); f.h.task = submitted.taskId;
}
async function configureRuntime(f: LocalFixture, entries: CliCatalogEntry[], extra: { skillRoots?: string[]; backend?: CliBackend } = {}) {
  await f.runtime.close();
  f.runtime = await LocalRuntime.create({ ...f.runtime.options, cliCatalog: entries, ...extra });
}
async function largeCatalog(f: LocalFixture) {
  const unrelated = Array.from({ length: 20 }, (_, i) => ({ command: `backup-${i}`, description: 'Archive scheduled backup files' }));
  const related = Array.from({ length: 6 }, (_, i) => ({ ...nodeEntry, command: `zz-helper-${i}` }));
  for (let i = 0; i < 20; i++) await writeSkill(f.skills, `archive-${String(i).padStart(2, '0')}`, 'Archive scheduled backup files');
  for (let i = 0; i < 7; i++) await writeSkill(f.skills, `z-reader-${i}`, 'Read documents 查询仓库问题 github.com');
  await configureRuntime(f, [...unrelated, nodeEntry, ...related]);
  assert.equal(f.runtime.catalog().skills.some(skill => skill.name.startsWith('z-reader')), false,
    'Relevant skills must lie outside the initial metadata page');
}

/** Real registry/Runner/Adapter wiring. The scripted model chooses no command in this scenario. */
export async function initialGuidanceAcceptance(objective: string) {
  const f = await LocalFixture.create('方案师', true);
  try {
    await largeCatalog(f); useGoal(f, objective);
    const usage = f.h.context().usage.ordinary;
    f.replies.push({ type: 'answer', text: '已检查候选工具，尚未执行命令。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const observation = guidance(f.requests[0]!);
    const recommendations = observation.recommendations;
    assert.equal(recommendations.metadataOnly, true);
    assert.equal(recommendations.cli.candidates.length, 5);
    assert.equal(recommendations.skills.candidates.length, 5);
    assert.equal(recommendations.cli.candidates[0]!.command, 'node');
    assert(recommendations.skills.candidates.every(skill => skill.name.startsWith('z-reader')));
    assert(recommendations.cli.candidates.every(item => item.matchedTerms.length > 0));
    assert(recommendations.skills.candidates.every(item => item.matchedTerms.length > 0));
    assert.match(recommendations.cli.catalogVersion, /^[a-f0-9]{64}$/);
    assert.match(recommendations.skills.catalogVersion, /^[a-f0-9]{64}$/);
    assert.equal(recommendations.cli.omitted, true); assert.equal(recommendations.skills.omitted, true);
    assert.equal(recommendations.skills.sourceComplete, true);
    const metadata = f.runtime.recommendTools(objective);
    assert.deepEqual(recommendations.cli.candidates.map(({ readiness: _readiness, ...candidate }) => candidate), metadata.cli.candidates,
      'Host readiness must preserve the deterministic metadata ranking');
    assert.deepEqual(recommendations.skills, metadata.skills);
    assert.equal(f.backend.calls.length, 0);
    assert.equal(f.h.context().intents[0]!.localOperations, undefined);
    assert.equal(f.h.context().usage.ordinary - usage, 1, 'Only the first model request is charged');
    return { observation, executions: f.backend.calls.length, ordinaryUsed: f.h.context().usage.ordinary - usage };
  } finally { await f.close(); }
}

export async function emptyGuidanceAcceptance(kind: string) {
  const f = await LocalFixture.create();
  try {
    await configureRuntime(f, kind === '空目录' ? [] : [nodeEntry], { skillRoots: kind === '空目录' ? [] : [f.skills] });
    useGoal(f, 'unmatched_zebra_snowflake');
    f.replies.push({ type: 'answer', text: '目录中没有匹配项，需要继续发现。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const observation = guidance(f.requests[0]!);
    assert.deepEqual(observation.recommendations.cli.candidates, []);
    assert.deepEqual(observation.recommendations.skills.candidates, []);
    assert(f.requests[0]!.messages[0]!.content.includes('discoverHost'));
    assert(f.requests[0]!.messages[0]!.content.includes('listSkills'));
    assert.equal(f.backend.calls.length, 0);
    return observation;
  } finally { await f.close(); }
}

export async function incompleteSkillGuidanceAcceptance() {
  const f = await LocalFixture.create();
  try {
    await f.runtime.close();
    await writeSkill(f.skills, 'local-check', 'Read documents');
    await writeSkill(f.skills, 'z-additional-reader', 'Read documents');
    f.runtime = await LocalRuntime.create({ ...f.runtime.options, cliCatalog: [], registryLimits: { maxSkills: 1 } });
    useGoal(f, 'read documents');
    const usage = f.h.context().usage.ordinary;
    f.replies.push({ type: 'answer', text: '技能来源尚未完整扫描，当前只有一个已加载的匹配项。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const observation = guidance(f.requests[0]!);
    assert.equal(observation.recommendations.skills.sourceComplete, false);
    assert.equal(observation.recommendations.skills.omitted, false);
    assert.equal(observation.recommendations.skills.candidates.length, 1);
    assert.equal(f.backend.calls.length, 0);
    assert.equal(f.h.context().intents[0]!.localOperations, undefined);
    assert.equal(f.h.context().usage.ordinary - usage, 1);
    return { observation, executions: f.backend.calls.length, ordinaryUsed: f.h.context().usage.ordinary - usage };
  } finally { await f.close(); }
}

const failureActions: Record<string, LocalAction> = {
  命令未找到: { type: 'runCli', executable: 'squad-deliberately-missing-guidance', args: [] },
  未知参数: { type: 'runCli', executable: 'node', args: ['--squad-invalid'] },
  沙箱不可用: { type: 'runCli', executable: 'node', args: ['--version'] },
  沙箱权限拒绝: { type: 'runCli', executable: 'node', args: ['-e', 'console.error("EACCES: permission denied");process.exit(1)'] },
  需要登录: { type: 'runCli', executable: 'node', args: ['-e', 'console.error("authentication required");process.exit(1)'] },
  普通业务失败: { type: 'runCli', executable: 'node', args: ['-e', 'console.error("record not found");process.exit(1)'] },
};
const unavailableBackend: CliBackend = { available: false, unavailableReason: 'Controlled unavailable fixture',
  execute: async () => ({ result: { ok: false, code: 'CLI_SANDBOX_UNAVAILABLE', data: {} }, settled: true, effectsKnown: true }) };

/** CLI stderr is produced by real Node processes; sandbox availability is an explicit backend dependency fixture. */
export async function failureGuidanceAcceptance(label: string) {
  const f = await LocalFixture.create();
  try {
    await configureRuntime(f, [nodeEntry], label === '沙箱不可用' ? { backend: unavailableBackend } : {});
    f.replies.push(failureActions[label], { type: 'answer', text: '已保留失败证据，尚未执行修正。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const operation = f.h.context().intents[0]!.localOperations![0]!;
    const original = structuredClone(operation.result);
    const observation = guidance(f.requests[1]!);
    assert.equal(observation.failures.length, 1); assert.equal(observation.failures[0]!.operationId, operation.id);
    assert(observation.failures[0]!.nextStep.length > 0);
    assert.deepEqual(f.h.context().intents[0]!.localOperations![0]!.result, original);
    assert.equal(f.h.context().intents[0]!.localOperations!.length, 1);
    assert(f.backend.calls.length <= 1, 'Diagnosis must not start another process');
    assert.equal(f.requests.length, 2);
    return { observation, original, operation, executions: f.backend.calls.length };
  } finally { await f.close(); }
}

export async function correctedCliAcceptance() {
  const f = await LocalFixture.create('方案师', true);
  try {
    await configureRuntime(f, [nodeEntry]); useGoal(f, 'read documents');
    const usage = f.h.context().usage.ordinary;
    f.replies.push(failureActions.未知参数,
      { type: 'runCli', executable: 'node', args: ['--help'] },
      { type: 'runCli', executable: 'node', args: ['--version'] },
      { type: 'answer', text: '依据真实帮助修正后，已取得运行时版本。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const work = f.h.context().intents[0]!, operations = work.localOperations!;
    assert.deepEqual(operations.map(op => op.status), ['failed', 'succeeded', 'succeeded']);
    assert.equal(guidance(f.requests[1]!).failures[0]!.category, 'arguments');
    assert.equal(guidance(f.requests[1]!).failures[0]!.operationId, operations[0]!.id);
    assert.deepEqual(guidance(f.requests[0]!).recommendations.cli.candidates[0]!.helpArgs, ['--help']);
    assert.deepEqual(f.backend.calls.map(call => call.args), [['--squad-invalid'], ['--help'], ['--version']]);
    assert(String(operations[1]!.result!.data.stdout).includes('Usage:'));
    assert.equal(operations[2]!.result!.data.stdout, `${process.version}\n`);
    assert.equal(f.h.context().usage.ordinary - usage, 7, 'Four model calls and three CLI calls use the original budget');
    assert.equal(work.toolRecovery, undefined, 'CLI guidance must not consume Web recovery opportunities');
    return { operations, executions: f.backend.calls.length, ordinaryUsed: f.h.context().usage.ordinary - usage };
  } finally { await f.close(); }
}

/** Rejection is feedback within the same work: a different help request remains possible. */
export async function repeatedCliAcceptance() {
  const f = await LocalFixture.create('方案师', true);
  try {
    await configureRuntime(f, [nodeEntry]); useGoal(f, 'read documents');
    const usage = f.h.context().usage.ordinary;
    f.replies.push(failureActions.未知参数, failureActions.未知参数, failureActions.未知参数, failureActions.未知参数,
      { type: 'runCli', executable: 'node', args: ['--help'] },
      { type: 'runCli', executable: 'node', args: ['--version'] },
      { type: 'answer', text: '相同失败达到上限后改查帮助，修正参数成功。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const operations = f.h.context().intents[0]!.localOperations!;
    assert.deepEqual(operations.map(op => op.status), ['failed', 'failed', 'succeeded', 'succeeded']);
    assert.equal(f.backend.calls.length, 4, 'The third identical command must never launch');
    assert.deepEqual(f.backend.calls.map(call => call.args), [['--squad-invalid'], ['--squad-invalid'], ['--help'], ['--version']]);
    assert(f.requests[3]!.messages.some(message => message.role === 'user' && message.content.includes('CLI_REPEAT_FAILURE_LIMIT')),
      'The same model work should receive the stable repeat-limit feedback');
    assert.equal(f.requests[4]!.messages.filter(message => message.role === 'user' && message.content.includes('CLI_REPEAT_FAILURE_LIMIT')).length, 2,
      'Repeated rejected requests with longer transcripts should remain distinct transport receipts');
    assert.equal(operations.at(-1)!.result!.data.stdout, `${process.version}\n`);
    assert.equal(f.h.context().usage.ordinary - usage, 11, 'Seven model calls and four CLI calls use the original budget');
    return { operations, executions: f.backend.calls.length, ordinaryUsed: f.h.context().usage.ordinary - usage };
  } finally { await f.close(); }
}
