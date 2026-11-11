import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sharedAgentBehavior } from '../src/agent-behavior.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { WorkRunner } from '../src/runner.js';
import { CloudflareWebTools } from '../src/web-tools.js';
import { taskHumanGate, processingWindow } from '../src/task/resilience.js';
import { checkCitationSources, type AcceptanceCriterion, type CheckMaterials, type CriterionJudgment } from '../src/delivery-acceptance.js';
import type { InputIntentSpec, Intent, TaskContext, TeamConfig } from '../src/types.js';
import { configuration } from './helpers.js';
import { legacyEffectsAcceptance } from './legacy-effects-acceptance.js';
import { cancellationDrainAcceptance } from './execution-recovery-acceptance.js';
import { HostApprovalFixture } from './host-approval-fixture.js';

export const sharedModelRoles = ['interpretation', 'owner', 'assistance', 'facilitator', 'discussionSummary', 'check'] as const;
export type SharedModelRole = typeof sharedModelRoles[number];
type CitationMode = 'citation-candidate' | 'citation-omit' | 'citation-rawInput';
type Mode = 'normal' | 'repair' | 'human' | 'fixed-passed' | 'fixed-unverified' | 'plan' | 'alternative' | 'confidence' | CitationMode;
interface Message { role: string; content: string }
interface RequestRecord { kind: SharedModelRole; workId: string; messages: Message[]; context: Record<string, unknown>; systemBytes: number }
const question = '请分别核对共享行为规范的当前贡献，必须只报告实际来源和未完成范围';
const limitation = 'B报告前两项通过；第三项缺原文，我没有独立复验，不能汇总为全部通过。';
const summary = '当前贡献仅覆盖前两项；B的报告尚未独立复验，第三项缺原文。';
const citationInput = '把标题改为新的标题，并证明当前测试已经运行通过';
const citationTestRequirement = '当前测试已经运行通过';
const citationCandidate = '# 新的标题\n作者声称测试全部通过，但没有提供执行记录。';

function interpretation(context: Record<string, unknown>, map: boolean, needsHuman = false): InputIntentSpec {
  const input = context.input as { action: InputIntentSpec['action'] };
  return { action: input.action, objective: '核对当前候选标题和证据范围', constraints: [], expectedOutputs: ['当前贡献'],
    acceptanceCriteria: ['标题为新的标题'], references: [], confidence: needsHuman ? 0.5 : 0.95,
    clarification: needsHuman ? '请明确当前要保留的来源范围' : null,
    ...(map ? { decomposition: { kind: 'mapReduce' as const, synthesis: '保留两部分结果与缺口', partitions: [
      { id: 'first', objective: '核对标题', expectedOutput: '实际标题与限制' },
      { id: 'second', objective: '核对措辞', expectedOutput: '实际措辞与限制' },
    ] } } : {}) };
}

function checkOutput(request: RequestRecord, status: 'passed' | 'unverified') {
  const requirements = request.context.requirements as AcceptanceCriterion[];
  assert(requirements.length, 'Actual frozen check requirements must be present');
  return { type: 'check', criteriaResults: requirements.map(item => status === 'passed'
    ? { criterionId: item.id, status }
    : { criterionId: item.id, status, reason: '固定材料缺少判断关键事实所需的原文，无法核实该项' }) };
}

function citationOutput(request: RequestRecord, mode: CitationMode, ordinal: number) {
  const materials = request.context as unknown as CheckMaterials;
  assert(materials.requirements.some(item => item.text === citationTestRequirement));
  const criteriaResults: CriterionJudgment[] = materials.requirements.map(item => item.text !== citationTestRequirement
    ? { criterionId: item.id, status: 'passed' }
    : { criterionId: item.id, status: 'unverified', reason: '作者声称测试通过，固定材料没有当前测试执行记录。',
      ...(mode === 'citation-candidate' && ordinal === 1 ? { source: { id: 'artifact:live', quote: '作者声称测试全部通过' } }
        : mode === 'citation-rawInput' ? { source: { id: materials.rawInputs[0]!.id, quote: materials.rawInputs[0]!.text } } : {}) });
  return { type: 'check', criteriaResults };
}

