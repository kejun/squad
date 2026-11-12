import assert from 'node:assert/strict';
import { sharedToolKnowledge } from '../src/task/tool-knowledge.js';
import { LocalModel } from './local-model-fixture.js';
import { CapacityModel, capacityModelIntent } from './map-capacity-model-fixture.js';
import type { Intent } from '../src/types.js';

export const capabilityData = {
  platform: 'linux', arch: 'arm64', runtime: { name: 'node', version: '24' },
  skills: { catalogVersion: 'skills-v1', skills: [{ skillId: 'tool-skill', skillVersion: 'v1', name: 'tool-skill', description: '读取资料' }], complete: true, nextCursor: null, diagnostics: [] },
  cli: { queriedOnly: true, commands: [{ command: 'yuque', sandbox: 'not_found', host: 'found' }],
    sandbox: { available: false, reason: 'controlled unavailable' }, hostApprovalRequired: true, presenceIsNotExecution: true,
    catalog: { catalogVersion: 'cli-v1', entries: [{ command: 'yuque', description: '读取资料', helpArgs: ['--help'], execution: 'host' }], nextCursor: null } },
  mcp: { status: 'not_connected', scope: 'this_service' },
};

export function capabilityFactModelGate(kind = '宿主能力', boundary = '成功') {
  const model = new LocalModel();
  const action = kind === '技能目录' ? { type: 'listSkills' as const } : kind === '沙箱失败'
    ? { type: 'runCli' as const, executable: 'yuque', args: ['--help'] }
    : { type: 'discoverHost' as const, commands: ['yuque'] };
  assert(model.request(action).ok); assert(model.claim().ok);
  const sandboxFailed = kind === '沙箱失败';
  const data = kind === '技能目录' ? structuredClone(capabilityData.skills) : sandboxFailed
    ? { stdout: '不应共享的失败输出', stderr: '不应共享的错误输出' } : structuredClone(capabilityData);
  assert(model.result({ result: { ok: !sandboxFailed && boundary !== '失败', code: sandboxFailed ? 'CLI_SANDBOX_UNAVAILABLE' : action.type, data },
    effectsKnown: boundary !== '效果不明' }).ok);
  const peer: Intent = { ...structuredClone(model.work), id: 'peer', target: 'B' };
  if (boundary === '旧目标') peer.goalVersion = ++model.c.goalVersion;
  if (boundary === '旧轮次') peer.epoch = ++model.c.epoch;
  if (boundary === '任务已停止') assert(model.send({ type: 'STOP' }).ok);
  if (boundary === '成员工具关闭') model.c.config.bots[1]!.localTools = false;
  if (boundary === '输入理解') peer.kind = 'interpretation';
  const facts = sharedToolKnowledge(model.c, peer);
  if (boundary !== '成功') assert.deepEqual(facts, []);
  else {
    assert.equal(facts.length, 1); assert.equal(facts[0]!.sourceOperationId, 'op1');
    assert.equal(facts[0]!.observationOnly, true); assert.equal(facts[0]!.requiresIndependentExecution, true);
    const fact = facts[0] as unknown as { observation: Record<string, unknown> };
    if (sandboxFailed) { assert.deepEqual(fact.observation, { sandbox: { available: false }, code: 'CLI_SANDBOX_UNAVAILABLE' }); assert(!JSON.stringify(facts).includes('不应共享')); }
    else if (kind === '技能目录') assert.deepEqual(fact.observation.skills, capabilityData.skills);
    else assert.deepEqual((fact.observation.cli as typeof capabilityData.cli).sandbox, capabilityData.cli.sandbox);
    assert.equal(model.c.usage.ordinary, sandboxFailed ? 2 : 1);
  }
  return { model, peer, facts };
}

export function boundedFactsModelGate() {
  const { model, peer } = capabilityFactModelGate();
  const source = model.c.intents[0]!;
  const original = source.localOperations![0]!;
  source.localOperations = Array.from({ length: 20 }, (_, index) => ({ ...structuredClone(original), id: `discovery-${index}` }));
  const oversized = source.localOperations.at(-1)!;
  oversized.result!.data = { ...structuredClone(capabilityData), skills: { ...capabilityData.skills,
    skills: Array.from({ length: 20 }, (_, index) => ({ skillId: `skill-${index}`, name: `skill-${index}`, skillVersion: 'v1', description: '说明'.repeat(1000) })) } };
  const facts = sharedToolKnowledge(model.c, peer);
  assert.equal(facts.length, 20);
  const last = facts.at(-1) as unknown as { metadataComplete: boolean; observation: { skills: { skills: { description: string }[] }; cli: { sandbox: { available: boolean } } } };
  assert.equal(last.metadataComplete, true); assert.equal(last.observation.cli.sandbox.available, false);
  assert.equal(last.observation.skills.skills.length, 20);
  assert.equal(last.observation.skills.skills[19]!.description, '说明'.repeat(1000));
  assert(!JSON.stringify(facts).includes('"missing-command"')); return facts;
}

export function fullPartitionModelGate(capacity: number) {
  const model = new CapacityModel(input => { input.config.limits.assists = capacity; });
  const spec = capacityModelIntent();
  spec.decomposition!.partitions = Array.from({ length: capacity }, (_, index) => ({ id: `part-${index + 1}`,
    objective: `来源 ${index + 1}${capacity === 4 ? ` 与 ${index + 5}` : ''}`, expectedOutput: '保留原始来源的独立事实' }));
  model.claim(); model.consume(); assert.equal(model.work.payload.maxPartitions, capacity); assert.equal(model.work.payload.maxConcurrentPartitions, 4);
  assert(model.interpret(spec).ok); assert.equal(model.context.discussion!.mapReduce!.queue!.length, capacity);
  assert.equal(model.pending('assistance').length, 4);
  // The real queue dispatches subsequent partitions on existing DISCUSSION_RESULT transitions.
  model.settleGroups(); if (capacity === 8) model.settleGroups();
  assert.equal(model.context.discussion!.results.length, capacity); assert.equal(model.pending('discussionSummary').length, 1);
  return model;
}

export function taskEfficiencyModelGate() {
  capabilityFactModelGate(); capabilityFactModelGate('技能目录'); capabilityFactModelGate('沙箱失败');
  for (const boundary of ['失败', '效果不明', '旧目标', '旧轮次', '任务已停止', '成员工具关闭', '输入理解']) capabilityFactModelGate('宿主能力', boundary);
  boundedFactsModelGate(); fullPartitionModelGate(4); fullPartitionModelGate(8);
}
