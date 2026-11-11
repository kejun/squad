import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFixture } from './local-tools-fixture.js';
import { hostUntil } from './host-approval-fixture.js';
import type { LocalAction } from '../src/local-operation.js';

type CliAction = Extract<LocalAction, { type: 'runCli' }>;
const plainCase = '普通宿主调用的空可选技能标识';
function originalAction(label: string, base: CliAction, knownSkillId: string): Record<string, unknown> {
  switch (label) {
    case plainCase: return { ...base, skillId: '' };
    case '可执行文件真实引用技能且技能标识为空': return { ...base, executable: '@skill/scripts/run.mjs', skillId: '' };
    case '参数真实引用技能且技能标识为空': return { ...base, args: ['@skill/scripts/run.mjs'], skillId: '' };
    case '工作目录真实引用技能且技能标识为空': return { ...base, cwd: '@skill/workspace', skillId: '' };
    case '非空未知技能标识': return { ...base, skillId: 'local:unregistered-skill' };
    case '非空未激活技能标识': return { ...base, skillId: knownSkillId };
    case '宿主调用缺少原因': { const { reason: _reason, ...withoutReason } = base; return { ...withoutReason, skillId: '' }; }
    case '仅含空白的技能标识': return { ...base, skillId: ' \t ' };
    default: throw new Error('Unknown optional-skill selection case: ' + label);
  }
}

/** Real SQLite/Runner/Adapter and host spawn. Only the model response is scripted. */
export async function optionalSkillSelectionAcceptance(label: string) {
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: {
    cliCatalog: [{ command: 'node', description: 'Run the registered private host reader', execution: 'host' }],
  } });
  const marker = join(fixture.source, 'approved-plain-host.txt');
  const base: CliAction = { type: 'runCli', executable: 'node', execution: 'host', reason: '调用已登记宿主读取入口，申请当前具体命令',
    args: ['-e', 'require("node:fs").appendFileSync(process.argv[1],"once\\n");console.log("approved host receipt")', marker] };
  const rawAction = originalAction(label, base, fixture.skillId), originalText = JSON.stringify(rawAction);
  fixture.replies.push(originalText, { type: 'answer', text: '已保留工具的真实处理结果。' });
  const runner = fixture.runner();
  let settled = false;
  const running = runner.runOne(fixture.h.room, fixture.h.task).finally(() => { settled = true; });
  try {
    if (label === plainCase) {
      const progress = await hostUntil(() => ({ settled, modelRequests: fixture.requests.length,
        owner: fixture.h.context().intents.find(work => work.kind === 'owner')! }),
      value => value.settled || value.modelRequests > 1 || value.owner.localOperations?.some(operation => operation.status === 'awaitingApproval') === true);
      const operation = progress.owner.localOperations?.[0];
      assert.equal(fixture.requests.length, 1, 'An empty optional skillId on a plain host call must not add a model repair request');
      assert.equal(operation?.status, 'awaitingApproval', 'The first plain host choice must reach its exact approval before any process starts');
      assert(operation?.approval);
      assert.equal(operation.startedAt, undefined); assert.equal(fixture.backend.calls.length, 0); assert(!existsSync(marker));
      assert.equal(Object.hasOwn(operation.action, 'skillId'), false, 'Persist the canonical plain call without an optional skill binding');
      assert.deepEqual(operation.action, base, 'Optional-field handling must preserve the exact executable, arguments, environment choice and reason');
      assert.deepEqual(progress.owner.localSkills ?? [], []);
      assert(progress.owner.localCheckpoint?.messages.some(message => message.role === 'assistant' && message.content === originalText),
        'Keep the original assistant response while persisting the canonical tool action');
      assert.deepEqual(operation.approval.plan.args, base.args);
      assert.equal(operation.approval.plan.reason, base.reason);
      assert(fixture.h.engine.decideHostApproval(fixture.h.room, fixture.h.task, progress.owner.id,
        operation.id, operation.approval.id, 'approve', 'approve-canonical-plain-host').ok);
      fixture.runtime.notifyWorkspace(`approval:${operation.id}`);
      await running;
      assert.equal(await readFile(marker, 'utf8'), 'once\n');
      assert.equal(fixture.backend.calls.length, 0); assert.equal(fixture.requests.length, 2);
      const owner = fixture.h.context().intents.find(work => work.id === progress.owner.id)!;
      assert.equal(owner.localOperations!.length, 1); assert.equal(owner.localOperations![0]!.status, 'succeeded');
      assert.equal(owner.localOperations![0]!.result!.data.execution, 'host');
      assert.deepEqual(owner.localSkills ?? [], []);
      return { label, accepted: true, firstChoiceModelRequests: 1, modelRequests: fixture.requests.length,
        executions: 1, sandboxCalls: fixture.backend.calls.length, rawResponsePreserved: true, canonicalHasSkillId: false,
        skillBindings: 0, rejection: null };
    }
    await running;
    const owner = fixture.h.context().intents.find(work => work.kind === 'owner')!;
    const operations = owner.localOperations ?? [];
    assert(!existsSync(marker)); assert.equal(fixture.backend.calls.length, 0);
    assert(operations.every(operation => operation.startedAt === undefined && operation.approval === undefined));
    assert.deepEqual(owner.localSkills ?? [], []);
    const semanticSkill = label === '非空未知技能标识' || label === '非空未激活技能标识';
    const expectedCode = semanticSkill ? 'SKILL_NOT_ACTIVE' : 'invalid_tool_request';
    assert(fixture.requests.slice(1).some(request => request.messages.some(message => message.content.includes(expectedCode))),
      `Preserve the original ${expectedCode} rejection for ${label}`);
    if (semanticSkill) {
      assert.equal(operations.length, 1); assert.equal(operations[0]!.result!.code, 'SKILL_NOT_ACTIVE');
      assert.deepEqual(operations[0]!.action, rawAction);
    } else assert.equal(operations.length, 0);
    return { label, accepted: false, firstChoiceModelRequests: 1, modelRequests: fixture.requests.length,
      executions: 0, sandboxCalls: fixture.backend.calls.length, rawResponsePreserved: false,
      canonicalHasSkillId: true, skillBindings: 0, rejection: expectedCode };
  } finally {
    if (!settled) runner.abortExecutions();
    await running.catch(() => {});
    await fixture.close();
  }
}