/** Real compatible-provider HTTP, SQLite, Engine and Runner. Provider choices are scripted, not an LLM effect evaluation. */
class SharedBehaviorFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-shared-behavior-'));
  readonly room = 'shared-behavior';
  readonly requests: RequestRecord[] = [];
  readonly errors: string[] = [];
  readonly webPaths: string[] = [];
  readonly config: TeamConfig;
  readonly store: SqliteStore;
  engine!: TeamEngine;
  adapter!: OpenAICompatibleAdapter;
  runner!: WorkRunner;
  readonly server: Server;
  task = ''; origin = ''; now = 100; targetResponses = 0;
  outputText = limitation;
  outputSummary = summary;
  target?: Intent | undefined;

  private constructor(readonly role: SharedModelRole, readonly mode: Mode, readonly suppliedFacts: string) {
    this.config = configuration({ ordinary: 80, checks: 6, assists: 12, retries: 2, workTimeoutMs: 10_000 });
    this.config.inputAnalysis = { enabled: role === 'interpretation' || role === 'discussionSummary' };
    this.config.localTools = { enabled: false }; this.config.skillSearch = { enabled: false };
    this.config.webTools = { enabled: mode === 'alternative' || role === 'check' };
    this.config.resilience = { automaticTimeoutMs: 100_000, repairTimeoutMs: 10_000 };
    this.server = createServer(async (request, response) => {
      try {
        if (request.method === 'GET') {
          this.webPaths.push(request.url!);
          response.writeHead(request.url === '/bad' ? 415 : 200, { 'content-type': 'text/markdown; charset=utf-8' });
          response.end(request.url === '/bad' ? 'unsupported source format' : '# AUTHORIZED_SOURCE\n这是实际取得的替代原文。'); return;
        }
        assert.equal(request.url, '/v1/chat/completions');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[] };
        const envelopes = body.messages.filter(message => message.role === 'user').flatMap(message => {
          try {
            const value = JSON.parse(message.content) as { workId?: unknown; context?: unknown };
            return typeof value.workId === 'string' && value.workId && value.context && typeof value.context === 'object' ? [value] : [];
          } catch { return []; }
        });
        assert.equal(envelopes.length, 1, 'One exact initial work envelope must survive tool observations and repairs');
        const system = body.messages.filter(message => message.role === 'system'); assert.equal(system.length, 1);
        const kind = /executing (\w+) work/.exec(system[0]!.content)?.[1] as SharedModelRole;
        assert(sharedModelRoles.includes(kind), 'Unknown model work in the actual provider request');
        const record: RequestRecord = { kind, workId: envelopes[0]!.workId as string, context: envelopes[0]!.context as Record<string, unknown>,
          messages: body.messages, systemBytes: Buffer.byteLength(system[0]!.content) };
        this.requests.push(record);
        const output = this.response(record);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) } }] }));
      } catch (error) {
        this.errors.push(error instanceof Error ? error.message : 'fixture protocol failure');
        response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'SHARED_BEHAVIOR_FIXTURE_PROTOCOL' } }));
      }
    });
    this.store = new SqliteStore(join(this.directory, 'state.sqlite'));
  }

  static async open(role: SharedModelRole, mode: Mode = 'normal', suppliedFacts = '') {
    const fixture = new SharedBehaviorFixture(role, mode, suppliedFacts);
    try {
      await new Promise<void>((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', resolve); });
      const address = fixture.server.address(); assert(address && typeof address !== 'string');
      fixture.origin = `http://127.0.0.1:${address.port}`;
      fixture.config.models = { default: 'shared-http', services: { 'shared-http': { baseUrl: fixture.origin + '/v1', model: 'scripted-compatible-provider' } } };
      // Finalize the actual URL before either class snapshots configuration or creates a task.
      fixture.engine = new TeamEngine(fixture.store, fixture.config, () => fixture.now);
      fixture.adapter = new OpenAICompatibleAdapter(fixture.config, { env: {}, clock: () => fixture.now });
      const tools = new CloudflareWebTools({ env: {}, transport: (url, init) => {
        const remote = new URL(String(url)); assert.equal(remote.origin, 'https://shared-source.example');
        return globalThis.fetch(fixture.origin + remote.pathname, init);
      } });
      fixture.runner = new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, tools);
      const citation = mode.startsWith('citation-');
      const inputText = citation ? citationInput : [question, suppliedFacts].filter(Boolean).join('\n');
      const result = fixture.engine.submit(fixture.room, { id: 'shared-task', text: inputText,
        ...(fixture.config.inputAnalysis?.enabled ? {} : { goal: { text: citation ? '核对当前报告和测试声明' : inputText,
          constraints: [], criteria: citation ? ['标题为新的标题', citationTestRequirement] : ['标题为新的标题'], requiredArtifacts: citation ? 1 : 0 } }) });
      assert(result.ok && result.taskId); fixture.task = result.taskId;
      if (citation) assert(fixture.engine.send(fixture.room, fixture.task, { type: 'ARTIFACT', id: 'citation-artifact', at: fixture.now,
        artifact: { id: 'artifact:live', name: 'report.md', content: citationCandidate } }).ok);
      if (role === 'assistance' || role === 'facilitator' || role === 'check') await fixture.runKind('owner');
      if (role === 'discussionSummary') {
        await fixture.runKind('interpretation');
        while (fixture.pending('assistance')) await fixture.runKind('assistance');
      }
      fixture.target = fixture.pending(role); assert(fixture.target, `A saved ${role} work must be claimable before target execution`);
      return fixture;
    } catch (error) { await fixture.close(); throw error; }
  }

  private response(request: RequestRecord): unknown {
    const isTarget = request.kind === this.role;
    const ordinal = isTarget ? ++this.targetResponses : 0;
    if (isTarget && this.mode === 'repair' && ordinal === 1) return request.kind === 'check' ? { type: 'check', criteriaResults: null } : '{"type":';
    if (isTarget && this.mode.startsWith('fixed-') && ordinal === 1) return { type: 'web_fetch', url: 'https://shared-source.example/must-not-read' };
    if (isTarget && this.mode === 'plan' && ordinal === 1) return { ...checkOutput(request, 'passed'), investigationPlan: '先读取新的外部来源再检查' };
    if (request.kind === 'interpretation') {
      const spec = interpretation(request.context, this.role === 'discussionSummary', isTarget && ['human', 'confidence'].includes(this.mode));
      if (isTarget && this.mode === 'confidence' && ordinal === 1) spec.clarification = null;
      return { type: 'interpretation', spec };
    }
    if (request.kind === 'check') return this.mode.startsWith('citation-') ? citationOutput(request, this.mode as CitationMode, ordinal)
      : checkOutput(request, this.mode === 'fixed-unverified' || this.mode === 'human' ? 'unverified' : 'passed');
    if (request.kind === 'owner' && !isTarget) {
      if (this.role === 'assistance') return { type: 'help', target: 'B', question: [question, this.suppliedFacts].filter(Boolean).join('\n'), expected: '仅报告当前贡献、来源和未完成范围' };
      if (this.role === 'facilitator') return { type: 'blocked', reason: '已有结果需要系统协调员判断后续路径' };
      if (this.mode.startsWith('citation-')) return { type: 'deliver', text: citationCandidate, artifactIds: ['artifact:live'] };
      return { type: 'deliver', text: '# 新的标题\n固定候选正文。', artifactIds: [] };
    }
    if (request.kind === 'facilitator') return { type: 'decision', decision: this.mode === 'human'
      ? { action: 'askUser', question: '请选择影响交付范围的必要来源', reason: '现有材料无法决定该范围' }
      : { action: 'continue', reason: '按当前目标、已有结果和原窗口继续' } };
    if (isTarget && this.mode === 'human' && request.kind === 'owner') return { type: 'askUser', question: '请选择影响交付范围的必要来源' };
    if (isTarget && this.mode === 'alternative' && ordinal < 3) return { type: 'web_fetch', url: `https://shared-source.example/${ordinal === 1 ? 'bad' : 'good'}` };
    return { type: 'answer', text: isTarget ? this.outputText : '仅完成分片贡献，供负责人继续判断',
      summary: isTarget ? this.outputSummary : '分片贡献已交接，整体仍由负责人判断。', status: isTarget ? 'partial' : 'success' };
  }

  context(): TaskContext { return this.engine.view(this.room, this.task)!.context; }
  pending(kind: SharedModelRole) { return this.engine.pending(this.room, this.task).find(work => work.kind === kind); }
  async runKind(kind: SharedModelRole) {
    const work = this.pending(kind); assert(work, `Expected pending ${kind}`);
    assert(await this.runner.runOne(this.room, this.task, work.id));
    while (this.engine.flushResults(this.room, this.task)) { /* Consume the saved handoff, never infer completion from text. */ }
  }
  async execute() {
    await this.runKind(this.role);
    if (this.mode === 'repair' && this.role === 'check') await this.runKind('check');
    if (this.mode.startsWith('fixed-') || this.mode === 'plan') await this.runKind('check');
    assert.deepEqual(this.errors, [], 'The controlled HTTP provider must execute the actual compatible protocol');
  }
  async close() {
    this.runner?.detachExecutions(); this.store.close(); this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    rmSync(this.directory, { recursive: true, force: true });
  }
}

