import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRuntime } from '../src/local-runtime.js';
import type { CliCatalogEntry } from '../src/cli-catalog.js';
import { withToolInventoryReadiness } from '../src/cli-readiness.js';
import { LocalFixture, writeSkill } from './local-tools-fixture.js';
import { HostApprovalFixture, hostUntil } from './host-approval-fixture.js';
import { directHostSelectionModel, unifiedToolBoundaryModel } from './unified-tool-context-model-fixture.js';

import { inventoryObservation } from './tool-inventory-observation.js';
export { inventoryObservation, type InventoryObservation } from './tool-inventory-observation.js';

export const hostReader: CliCatalogEntry = { command: 'node', description: 'Read private knowledge-base documents using the service account',
  domains: ['yuque.com'], execution: 'host', helpArgs: ['--help'], requirements: ['The host service account must already have access'],
  examples: [{ description: '读取语雀私有文档', args: ['--version'] }] };

function submitGoal(fixture: LocalFixture, text: string) {
  fixture.h.room = 'unified-tool-context';
  const reply = fixture.h.engine.submit(fixture.h.room, { id: 'unified-input', text,
    goal: { text, constraints: [], criteria: ['保留真实工具结果'], requiredArtifacts: 0 } });
  assert(reply.ok && reply.taskId); fixture.h.task = reply.taskId;
}

