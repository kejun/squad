import { localEnabled, type Intent, type TaskContext } from '../types.js';
import type { ToolInventorySnapshot } from '../tool-inventory.js';
import { assignedReadingResource, readingDocumentId, recommendedReadRoute, resourceInReadingScope, taskMemory } from './execution-memory.js';
import { sameResourceIdentity } from '../resource-acquisition.js';
import { mapConfigurationKey } from './map-scheduling.js';
import { referenceToolObservation, settledToolObservation, sharedToolKnowledge } from './tool-knowledge.js';

export interface ToolExperience {
  id: string;
  condition: { description: string; configuration?: string; execution?: string; authentication?: 'satisfied'; resourceScope?: unknown };
  action: { description: string; steps?: string[]; template?: Record<string, unknown>; observation?: Record<string, unknown>; metadataReference?: Record<string, unknown> };
  expectedResult: { description: string; requiresVerification: true; provesCurrentResource: false };
  evidence: { kind: 'verified_recipe' | 'capability_observation' | 'verified_resource_method';
    verificationLevel: 'execution_contract' | 'capability_metadata' | 'resource_content';
    version?: string; sourceTaskId?: string; sourceOperationId?: string; observedAt?: number | null; verifier?: unknown;
    sources?: { sourceTaskId: string; sourceOperationId: string; observedAt: number | null }[] };
  observationOnly: true;
  executionAuthority: false;
  requiresIndependentExecution: true;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const observationBoundary = { observationOnly: true, executionAuthority: false, requiresIndependentExecution: true } as const;
const expected = (description: string): ToolExperience['expectedResult'] => ({ description,
  requiresVerification: true, provesCurrentResource: false });

/** Versioned, tested execution knowledge survives new tasks and process restarts without retaining private task material. */
export function toolRecipes(): ToolExperience[] {
  return [
    { id: 'workspace-intermediates:v1', condition: { description: '需要生成、转换或在后续工具调用中读取中间文件，尤其是沙盒与宿主之间交接文件时。' },
      action: { description: '把中间产物写在当前工作区的相对路径，并把该相对路径传给后续工具。',
        steps: ['使用工作区内的 .tmp/ 或明确的输出目录；先建立所需目录。',
          '通过结构化 argv 传参；不要把 shell 管道或重定向写进一个参数。',
          '跨调用复用同一工作区相对路径；不要依赖宿主全局 /tmp 或其他任务的文件。'] },
      expectedResult: expected('后续调用能在允许的工作区内读取中间产物；本次仍需检查输出文件和内容。'),
      evidence: { kind: 'verified_recipe', verificationLevel: 'execution_contract', version: 'workspace-files:v1',
        verifier: { id: 'squad-cli-stdin-acceptance', version: 'BT_Y145' } }, ...observationBoundary },
    { id: 'ocr-stdin:v1', condition: { description: '已选择的 OCR 工具文档明确支持 stdin，且待识别文件已位于当前工作区；所需格式和语言包可用。' },
      action: { description: '通过 runCli.stdin.path 传入工作区文件，按该工具的 stdin 约定提供参数；识别结果写到 stdout 或工作区文件。',
        steps: ['stdin.path 相对工作区根目录，不随 cwd 改变。',
          '例如 tesseract 的参数为 ["stdin","stdout"]；其他工具须采用其已确认的 stdin 语法。',
          '选择宿主执行时仍提交明确原因并等待正常宿主授权；配方不授予权限。'],
        template: { type: 'runCli', executable: '<selected-ocr-command>', args: ['<documented-stdin-arguments>'],
          stdin: { path: '<workspace-relative-input>' } } },
      expectedResult: expected('OCR 从标准输入读取文件字节并输出可核验的文本；一次成功不证明另一页已识别或识别准确。'),
      evidence: { kind: 'verified_recipe', verificationLevel: 'execution_contract', version: 'workspace-stdin:v1',
        verifier: { id: 'squad-cli-stdin-acceptance', version: 'BT_Y145' } }, ...observationBoundary },
  ];
}

function currentExperiences(c: TaskContext, work: Intent, inventory?: ToolInventorySnapshot): ToolExperience[] {
  return sharedToolKnowledge(c, work, inventory).map(method => {
    const verified = 'validation' in method;
    return { id: `operation:${method.sourceOperationId}`, condition: {
      description: verified ? '仅在原资源范围、配置、验证器和认证前提仍满足时复用调用结构；目标资源必须独立验证。'
        : '同任务中需要相同工具能力信息，且本次环境和目录元数据仍一致时。',
      configuration: mapConfigurationKey(c),
      ...(verified ? { resourceScope: structuredClone(method.resourceScope), authentication: 'satisfied' as const,
        execution: method.action.type === 'runCli' ? method.action.execution ?? 'sandbox' : 'web' } : {}) },
    action: { description: verified ? '复用已验证调用结构，独立读取尚缺或需刷新的资源；已有合法保存来源可保留原采集身份复用，不能称为新读取。' : '先复用已结算能力事实，再决定是否需要新的发现。',
      template: structuredClone(method.action), ...('observation' in method && method.observation ? { observation: method.observation } : {}),
      ...('metadataReference' in method && method.metadataReference ? { metadataReference: method.metadataReference } : {}) },
    expectedResult: expected(verified ? '为所需资源提供合法来源；新读取须独立验证正文、完整性和认证，旧回执不证明刷新或另一份资料已取得。' : '减少重复能力发现；缺失和过时元数据仍是未知。'),
    evidence: { kind: verified ? 'verified_resource_method' : 'capability_observation',
      verificationLevel: verified ? 'resource_content' : 'capability_metadata', sourceTaskId: c.taskId,
      sourceOperationId: method.sourceOperationId, observedAt: method.finishedAt, ...(verified ? { verifier: method.validation.verifier } : {}) },
    ...observationBoundary };
  });
}

function matchesInventory(metadata: Record<string, unknown>, inventory: ToolInventorySnapshot): boolean {
  const cli = record(metadata.cli), catalog = record(cli.catalog), skills = record(metadata.skills), sandbox = record(cli.sandbox);
  if (metadata.platform !== undefined && metadata.platform !== inventory.environment.platform
    || metadata.arch !== undefined && metadata.arch !== inventory.environment.arch
    || sandbox.available !== undefined && sandbox.available !== inventory.environment.sandbox.available) return false;
  return (typeof catalog.catalogVersion === 'string' || typeof skills.catalogVersion === 'string')
    && (catalog.catalogVersion === undefined || catalog.catalogVersion === inventory.cli.catalogVersion)
    && (skills.catalogVersion === undefined || skills.catalogVersion === inventory.skills.catalogVersion);
}

/** Historical inputs are supplied only from the requesting room's durable records. No global learning cache exists. */
function historicalCapabilities(c: TaskContext, history: TaskContext[], inventory: ToolInventorySnapshot): ToolExperience[] {
  const experiences: ToolExperience[] = history.filter(source => source.taskId !== c.taskId && mapConfigurationKey(source) === mapConfigurationKey(c))
    .flatMap(source => source.intents.filter(work => work.epoch === source.epoch && work.goalVersion === source.goalVersion)
      .flatMap(work => (work.localOperations ?? []).flatMap(operation => {
        if (!['discoverHost', 'listSkills'].includes(operation.action.type)) return [];
        const fact = settledToolObservation(operation);
        if (!fact?.metadataComplete || !fact.observation || !matchesInventory(fact.observation, inventory)) return [];
        // Arbitrary invocation arguments, document bodies and resource-acquisition claims never cross tasks.
        const projected = referenceToolObservation(fact.observation, inventory);
        return [{ id: `history:${source.taskId}:${operation.id}`, condition: {
          description: '同一会话的新任务，配置、平台、目录版本和沙盒能力仍与原回执一致；历史安装状态是带时间的观察，不是当前安装、认证或资源证明。',
          configuration: mapConfigurationKey(c) },
        action: { description: '复用仍匹配当前工具目录的能力元数据，避免重复发现；直接按当前任务选择工具。',
          observation: projected.observation, metadataReference: projected.metadataReference },
        expectedResult: expected('减少重复能力探测；本次执行仍须授权并取得独立结果。'),
        evidence: { kind: 'capability_observation' as const, verificationLevel: 'capability_metadata' as const,
          sourceTaskId: source.taskId, sourceOperationId: operation.id, observedAt: operation.finishedAt ?? null,
          sources: [{ sourceTaskId: source.taskId, sourceOperationId: operation.id, observedAt: operation.finishedAt ?? null }] }, ...observationBoundary }];
      })));
  const distinct = new Map<string, ToolExperience>();
  for (const experience of experiences) {
    const key = JSON.stringify([experience.condition, experience.action, experience.evidence.verificationLevel]);
    const previous = distinct.get(key);
    if (previous) previous.evidence.sources!.push(...experience.evidence.sources!);
    else distinct.set(key, experience);
  }
  return [...distinct.values()];
}

function readingObservations(c: TaskContext, work: Intent, inventory?: ToolInventorySnapshot): ToolExperience[] {
  const part = work.payload.partition as { id: string } | undefined;
  const resource = part && assignedReadingResource(c, part.id);
  const memory = taskMemory(c), reading = inventory?.reading;
  if (resource?.kind !== 'url' || !memory || !reading) return [];
  const web = memory.observations?.find(item => item.kind === 'web_login' && item.protectedPrefix
    && reading.protectedPrefixes.includes(item.protectedPrefix) && resourceInReadingScope(resource, item.protectedPrefix));
  const sandbox = memory.observations?.find(item => item.kind === 'sandbox_ps' && item.pattern
    && reading.patterns.some(pattern => pattern.binding === item.pattern!.binding) && resourceInReadingScope(resource, item.pattern.urlPrefix));
  return [web, sandbox].flatMap(item => item ? [{
    id: `read-observation:${item.id}`,
    condition: { description: item.kind === 'web_login' ? '当前来源属于同一受保护访问范围，匿名网页读取曾返回登录页。'
      : '当前读取器及沙箱约束与曾触发 /bin/ps 权限错误的调用相符。' },
    action: { description: item.kind === 'web_login' ? '优先考虑当前可用的已授权读取路径，避免重复尝试该匿名入口。'
      : `避免重复用沙箱执行 ${item.pattern!.executable} 的已知失败读取调用。按当前能力和权限选择备选方式。` },
    expectedResult: expected('减少已知失败的探测，仍需核对本轮来源和正文。'),
    evidence: { kind: 'capability_observation', verificationLevel: 'capability_metadata', sourceTaskId: item.sourceTaskId,
      sourceOperationId: item.operationId, observedAt: item.at },
    ...observationBoundary,
  }] satisfies ToolExperience[] : []);
}

export function sharedToolExperiences(c: TaskContext, work: Intent, history: TaskContext[] = [], inventory?: ToolInventorySnapshot): ToolExperience[] {
  if (c.stopped || c.outcome !== null || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion
    || !['owner', 'assistance', 'facilitator'].includes(work.kind) || !localEnabled(c.config, work.target)
    || (work.payload.capabilities as { localTools?: boolean } | undefined)?.localTools !== true) return [];
  const historical = inventory ? historicalCapabilities(c, history, inventory) : [];
  const route = recommendedReadRoute(c, work, inventory);
  const part = work.payload.partition as { id: string } | undefined;
  const target = part && assignedReadingResource(c, part.id), pattern = route?.pattern;
  const slug = pattern && target && readingDocumentId(target, pattern.urlPrefix);
  const args = slug && target?.kind === 'url' && pattern?.argsPrefix
    ? [...pattern.argsPrefix, pattern.documentArgument ? slug : target.url, ...(pattern.separateDocumentId ? [slug] : [])] : undefined;
  const prior = !route && target ? taskMemory(c)?.routes.find(item => item.resource && sameResourceIdentity(item.resource, target)) : undefined;
  const diagnostic: ToolExperience[] = prior ? [{
    id: `read-history:${prior.id}:v${prior.version}`,
    condition: { description: '曾经取得此来源的完整正文，本轮尚未确认可试用历史路线。' },
    action: { description: '继续按普通路径独立获取本轮来源。' },
    expectedResult: expected('以本轮回执确认来源和正文。'),
    evidence: { kind: 'capability_observation', verificationLevel: 'capability_metadata',
      sourceTaskId: prior.sourceTaskId, sourceOperationId: prior.successOperationId, observedAt: prior.observedAt },
    ...observationBoundary,
  }] : [];
  const learned: ToolExperience[] = route ? [{
    id: `learned:${route.id}:v${route.version}`.replaceAll('\$', '$'),
    condition: { description: '当前分片的来源与以前验证过的读取路线相符。', configuration: route.configuration,
      execution: route.execution, resourceScope: { kind: 'url_origin', origin: route.origin } },
    action: { description: '优先使用该文档读取工具，以当前目录说明构造本次调用；按原流程取得许可并校验完整原文。',
      template: { type: 'runCli', executable: route.executable, execution: route.execution, ...(args ? { args } : {}) } },
    expectedResult: expected('跳过已知登录阻塞的路径；根据本次正文回执决定能否沿用。'),
    evidence: { kind: 'verified_resource_method', verificationLevel: 'resource_content', sourceTaskId: route.sourceTaskId,
      sourceOperationId: route.successOperationId, verifier: route.verifier },
    ...observationBoundary,
  }] : [];
  return [...learned, ...readingObservations(c, work, inventory), ...diagnostic, ...toolRecipes(), ...currentExperiences(c, work, inventory), ...historical];
}