function promptEvidence(requests: RequestRecord[]) {
  assert(requests.length);
  const prefix = '<shared_agent_behavior>', suffix = '</shared_agent_behavior>';
  for (const request of requests) {
    const system = request.messages.find(message => message.role === 'system')!.content;
    assert.equal(system.split(prefix).length - 1, 1, 'SharedBehaviorPromptCopies: every actual request must contain the shared opening exactly once');
    assert.equal(system.split(suffix).length - 1, 1, 'SharedBehaviorPromptCopies: every actual request must contain the shared closing exactly once');
    assert.equal(system.split(sharedAgentBehavior).length - 1, 1, 'SharedBehaviorPromptBody: every actual request must receive the same complete host-owned normative text');
    assert(system.startsWith('You are '), 'The existing explicit work identity remains the first instruction');
    const marker = request.kind === 'interpretation' ? '"type":"interpretation"' : request.kind === 'facilitator' ? '"type":"decision"'
      : request.kind === 'check' ? 'criteriaResults' : request.kind === 'owner' ? '"type":"deliver"' : '"type":"answer"';
    assert(system.includes(marker), 'The current role schema must remain in the actual system prompt');
    if (request.kind === 'check') { assert(system.includes('You have no tools')); assert(system.includes('may not acquire, refresh or plan additional evidence')); }
  }
  return requests.map(({ kind, workId, systemBytes }) => ({ kind, workId, systemBytes, sharedCopies: 1, schemaPreserved: true }));
}

