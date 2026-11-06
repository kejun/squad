import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFixture } from './local-tools-fixture.js';
import { LocalModel } from './local-model-fixture.js';
import type { discoverHostCapabilities } from '../src/host-capabilities.js';
type CapabilityReport = Awaited<ReturnType<typeof discoverHostCapabilities>>;

export interface HostCapabilityObservation { ordinary: number; backendCalls: number; actionTypes: string[]; statuses: string[]; instructions: string; receipts: string[] }
export async function hostCapabilityAcceptance(useTools = false, observe?: (data: HostCapabilityObservation) => void) {
  const f = await LocalFixture.create('方案师', true);
  try {
    const bin = join(f.root, 'bin'); await mkdir(bin);
    const marker = join(f.root, 'should-not-run');
    const probe = join(bin, 'squad-probe');
    await writeFile(probe, `#!/bin/sh\nprintf bad > '${marker}'\n`); await chmod(probe, 0o755);
    f.runtime.options.commandEnv = { 'squad-probe': { PATH: bin, PRIVATE_TOKEN: 'never-return-this-token' } };
    f.replies.push({ type: 'discoverHost', commands: ['node', 'squad-probe', 'squad-deliberately-missing-cmd'] },
      ...(useTools ? f.actions() : []), { type: 'answer', text: '已核实能力并使用受支持接口。' });
    await f.runner().runOne(f.h.room, f.h.task);
    const work = f.h.context().intents.find(w => w.kind === 'owner')!;
    const op = work.localOperations?.[0];
    assert.equal(op?.action.type, 'discoverHost'); assert.equal(op.status, 'succeeded');
    assert.equal(op.attempt, 1); assert.equal(op.workspaceId, undefined);
    const report = op.result!.data as unknown as CapabilityReport;
    assert.equal(report.platform, process.platform); assert.equal(report.arch, process.arch);
    assert.equal(report.runtime.version, process.version);
    assert.equal(report.skills.skills[0]?.skillId, f.skillId);
    assert.equal(report.skills.complete, true);
    assert.deepEqual(report.cli.commands, [
      { command: 'node', sandbox: 'found', host: 'found' },
      { command: 'squad-probe', sandbox: 'found', host: 'found' },
      { command: 'squad-deliberately-missing-cmd', sandbox: 'not_found', host: 'not_found' },
    ]);
    assert.equal(report.cli.sandbox.available, true); assert.equal(report.cli.hostApprovalRequired, true);
    assert.equal(report.cli.presenceIsNotExecution, true); assert.equal(report.cli.queriedOnly, true);
    assert.equal(report.mcp.status, 'not_connected'); assert.equal(report.mcp.scope, 'this_service');
    assert(!JSON.stringify(report).includes('never-return-this-token'));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(f.backend.calls.length, useTools ? 1 : 0);
    assert.equal(f.h.context().usage.ordinary, useTools ? 8 : 2); // Model continuation is charged; discovery itself is free.
    const instructions = f.requests[0]!.messages[0]!.content;
    assert(instructions.includes('Before choosing an unfamiliar host tool'));
    assert(instructions.includes('Only queried commands are checked; absence from the result means unknown'));
    assert(instructions.includes('The service has no native MCP transport: do not invent MCP tool calls'));
    assert(f.requests[1]!.messages.some(message => message.content.includes('squad-probe') && message.content.includes('not_connected')));
    if (useTools) {
      assert.deepEqual(work.localOperations?.map(item => item.action.type), ['discoverHost', 'loadSkill', 'readSkillResource', 'runCli']);
      assert(work.localOperations?.every(item => item.status === 'succeeded'));
      assert.equal(await readFile(join(f.source, 'dist/runs.txt'), 'utf8'), 'once\n');
      assert(f.requests.at(-1)!.messages.some(message => message.content.includes('skill-ok')));
    }
    observe?.({ ordinary: f.h.context().usage.ordinary, backendCalls: f.backend.calls.length, actionTypes: (work.localOperations ?? []).map(op => op.action.type), statuses: (work.localOperations ?? []).map(op => op.status), instructions, receipts: f.requests.flatMap(request => request.messages.map(message => message.content)) });
    return report;
  } finally { await f.close(); }
}

export function hostCapabilityGuardAcceptance(constraint: string) {
  const m = new LocalModel(i => { if (constraint === '工具关闭') i.config.localTools = { enabled: false }; });
  if (constraint === '已停止') m.send({ type: 'STOP' });
  if (constraint === '旧目标') m.c.goalVersion++;
  if (constraint === '解析阶段') m.work.kind = 'interpretation';
  if (constraint === '未授权') delete (m.work.payload.capabilities as Record<string, unknown>).localTools;
  const invalid: Record<string, object> = {
    '非法命令路径': { commands: ['/usr/bin/node'] }, '相对路径穿越': { commands: ['../node'] }, '命令夹带参数': { commands: ['node --version'] },
    '命令替换表达式': { commands: ['$(whoami)'] }, '过量命令': { commands: Array(21).fill('node') }, '空命令': { commands: [''] },
    '发现请求指定宿主执行': { commands: ['node'], execution: 'host' }, '发现请求伪造批准': { commands: ['node'], approval: true },
  };
  const action = { type: 'discoverHost', ...(invalid[constraint] ?? { commands: ['node'] }) };
  const result = m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action,
    parentAttempt: m.work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], fence: m.work });
  assert.equal(m.op, undefined); assert.equal(m.c.usage.ordinary, 1);
  return { ...result, model: m };
}