export async function completeToolInventoryAcceptance() {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    const entries = [hostReader, ...Array.from({ length: 70 }, (_, index) => ({ command: `archive-${index}`,
      description: 'Archive historical files without matching the current Chinese task' }))];
    for (let index = 0; index < 28; index++) await writeSkill(fixture.skills, `archive-skill-${index}`, 'Unrelated archived engineering workflow');
    await fixture.runtime.close();
    fixture.runtime = await LocalRuntime.create({ ...fixture.runtime.options, cliCatalog: entries, catalogRefreshIntervalMs: 0 });
    submitGoal(fixture, '根据语雀私有文档整理十月团队工作');
    const usage = fixture.h.context().usage.ordinary;
    fixture.replies.push({ type: 'discoverHost', query: '语雀私有文档', commands: ['node'] },
      { type: 'answer', text: '已读取渐进式工具上下文与召回元信息，尚未执行命令或取得文档。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const inventory = inventoryObservation(fixture.requests[0]!);
    assert.equal(inventory.catalogProjection, 'progressive');
    assert.equal(inventory.cli.entryCount, entries.length);
    assert.equal(inventory.cli.entries.length, 0);
    assert.equal(inventory.skills.skillCount, 29);
    assert.equal(inventory.skills.skills.length, 0);
    assert(inventory.interfaces.some(tool => tool.type === 'web_fetch'));
    assert(inventory.interfaces.some(tool => tool.type === 'web_search'));
    assert.equal(fixture.backend.calls.length, 0);
    const discovered = inventoryObservation(fixture.requests[1]!);
    const reader = discovered.cli.entries.find(entry => entry.command === 'node')!;
    assert.deepEqual(reader.examples, hostReader.examples);
    assert.deepEqual(reader.variants.map(variant => variant.execution), ['sandbox', 'host']);
    assert.equal(reader.variants.find(variant => variant.execution === 'host')!.approvalRequired, true);
    assert(reader.variants.every(variant => variant.readiness.authentication === 'unknown' && variant.readiness.network === 'unknown'));
    assert.equal(fixture.h.context().intents[0]!.localOperations?.length, 1);
    assert.equal(fixture.h.context().usage.ordinary - usage, 2);
    return { inventory, modelRequests: fixture.requests.length, executions: fixture.backend.calls.length,
      ordinaryUsed: fixture.h.context().usage.ordinary - usage };
  } finally { await fixture.close(); }
}

export async function directHostInventoryAcceptance(decision: string) {
  directHostSelectionModel(decision);
  const fixture = new HostApprovalFixture();
  let sandboxCalls = 0;
  fixture.runtimeOptions = { cliCatalog: [{ ...hostReader, command: 'fixture-cli' }], catalogRefreshIntervalMs: 0 };
  fixture.sandboxBackend = { available: true, async execute() { sandboxCalls++; throw new Error('A host selection must not manufacture a sandbox attempt'); } };
  try {
    await fixture.open();
    fixture.runtime.options.commandEnv = { 'fixture-cli': { PATH: `${fixture.root}:${process.env.PATH ?? '/usr/bin:/bin'}` } };
    assert(fixture.action.type === 'runCli');
    fixture.action = { ...fixture.action, executable: 'fixture-cli' };
    fixture.submit();
    const approval = await fixture.approval();
    const inventory = inventoryObservation(fixture.requests[0]!);
    assert.equal(inventory.cli.entries[0]!.command, 'fixture-cli');
    assert.equal(inventory.cli.entries[0]!.execution, 'host');
    const before = fixture.service.engine.view(fixture.room.id, fixture.taskId)!.context.intents.flatMap(work => work.localOperations ?? []);
    assert.equal(before.length, 1); assert.equal(before[0]!.action.type, 'runCli');
    assert.equal(before[0]!.status, 'awaitingApproval'); assert.equal(before[0]!.startedAt, undefined);
    assert.equal(sandboxCalls, 0); assert.equal(await fixture.runs(), '');
    assert.equal(fixture.requests.length, 1, 'Direct host selection must not need discovery or a sandbox failure first');
    assert.equal(approval.executable, fixture.executable);
    if (decision === '明确批准') {
      assert.equal((await fixture.request(fixture.decisionData(approval, 'approve'))).status, 200);
      await fixture.assertSuccessfulRun();
    } else if (decision === '明确拒绝') {
      assert.equal((await fixture.request(fixture.decisionData(approval, 'deny'))).status, 200);
      await fixture.complete();
      assert.equal(fixture.operation()!.result!.code, 'HOST_APPROVAL_DENIED');
    } else if (decision === '授权过期') {
      const operation = fixture.operation()!;
      assert(fixture.service.engine.send(fixture.room.id, fixture.taskId, { type: 'LOCAL_APPROVAL_EXPIRED', id: 'inventory-expired',
        at: operation.approval!.expiresAt, intentId: approval.workId, operationId: approval.operationId }).ok);
      assert.equal((await fixture.request(fixture.decisionData(approval, 'approve'))).status, 409);
      assert.equal(fixture.operation()!.startedAt, undefined);
    } else assert.equal(decision, '尚未决定');
    const runs = await fixture.runs();
    assert.equal(runs, decision === '明确批准' ? 'once\n' : ''); assert.equal(sandboxCalls, 0);
    return { inventory, sandboxCalls, runs, firstModelRequests: 1, approval,
      operationStatus: fixture.operation()!.status, execution: fixture.operation()!.result?.data.execution };
  } finally { await fixture.close(); }
}

async function fileInventoryFixture(entries: CliCatalogEntry[], interval = 0) {
  const fixture = await LocalFixture.create('方案师', true);
  const catalogFile = join(fixture.root, 'cli-catalog.json');
  await writeFile(catalogFile, JSON.stringify(entries));
  await fixture.runtime.close();
  const { cliCatalog: _catalog, ...options } = fixture.runtime.options;
  fixture.runtime = await LocalRuntime.create({ ...options, cliCatalogFile: catalogFile, catalogRefreshIntervalMs: interval });
  submitGoal(fixture, '直接依据完整目录选择已接入的工具');
  return { fixture, catalogFile };
}
const extraReader: CliCatalogEntry = { command: 'new-reader', description: '新增的中文资料读取入口', execution: 'host' };

export async function inventoryRefreshAcceptance(kind: string) {
  const { fixture, catalogFile } = await fileInventoryFixture([hostReader], kind === '配置变化触发刷新' ? 60_000 : 0);
  try {
    if (kind === '周期核对发现变化') {
      await fixture.runtime.close();
      const { cliCatalogFile: _file, ...options } = fixture.runtime.options;
      fixture.runtime = await LocalRuntime.create({ ...options, cliCatalog: [hostReader], catalogRefreshIntervalMs: 40 });
    }
    const original = fixture.runtime.toolInventory();
    const toolVersion = fixture.h.config.toolVersion;
    fixture.beforeModelResponse = async (_request, index) => {
      if (index !== 0) return;
      if (kind === '技能源变化后刷新') {
        await writeSkill(fixture.skills, 'new-source-reader', '新增技能');
        await fixture.runtime.refreshToolInventory();
      } else if (kind === '周期核对发现变化') {
        fixture.runtime.options.cliCatalog = [hostReader, extraReader];
        await hostUntil(() => fixture.runtime.toolInventory(), snapshot => snapshot.catalogVersion !== original.catalogVersion);
      } else {
        assert.equal(kind, '配置变化触发刷新');
        await writeFile(catalogFile, JSON.stringify([hostReader, extraReader]));
        await hostUntil(() => fixture.runtime.toolInventory(), snapshot => snapshot.catalogVersion !== original.catalogVersion);
      }
    };
    fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'] },
      { type: 'help', requestId: 'second-member', target: 'B', question: '依据当前工具目录说明可用接口', expected: '真实目录与前提' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const member = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(work => work.kind === 'assistance')!;
    assert(member); fixture.replies.push({ type: 'answer', text: '已读取新发布的完整目录。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task, member.id);
    const views = fixture.requests.map(inventoryObservation);
    assert.equal(views.length, 3);
    assert.equal(views[0]!.catalogVersion, original.catalogVersion);
    assert.notEqual(views[1]!.catalogVersion, original.catalogVersion);
    assert.equal(views[2]!.catalogVersion, views[1]!.catalogVersion);
    if (kind === '技能源变化后刷新') {
      assert(!views[0]!.skills.skills.some(skill => skill.name === 'new-source-reader'));
      assert(views[1]!.skills.skills.some(skill => skill.name === 'new-source-reader'));
    } else {
      assert.equal(views[0]!.cli.entries.length, 1); assert.equal(views[1]!.cli.entries.length, 2);
    }
    assert.equal(fixture.h.config.toolVersion, toolVersion);
    assert.equal(fixture.h.context().config.toolVersion, toolVersion);
    assert.equal(fixture.backend.calls.length, 1);
    assert.equal(original.cli.entries.length, 1, 'An already published snapshot must remain a coherent old view');
    return { kind, views, executions: fixture.backend.calls.length, contractVersionUnchanged: true };
  } finally { await fixture.close(); }
}

export async function inventoryRefreshFailureAcceptance(failure: string) {
  const { fixture, catalogFile } = await fileInventoryFixture([hostReader]);
  try {
    const original = fixture.runtime.toolInventory();
    const skillFile = join(fixture.skills, 'local-check', 'SKILL.md');
    const originalSkill = await readFile(skillFile, 'utf8');
    if (failure === '无效目录配置') await writeFile(catalogFile, '{broken JSON');
    else if (failure === '目录文件读取失败') await rm(catalogFile);
    else if (failure === '技能元信息损坏') await writeFile(skillFile, 'invalid skill metadata');
    else { assert.equal(failure, '技能源读取失败'); await rename(fixture.skills, fixture.skills + '-unavailable'); }
    const failed = await fixture.runtime.refreshToolInventory();
    assert.equal(failed.catalogVersion, original.catalogVersion);
    assert.deepEqual(failed.cli.entries, original.cli.entries);
    assert.equal(failed.refresh.status, 'failed'); assert(failed.refresh.error);
    fixture.replies.push({ type: 'answer', text: '已保留最后有效目录并报告刷新故障。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const observed = inventoryObservation(fixture.requests[0]!);
    assert.equal(observed.catalogVersion, original.catalogVersion); assert.equal(observed.refresh.status, 'failed');
    if (failure === '技能源读取失败') await rename(fixture.skills + '-unavailable', fixture.skills);
    else if (failure === '技能元信息损坏') await writeFile(skillFile, originalSkill);
    await writeFile(catalogFile, JSON.stringify([hostReader, extraReader]));
    const recovered = await fixture.runtime.refreshToolInventory();
    assert.notEqual(recovered.catalogVersion, original.catalogVersion);
    assert.equal(recovered.refresh.status, 'current'); assert.equal(recovered.refresh.error, undefined);
    assert.equal(recovered.cli.entries.length, 2);
    assert.equal(fixture.backend.calls.length, 0);
    return { failure, observed, recovered, executions: fixture.backend.calls.length };
  } finally { await fixture.close(); }
}

async function registeredInputReadinessAcceptance() {
  const args = ['-e', 'console.error("authentication required");process.exit(1)'];
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: { cliCatalog: [{ command: 'node',
    description: 'Read a registered authentication diagnostic', examples: [{ description: 'Authentication diagnostic without standard input', args }] }] } });
  try {
    fixture.replies.push({ type: 'runCli', executable: 'node', args, execution: 'sandbox', stdin: { path: 'source.txt' } },
      { type: 'runCli', executable: 'node', args, execution: 'sandbox' }, { type: 'answer', text: '仅按实际调用范围保留认证观测。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const withStdin = inventoryObservation(fixture.requests[1]!).cli.entries[0]!.variants.find(variant => variant.execution === 'sandbox')!.readiness;
    const withoutStdin = inventoryObservation(fixture.requests[2]!).cli.entries[0]!.variants.find(variant => variant.execution === 'sandbox')!.readiness;
    assert.equal(withStdin.authentication, 'unknown', 'An invocation with extra stdin must not establish authentication for a no-stdin catalog example');
    assert.equal(withoutStdin.authentication, 'required', 'An exact no-stdin invocation must retain its own authentication observation');
    assert.equal(withStdin.installation, 'found'); assert.equal(withoutStdin.installation, 'found');
    assert.equal(withStdin.network, 'unknown'); assert.equal(withoutStdin.network, 'unknown');
    assert.equal(fixture.backend.calls.length, 2);
    return { withStdin: withStdin.authentication, withoutStdin: withoutStdin.authentication };
  } finally { await fixture.close(); }
}

export async function sharedInventoryObservationAcceptance() {
  const stdinAuthentication = await registeredInputReadinessAcceptance();
  const { fixture, catalogFile } = await fileInventoryFixture([{ ...hostReader, execution: 'sandbox' }]);
  try {
    const published = fixture.runtime.toolInventory();
    fixture.replies.push({ type: 'discoverHost', commands: ['node'] },
      { type: 'help', requestId: 'metadata-handoff', target: 'B', question: '直接使用已知工具返回运行时版本', expected: '真实工具回执' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const owner = fixture.h.context().intents.find(work => work.kind === 'owner')!;
    const discovery = owner.localOperations![0]!;
    const member = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(work => work.kind === 'assistance')!;
    assert(member);
    const requestsBefore = fixture.requests.length;
    await writeFile(catalogFile, '{broken config must not be read by a decision getter');
    await writeFile(join(fixture.skills, 'local-check', 'SKILL.md'), 'broken skill must not be rescanned by a decision getter');
    fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'] }, { type: 'answer', text: '已直接复用共享目录和存在性观测。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task, member.id);
    const views = fixture.requests.map(inventoryObservation);
    assert(views.every(view => view.catalogVersion === published.catalogVersion && view.refresh.status === 'current'));
    const memberViews = views.slice(requestsBefore);
    assert.equal(memberViews.length, 2);
    const readiness = memberViews[0]!.cli.entries[0]!.variants.find(variant => variant.execution === 'sandbox')!.readiness;
    assert.equal(readiness.installation, 'found'); assert.equal(readiness.authentication, 'unknown'); assert.equal(readiness.network, 'unknown');
    assert(readiness.sourceOperationIds.includes(discovery.id)); assert.equal(readiness.observedAt, discovery.finishedAt);
    assert.equal(memberViews[0]!.executionAuthority, false);
    const memberOperations = fixture.h.context().intents.find(work => work.id === member.id)!.localOperations!;
    assert.deepEqual(memberOperations.map(operation => operation.action.type), ['runCli']);
    assert.equal(fixture.backend.calls.length, 1);
    assert.equal(fixture.runtime.toolInventory().refresh.status, 'current');
    return { views, memberViews, executions: fixture.backend.calls.length, discoveryOperations: 1, extraDiscoveryOperations: 0, stdinAuthentication };
  } finally { await fixture.close(); }
}

export async function pinnedSkillInventoryAcceptance() {
  const { fixture } = await fileInventoryFixture([hostReader]);
  try {
    const original = fixture.runtime.toolInventory();
    const skill = original.skills.skills.find(item => item.skillId === fixture.skillId)!;
    const guide = join(fixture.skills, 'local-check', 'references', 'guide.md');
    const originalGuide = await readFile(guide, 'utf8');
    fixture.beforeModelResponse = async (_request, index) => {
      if (index !== 1) return;
      await writeFile(guide, '新版本的引用内容，不应静默替换任务已固定的内容');
      await fixture.runtime.refreshToolInventory();
    };
    fixture.replies.push({ type: 'loadSkill', skillId: fixture.skillId },
      { type: 'readSkillResource', skillId: fixture.skillId, path: 'references/guide.md' },
      { type: 'answer', text: '继续使用本任务已经固定的技能内容。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const last = inventoryObservation(fixture.requests.at(-1)!);
    const currentSkill = last.skills.skills.find(item => item.skillId === fixture.skillId)!;
    assert.notEqual(currentSkill.skillVersion, skill.skillVersion);
    const owner = fixture.h.context().intents.find(work => work.kind === 'owner')!;
    assert.equal(owner.localSkills![0]!.skillVersion, skill.skillVersion);
    assert.equal(owner.localOperations!.find(operation => operation.action.type === 'readSkillResource')!.result!.data.content, originalGuide);
    assert(fixture.requests.at(-1)!.messages.some(message => message.content.includes(skill.skillVersion)),
      'The model must retain the loaded version in its actual tool receipt while seeing the new catalog version');
    assert.equal(fixture.backend.calls.length, 0);
    // A normal removal is a valid new inventory generation, not a scan failure.
    await rm(join(fixture.skills, 'local-check'), { recursive: true });
    const removed = await fixture.runtime.refreshToolInventory();
    assert.equal(removed.refresh.status, 'current'); assert.equal(removed.skills.skills.length, 0);
    return { oldVersion: skill.skillVersion, currentVersion: currentSkill.skillVersion,
      originalContentPreserved: true, executions: fixture.backend.calls.length, normalRemovalPublished: true };
  } finally { await fixture.close(); }
}

export async function inventoryBoundaryAcceptance(boundary: string) {
  const model = unifiedToolBoundaryModel(boundary);
  if (boundary !== '最终固定材料检查') {
    if (boundary === '已停止' || boundary === '本地工具撤权') {
      const { fixture } = await fileInventoryFixture([hostReader]);
      try {
        fixture.beforeModelResponse = async (_request, index) => {
          if (index !== 0) return;
          if (boundary === '已停止') assert(fixture.h.event({ type: 'STOP' }).ok);
          else fixture.h.config.localTools = { enabled: false };
        };
        fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'], execution: 'host', reason: '响应期间权限边界变化' });
        await fixture.runner().runOne(fixture.h.room, fixture.h.task);
        assert.equal(fixture.backend.calls.length, 0);
        assert.equal(fixture.requests.length, 1, 'A hidden inventory caused by revocation must not create metadata-change model loops');
        assert.equal(fixture.h.context().intents.flatMap(work => work.localOperations ?? []).length, 0);
        return { boundary, modelAllowed: false, checkInventoryMessages: 0, dynamicSelectionRequests: fixture.requests.length };
      } finally { await fixture.close(); }
    }
    return { boundary, modelAllowed: false, checkInventoryMessages: 0 };
  }
  const fixture = await LocalFixture.create('最终检查', true);
  try {
    fixture.replies.push({ type: 'check', passed: true, gaps: [] });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    assert.equal(fixture.requests.length, 1);
    assert(!fixture.requests[0]!.messages.some(message => message.content.includes('"type":"tool_inventory"')));
    assert(!fixture.requests[0]!.messages.some(message => message.content.includes('"type":"tool_guidance"')));
    return { boundary, modelAllowed: false, checkInventoryMessages: 0, outcome: fixture.h.context().outcome };
  } finally { await fixture.close(); }
}

export async function incompleteInventoryAcceptance(kind: string) {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    await fixture.runtime.close();
    const { cliCatalog: _catalog, ...options } = fixture.runtime.options;
    if (kind === '技能源扫描达到边界') await writeSkill(fixture.skills, 'second-reader', '第二个读取工具');
    fixture.runtime = await LocalRuntime.create({ ...options, catalogRefreshIntervalMs: 0,
      cliDiscovery: { paths: [join(fixture.root, 'empty-path')], manRoots: [], systemPackageRoot: join(fixture.root, 'no-packages') },
      ...(kind === 'CLI目录明确为空' ? { cliCatalog: [] } : {}),
      ...(kind === '技能源缺失' ? { skillRoots: [join(fixture.root, 'missing-skills')] } : {}),
      ...(kind === '技能源扫描达到边界' ? { registryLimits: { maxSkills: 1 } } : {}) });
    submitGoal(fixture, '确认本服务实际接入的工具和未知前提');
    fixture.replies.push({ type: 'discoverHost', commands: [] },
      { type: 'answer', text: '显式核对同代公开目录，只报告已接入内容，不把未知状态当成能力。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const inventory = inventoryObservation(fixture.requests[0]!);
    assert.equal(inventory.cli.configuration.state, 'empty');
    assert.equal(inventory.cli.configuration.source, kind === 'CLI目录明确为空' ? 'configured' : 'automatic');
    assert.equal(inventory.cli.entries.length, 0); assert.equal(inventory.executionAuthority, false);
    if (kind === 'CLI目录自动发现为空' || kind === 'CLI目录明确为空') {
      const counterpart = await LocalRuntime.create({ ...options, dataRoot: join(fixture.root, 'comparison-runtime'),
        catalogRefreshIntervalMs: 0, cliDiscovery: { paths: [join(fixture.root, 'empty-path')], manRoots: [], systemPackageRoot: join(fixture.root, 'no-packages') },
        ...(kind === 'CLI目录自动发现为空' ? { cliCatalog: [] } : {}) });
      try {
        const alternate = counterpart.toolInventory();
        assert.equal(alternate.cli.configuration.state, 'empty');
        assert.equal(alternate.cli.configuration.source, kind === 'CLI目录自动发现为空' ? 'configured' : 'automatic');
        assert.deepEqual(alternate.cli.entries, inventory.cli.entries);
        assert.equal(alternate.cli.catalogVersion, inventory.cli.catalogVersion,
          'The existing entry-only catalog and cursor identity may remain equal for two empty entry sets');
        assert.equal(alternate.skills.catalogVersion, inventory.skills.catalogVersion);
        assert.deepEqual(alternate.environment, inventory.environment);
        assert.notEqual(alternate.catalogVersion, inventory.catalogVersion,
          'Different visible CLI configuration states require different inventory observation versions');
      } finally { await counterpart.close(); }
    }
    if (kind === '技能源扫描达到边界') {
      assert.equal(inventory.skills.complete, false); assert.equal(inventory.skills.skillCount, 1);
      assert.equal(inventory.skills.skills.length, 0);
      assert(inventory.skills.diagnostics.some(diagnostic => diagnostic.code === 'SKILLS_SCAN_LIMIT'));
    }
    const localCatalog = fixture.runtime.catalog(), allSkills = fixture.runtime.registry.all();
    const discovery = fixture.h.context().intents.flatMap(work => work.localOperations ?? [])
      .find(operation => operation.action.type === 'discoverHost');
    assert(discovery?.result?.ok);
    const discoveredSkills = discovery.result.data.skills as ReturnType<LocalRuntime['catalog']>;
    if (kind === '技能源缺失') {
      assert.equal(inventory.skills.complete, false);
      assert.deepEqual(inventory.skills.skills, []);
      assert.deepEqual(inventory.skills.diagnostics, [{ source: join(fixture.root, 'missing-skills'), code: 'SKILLS_ROOT_MISSING' }]);
    }
    assert.equal(localCatalog.complete, inventory.skills.complete,
      'The same skill generation must report consistent completeness through the public local catalog');
    assert.equal(allSkills.complete, inventory.skills.complete,
      'The same skill generation must report consistent completeness through the full skill registry');
    assert.equal(discoveredSkills.complete, inventory.skills.complete,
      'The same skill generation must report consistent completeness through host discovery');
    assert.equal(inventory.skills.skillCount ?? inventory.skills.skills.length, localCatalog.skills.length);
    assert.deepEqual(localCatalog.skills, allSkills.skills);
    assert.deepEqual(discoveredSkills.skills, allSkills.skills);
    if (inventory.skills.skills.length) assert.deepEqual(localCatalog.skills, inventory.skills.skills);
    assert.deepEqual(localCatalog.diagnostics, inventory.skills.diagnostics); assert.deepEqual(allSkills.diagnostics, inventory.skills.diagnostics);
    assert.deepEqual(discoveredSkills.diagnostics, inventory.skills.diagnostics);
    if (kind === '宿主MCP未接入本服务') {
      assert(!inventory.interfaces.some(tool => tool.type.startsWith('mcp')));
      assert(fixture.requests[0]!.messages[0]!.content.includes('no native MCP transport'));
    }
    assert.equal(fixture.backend.calls.length, 0);
    return { kind, inventory, executions: fixture.backend.calls.length, completeness: { inventory: inventory.skills.complete,
      local: localCatalog.complete, registry: allSkills.complete, discovery: discoveredSkills.complete } };
  } finally { await fixture.close(); }
}

/** Measurement only: no wall-clock threshold substitutes for behavioral acceptance. */
export async function inventoryReadPerformanceAcceptance() {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    for (let index = 0; index < 199; index++) await writeSkill(fixture.skills, `inventory-skill-${index}`, '可复用的资料读取和工程处理能力');
    const entries = [hostReader, ...Array.from({ length: 199 }, (_, index) => ({ command: `inventory-cli-${index}`,
      description: 'Configured document and workspace processing interface', execution: 'sandbox' as const,
      helpArgs: ['--help'], examples: [{ description: 'Read a requested document', args: ['read', '<resource>'] }] }))];
    await fixture.runtime.close();
    const started = performance.now();
    fixture.runtime = await LocalRuntime.create({ ...fixture.runtime.options, cliCatalog: entries, catalogRefreshIntervalMs: 0 });
    const publicationMs = performance.now() - started;
    submitGoal(fixture, '依据完整工具索引完成资料处理');
    fixture.replies.push({ type: 'discoverHost', commands: ['node'] }, { type: 'answer', text: '已保存存在性观测，不宣称已登录或取得正文。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const context = fixture.h.context(), owner = context.intents.find(work => work.kind === 'owner')!;
    const snapshot = fixture.runtime.toolInventory();
    assert.equal(snapshot.cli.entries.length, 200); assert.equal(snapshot.skills.skills.length, 200);
    const readIterations = 10_000, projectionIterations = 50;
    const readStart = performance.now();
    for (let index = 0; index < readIterations; index++) assert.equal(fixture.runtime.toolInventory(), snapshot);
    const snapshotReadMs = performance.now() - readStart;
    const projectionStart = performance.now();
    let serialized = '';
    for (let index = 0; index < projectionIterations; index++) {
      serialized = JSON.stringify(fixture.runtime.clean(withToolInventoryReadiness(context, owner, snapshot)));
    }
    const projectionAndSerializationMs = performance.now() - projectionStart;
    const observed = inventoryObservation(fixture.requests.at(-1)!);
    assert.equal(observed.catalogProjection, 'progressive');
    assert.equal(observed.cli.entryCount, 200);
    assert.equal(observed.cli.entries.length, 1);
    assert.equal(observed.skills.skillCount, 200);
    assert.equal(observed.skills.skills.length, 0);
    const node = observed.cli.entries.find(entry => entry.command === 'node')!;
    assert(node.variants.every(variant => variant.readiness.sourceOperationIds.length === 1));
    assert.equal(fixture.backend.calls.length, 0);
    return { cliCount: 200, skillCount: 200, publicationMs, readIterations, snapshotReadMs, projectionIterations,
      projectionAndSerializationMs, projectionAndSerializationMeanMs: projectionAndSerializationMs / projectionIterations,
      serializedBytes: Buffer.byteLength(serialized), sourceReceipts: owner.localOperations!.length,
      executions: fixture.backend.calls.length, boundary: 'Local snapshot/readiness/redaction/serialization measurement with saved discovery; no provider latency or accuracy claim' };
  } finally { await fixture.close(); }
}

export async function inventorySelectionChangeAcceptance(stage: string, change: string) {
  if (stage === '模型决策返回前') {
    const { fixture, catalogFile } = await fileInventoryFixture([hostReader]);
    const runner = fixture.runner();
    let running: Promise<boolean> | undefined;
    let settled = false;
    try {
      fixture.beforeModelResponse = async (_request, index) => {
        if (index === 0) {
          const entries = change === '选中条目已移除' ? [] : [{ ...hostReader, description: 'Changed private reader semantics' }];
          await writeFile(catalogFile, JSON.stringify(entries)); await fixture.runtime.refreshToolInventory();
        }
      };
      fixture.replies.push({ type: 'runCli', executable: 'node', args: ['--version'], execution: 'host', reason: '从当前目录选择宿主读取' },
        { type: 'answer', text: '已收到目录变化，尚未执行旧选择。' });
      running = runner.runOne(fixture.h.room, fixture.h.task).finally(() => { settled = true; });
      await hostUntil(() => ({ settled, requests: fixture.requests.length,
        operations: fixture.h.context().intents.flatMap(work => work.localOperations ?? []) }),
      progress => progress.settled || progress.requests > 1 || progress.operations.length > 0);
      assert.equal(fixture.h.context().intents.flatMap(work => work.localOperations ?? []).length, 0,
        'Changed tool metadata must not create a local operation or approval');
      await running;
      assert.equal(fixture.requests.length, 2);
      assert(fixture.requests[1]!.messages.some(message => message.content.includes('TOOL_METADATA_CHANGED')));
      assert.notEqual(inventoryObservation(fixture.requests[0]!).catalogVersion, inventoryObservation(fixture.requests[1]!).catalogVersion);
      assert.equal(fixture.h.context().intents[0]!.localOperations, undefined);
      assert.equal(fixture.backend.calls.length, 0);
      return { stage, change, executions: 0, code: 'TOOL_METADATA_CHANGED' };
    } finally {
      if (!settled) runner.abortExecutions();
      await running?.catch(() => {});
      await fixture.close();
    }
  }
  assert.equal(stage, '精确计划已获可信批准');
  const fixture = new HostApprovalFixture();
  fixture.runtimeOptions = { cliCatalog: [{ ...hostReader, command: 'fixture-cli' }], catalogRefreshIntervalMs: 0 };
  try {
    await fixture.open();
    fixture.runtime.options.commandEnv = { 'fixture-cli': { PATH: `${fixture.root}:${process.env.PATH ?? '/usr/bin:/bin'}` } };
    assert(fixture.action.type === 'runCli');
    fixture.action = { ...fixture.action, executable: 'fixture-cli' }; fixture.submit();
    const approval = await fixture.approval();
    // Persist the user's exact approval before changing the actual execution inputs.
    assert(fixture.service.engine.decideHostApproval(fixture.room.id, approval.taskId, approval.workId,
      approval.operationId, approval.approvalId, 'approve', 'inventory-exact-approval').ok);
    if (change === '选中程序内容变化') await writeFile(fixture.executable, (await readFile(fixture.executable, 'utf8')) + '\n// changed after exact approval\n');
    else if (change === '选中调用环境变化') fixture.runtime.options.commandEnv!['fixture-cli']!.INVOCATION_CHANGE = 'changed';
    else {
      assert.equal(change, '无关工具元信息变化');
      fixture.runtime.options.cliCatalog = [{ ...hostReader, command: 'fixture-cli' }, extraReader];
      await fixture.runtime.refreshToolInventory();
    }
    fixture.runtime.notifyWorkspace(`approval:${approval.operationId}`);
    await hostUntil(() => fixture.operation(), operation => !!operation?.result);
    const operation = fixture.operation()!;
    if (change === '无关工具元信息变化') {
      await fixture.assertSuccessfulRun(); assert.equal(await fixture.runs(), 'once\n');
      return { stage, change, executions: 1, code: operation.result!.code };
    }
    assert.equal(operation.result!.code, 'HOST_APPROVAL_STALE'); assert.equal(operation.startedAt, undefined);
    assert.equal(await fixture.runs(), '');
    return { stage, change, executions: 0, code: operation.result!.code };
  } finally { await fixture.close(); }
}