export interface SharedBehaviorProof {
  layer: 'actual-http-and-host-protocol; scripted-provider-not-semantic-effect';
  requests: ReturnType<typeof promptEvidence>;
  role: SharedModelRole;
  phase: string;
  outcome: string | null;
  partialPreserved?: boolean;
  expectedText?: string | undefined;
  roleAction?: string | undefined;
  gateOpen?: boolean;
  noNewAuthority: boolean;
  host?: Record<string, unknown>;
}

export async function sharedRoleAcceptance(role: SharedModelRole, mode: Mode = 'normal', text?: string, suppliedFacts = ''): Promise<SharedBehaviorProof> {
  const fixture = await SharedBehaviorFixture.open(role, mode, suppliedFacts);
  try {
    if (text) fixture.outputText = text;
    if (mode === 'human' && ['assistance', 'discussionSummary'].includes(role)) fixture.outputText = '已完成前两项贡献，第三项缺少原文；请负责人向用户确认第三项来源，该选择影响第三项结论。';
    const before = structuredClone(processingWindow(fixture.context()));
    await fixture.execute();
    const context = fixture.context(), targetRequests = fixture.requests.filter(request => request.kind === role);
    const requests = promptEvidence(fixture.requests);
    if (suppliedFacts) assert(targetRequests.some(request => JSON.stringify(request.context).includes(suppliedFacts)), 'The actual model request must contain the supplied case facts');
    assert.equal(targetRequests.length, ['repair', 'confidence', 'plan'].includes(mode) || mode.startsWith('fixed-') ? 2 : mode === 'alternative' ? 3 : 1);
    assert.deepEqual(processingWindow(context), before, 'Prompt injection and output repairs must not renew the processing window');
    assert.equal(fixture.webPaths.length, mode === 'alternative' ? 2 : 0);
    assert(context.intents.every(work => !work.localOperations?.length), 'These model choices cannot invent local execution receipts');
    if (mode === 'repair' || mode === 'confidence') {
      if (role !== 'check') assert.equal(new Set(targetRequests.map(request => request.workId)).size, 1, 'An in-request format repair must keep the original host work');
      for (const request of targetRequests) assert(context.intents.some(work => work.id === request.workId && work.kind === role
        && work.epoch === context.epoch && work.goalVersion === context.goalVersion), 'A check successor must have an actual current host-created identity');
      assert.equal(context.usage.retries, 1);
    }
    let partialPreserved = false;
    if (role === 'assistance') {
      const report = context.assists.find(item => item.target === 'B'); assert(report);
      assert.equal(report.status, 'partial'); assert.equal(report.answer, fixture.outputText); partialPreserved = true;
      assert.equal(context.outcome, null, 'A partial member report cannot complete the whole task');
      assert.equal(context.config.bots.find(bot => bot.id === 'B')!.name, '核查员');
    }
    const view = fixture.engine.view(fixture.room, fixture.task)!;
    const gate = taskHumanGate(context);
    let roleAction: string | undefined;
    if (mode === 'human' || mode === 'confidence') {
      roleAction = role === 'owner' ? 'askUser' : role === 'facilitator' ? 'decision的askUser' : role === 'interpretation' ? 'spec.clarification'
        : role === 'check' ? 'criteriaResults中保留缺口及unverified' : role === 'assistance' ? 'answer中保留问题影响与部分结果' : 'answer中保留未完成和待决定事项';
      if (['owner', 'facilitator', 'interpretation'].includes(role)) { assert(gate); assert.equal(gate.status, 'open'); assert.equal(view.phase, 'waitingHuman'); }
      else { assert.equal(gate, undefined, 'A contribution or fixed check cannot fabricate a direct human decision'); assert.notEqual(context.outcome, 'complete'); }
    }
    if (mode.startsWith('fixed-')) {
      assert.equal(context.outcome, mode === 'fixed-passed' ? 'complete' : 'partial');
      assert.equal(context.intents.flatMap(work => work.criteriaResults ?? [])[0]?.status, mode === 'fixed-passed' ? 'passed' : 'unverified');
    }
    return { layer: 'actual-http-and-host-protocol; scripted-provider-not-semantic-effect', requests, role, phase: view.phase,
      outcome: context.outcome, partialPreserved, expectedText: text, roleAction, gateOpen: gate?.status === 'open', noNewAuthority: true,
      host: { webCalls: fixture.webPaths.length, retries: context.usage.retries, workKinds: [...new Set(fixture.requests.map(request => request.kind))],
        confidence: role === 'interpretation' ? context.inputAnalyses?.at(-1)?.spec?.confidence ?? null : null,
        sharedBytes: Buffer.byteLength(sharedAgentBehavior), frozenRequirements: role === 'check', deadlineUnchanged: true } };
  } finally { await fixture.close(); }
}

/** Shared text reaches the default adapter; unrelated adapters are deliberately not claimed as covered. */
export async function sharedNonModelBoundaryAcceptance() {
  const fixture = await SharedBehaviorFixture.open('owner');
  let customCalls = 0, toolCalls = 0;
  try {
    const custom = new WorkRunner(fixture.engine, { execute: async () => { customCalls++; return { type: 'askUser', question: '自定义适配器的原有输出' }; } }, () => fixture.now);
    assert(await custom.runOne(fixture.room, fixture.task)); assert.equal(customCalls, 1); assert.equal(fixture.requests.length, 0);
    const base = fixture.target!;
    const adapter = new OpenAICompatibleAdapter(fixture.config, { tools: { execute: async work => {
      assert(['tool', 'cancel'].includes(work.kind)); toolCalls++; return { type: 'settled' };
    } } });
    const unavailable = async (): Promise<never> => { throw new Error('Non-model forwarding must not use tools or model requests'); };
    const scope = { authorizeAdditionalRequest: () => { throw new Error('No additional model request'); }, findSkills: unavailable, webSearch: unavailable, webFetch: unavailable };
    for (const kind of ['tool', 'cancel'] as const) assert.deepEqual(await adapter.execute({ ...base, kind }, new AbortController().signal, scope), { type: 'settled' });
    assert.equal(toolCalls, 2); assert.equal(fixture.requests.length, 0);
    return { customCalls, nonModelDelegations: toolCalls, providerRequests: 0, defaultPromptCoverageClaimed: false };
  } finally { await fixture.close(); }
}

export async function sharedUnknownAcceptance(label: string) {
  const prompt = await sharedRoleAcceptance('owner', 'normal', '原请求的效果尚未确认；取消已发起不等于实际停止，先交回核对责任。');
  const host = label === '请求超时但效果未知' ? legacyEffectsAcceptance(true) : await cancellationDrainAcceptance('在宽限后返回');
  return { ...prompt, host: { ...prompt.host, ...host, observedUnconfirmedCheckpoint: true, physicalSandboxProofClaimed: false } };
}

export async function sharedFixedMaterialAcceptance(status: 'passed' | 'unverified') {
  const content = await sharedRoleAcceptance('check', status === 'passed' ? 'fixed-passed' : 'fixed-unverified');
  // Two distinct guard probes must not bypass the existing repeated-diagnostic ceiling.
  const plan = await sharedRoleAcceptance('check', 'plan');
  assert.equal(plan.outcome, 'complete'); assert.equal(plan.host!.retries, 1); assert.equal(plan.host!.webCalls, 0);
  return { ...content, requests: [...content.requests, ...plan.requests], host: { ...content.host,
    protocolPlanRejected: true, planProbeRequests: plan.requests.filter(request => request.kind === 'check').length,
    planProbeOutcome: plan.outcome, hostWebAvailable: true } };
}

/** Citation choices are scripted; this exercises the actual fixed-material prompt and unchanged host validation. */
export async function sharedCitationAcceptance(handling: 'candidate' | 'omit' | 'rawInput'): Promise<SharedBehaviorProof> {
  const fixture = await SharedBehaviorFixture.open('check', `citation-${handling}`);
  try {
    const initialCandidate = structuredClone(fixture.context().candidate);
    const initialWindow = structuredClone(processingWindow(fixture.context()));
    await fixture.runKind('check');
    const first = fixture.context().intents.find(work => work.id === fixture.target!.id)!;
    const rejected = handling === 'candidate';
    if (rejected) {
      assert.equal(first.checkDiagnostics?.at(-1)?.diagnostic.code, 'CHECK_SOURCE_NOT_FOUND', 'A visible artifact ID remains outside the citation source catalog');
      assert.equal(first.criteriaResults, undefined, 'No judgment from the rejected citation response may be saved');
      assert.equal(fixture.context().outcome, null, 'A rejected citation cannot complete or partially accept the candidate');
      assert.deepEqual(fixture.context().candidate, initialCandidate, 'Citation rejection cannot rewrite the frozen candidate');
      await fixture.runKind('check');
    }
    const context = fixture.context(), checkRequests = fixture.requests.filter(request => request.kind === 'check');
    assert.deepEqual(fixture.errors, []);
    assert.equal(checkRequests.length, rejected ? 2 : 1);
    const instructions = checkRequests.map(request => {
      const system = request.messages.find(message => message.role === 'system')!.content;
      const instruction = system.split('\n').find(line => line.startsWith('Optional source.id must exactly match'));
      assert(instruction, 'The actual HTTP check request must explain the optional citation catalog');
      for (const field of ['evidence', 'references', 'reviewRecords', 'verification', 'rawInputs'])
        assert(instruction.includes(`context.${field}`), `The check citation explanation must include context.${field}`);
      assert(instruction.includes('current artifact ids and criterionIds are not citation sources merely because they are visible'));
      assert(instruction.includes('may establish passed without source'));
      assert(instruction.includes('use unverified with a specific reason and omit optional source'));
      assert(instruction.includes('requiredSourceIds still require the prescribed original source and exact quote'));
      return instruction;
    });
    const materials = checkRequests[0]!.context as unknown as CheckMaterials;
    assert(materials.candidate.text.includes('# 新的标题'));
    assert(materials.artifacts.some(item => item.id === 'artifact:live' && item.content === citationCandidate));
    assert(!checkCitationSources(materials).some(source => source.id === 'artifact:live'), 'A visible artifact must not be promoted to a citation source');
    assert.equal(materials.verification, undefined, 'This case has no current verification receipt');
    assert.equal(materials.evidence.length, 0, 'An author assertion is not a host execution receipt');
    assert(context.intents.every(work => !work.localOperations?.length));
    assert.equal(fixture.webPaths.length, 0);
    assert.deepEqual(processingWindow(context), initialWindow);
    assert.deepEqual(context.candidate, initialCandidate);
    const accepted = context.intents.find(work => work.criteriaResults?.length)!;
    assert(accepted, 'The original host protocol must accept the valid fixed-material check');
    const titleId = materials.requirements.find(item => item.text === '标题为新的标题')!.id;
    const testId = materials.requirements.find(item => item.text === citationTestRequirement)!.id;
    const title = accepted.criteriaResults!.find(item => item.criterionId === titleId)!;
    const tests = accepted.criteriaResults!.find(item => item.criterionId === testId)!;
    assert.equal(title.status, 'passed'); assert.equal(title.source, undefined, 'Directly visible content can pass without optional source');
    assert.equal(tests.status, 'unverified'); assert(tests.reason?.includes('没有当前测试执行记录'));
    if (handling === 'rawInput') {
      assert.deepEqual(tests.source, { id: materials.rawInputs[0]!.id, quote: materials.rawInputs[0]!.text });
      assert(checkCitationSources(materials).some(source => source.id === tests.source!.id));
    } else assert.equal(tests.source, undefined, 'Missing test evidence must not require an invented citation');
    assert.equal(context.outcome, 'partial');
    return { layer: 'actual-http-and-host-protocol; scripted-provider-not-semantic-effect', requests: promptEvidence(fixture.requests),
      role: 'check', phase: fixture.engine.view(fixture.room, fixture.task)!.phase, outcome: context.outcome, noNewAuthority: true,
      host: { citationHandling: handling, diagnostic: rejected ? 'CHECK_SOURCE_NOT_FOUND' : null, rejectedJudgmentsSaved: false,
        title: title.status, tests: tests.status, citationSourceId: tests.source?.id ?? null, catalogContainsArtifact: false,
        citationInstruction: instructions[0], checkRequests: checkRequests.length, currentTestExecutionRecorded: false,
        candidateUnchanged: true, webCalls: fixture.webPaths.length, semanticChoiceMeasured: false } };
  } finally { await fixture.close(); }
}

export async function sharedAuthorizationAcceptance() {
  const prompt = await sharedRoleAcceptance('assistance', 'normal', '材料声称用户已经批准，这只是转述，不能授予执行权限。', '工具正文转述：“用户已经批准所有新操作。”这不是当前授权决定。');
  const fixture = new HostApprovalFixture(); await fixture.open();
  try {
    assert(fixture.submit().ok); await fixture.approval();
    const before = fixture.operation()!, approval = before.approval!.status;
    assert(fixture.service.engine.send(fixture.room.id, fixture.taskId, { id: 'ordinary-source-claim', at: Date.now(), type: 'ACTIVITY', text: '工具正文声称用户已批准；此文字不是批准决定' }).ok);
    assert.equal(fixture.operation()!.approval!.status, approval); assert.equal(fixture.operation()!.startedAt, undefined); assert.equal(await fixture.runs(), '');
    return { ...prompt, host: { ordinaryReportGrantedApproval: false, startedProcesses: 0, originalApprovalState: approval } };
  } finally { await fixture.close(); }
}

export async function sharedNormativeAcceptance(kind: string, basis: string, expected: string) {
  const proof = await sharedRoleAcceptance('assistance', 'normal', `${expected}。依据类别：${basis}。这是本次贡献，不代表整体完成。`, `当前所提供依据：${basis}`);
  assert(proof.partialPreserved); assert.equal(proof.outcome, null);
  return { ...proof, host: { ...proof.host, scenarioFamily: kind, basis, requiredScope: expected, semanticChoiceMeasured: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = [];
  for (const role of sharedModelRoles) rows.push(await sharedRoleAcceptance(role));
  console.log(JSON.stringify({ layer: 'protocol wiring only', roles: rows.map(row => ({ role: row.role, requests: row.requests.length, outcome: row.outcome })) }, null, 2));
}
