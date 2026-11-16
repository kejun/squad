import assert from 'node:assert/strict';
import { codePointLength, readSavedArtifact, savedPageCodePoints } from '../src/evidence-reader.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { resolveModel } from '../src/model-config.js';
import { initialTask, persistTask, restoreTask, stepTask, type TaskSnapshot } from '../src/task.machine.js';
import type { Intent, TaskEvent, TaskInput } from '../src/types.js';
import { createTeamConfig } from '../team.config.js';
import { localModelInput } from './local-model-fixture.js';

const token = '正文专有';
type Body = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> : never : never;

function articleId(index: number): string {
  return `${String(index).padStart(9, '0')}${'a'.repeat(390)}`;
}

function articleBody(index: number): string {
  return `${token}-${String(index).padStart(4, '0')}-${'文'.repeat(40)}`;
}

function shortDraft(ids: readonly string[]): string {
  return `来源\n${ids.join('\n')}\n要点\n点`;
}

export class SummaryModel {
  snapshot: TaskSnapshot;
  sequence = 0;
  inlined = false;
  watch = false;
  constructor(change: (input: TaskInput) => void = () => {}) {
    const input = localModelInput();
    input.message.text = '开始';
    input.goal = { text: '开始', constraints: ['保留来源'], criteria: ['形成一条顶层摘要'], requiredArtifacts: 0 };
    input.config.inputAnalysis = { enabled: true };
    input.config.models = { default: 'test', services: { test: { baseUrl: 'https://example.test/v1', model: 'test' } } };
    input.config.bots.push(...['C', 'D', 'E'].map(id => ({ id, name: id, instructions: '', tools: [] })));
    input.config.limits.ordinary = 800;
    input.config.limits.assists = 800;
    input.config.limits.workTimeoutMs = 10_000_000;
    change(input);
    this.snapshot = initialTask(input);
  }
  get context() { return this.snapshot.context; }
  pending(kind: Intent['kind']) { return this.context.intents.filter(work => work.kind === kind && work.status === 'pending'); }
  send(body: Body) {
    this.snapshot = stepTask(this.snapshot, { id: `summary:${++this.sequence}`, at: this.sequence, ...body } as TaskEvent);
    this.snapshot = restoreTask(structuredClone(persistTask(this.snapshot)));
    if (!this.watch) return this.context.reply;
    for (const work of this.context.intents) {
      if (['pending', 'inflight'].includes(work.status) && ['interpretation', 'assistance', 'discussionSummary', 'owner'].includes(work.kind)
        && JSON.stringify(work.payload).includes(token)) this.inlined = true;
    }
    return this.context.reply;
  }
  saveArticles(count: number) {
    for (let index = 1; index <= count; index += 1) {
      assert(this.send({ type: 'ARTIFACT', artifact: { id: articleId(index), name: `article-${index}.md`, content: articleBody(index) } }).ok);
    }
  }
  requestSummary() {
    this.watch = true;
    assert(this.send({ type: 'USER_INPUT', text: '请汇总当前任务已保存的全部文章，必须保留每篇来源并归纳要点' }).ok);
    const work = this.pending('interpretation')[0];
    assert(work);
    assert(!JSON.stringify(work.payload).includes(token));
    assert(this.send({ type: 'CLAIM', intentId: work.id }).ok);
    const claimed = this.context.intents.find(item => item.id === work.id)!;
    assert(this.send({ type: 'CONSUME', intentId: claimed.id, fence: claimed, attempt: claimed.attempt }).ok);
    const inputId = (claimed.payload.input as { id: string }).id;
    assert(this.send({ type: 'INTERPRETATION_RESULT', workId: claimed.id, fence: claimed, attempt: claimed.attempt, inputId,
      spec: { action: 'supplement', objective: '汇总当前文章', constraints: ['保留来源'], expectedOutputs: ['一条顶层摘要'],
        acceptanceCriteria: ['覆盖每篇'], references: [], confidence: 1, clarification: null } }).ok);
  }
  settle(draft: (ids: readonly string[]) => string = shortDraft) {
    for (let guard = 0; guard < 5000 && !this.pending('owner').length && this.context.discussion?.status !== 'cancelled'; guard += 1) {
      const assistance = [...this.pending('assistance')];
      const summary = this.pending('discussionSummary')[0];
      if (!assistance.length && !summary) throw new Error(`汇总停住：${this.context.discussion?.incomplete ?? this.context.reason}`);
      for (const pending of assistance) {
        assert(this.send({ type: 'CLAIM', intentId: pending.id }).ok);
        const work = this.context.intents.find(item => item.id === pending.id)!;
        const ids = work.payload.sourceIds as string[];
        assert(ids?.length);
        assert(!JSON.stringify(work.payload).includes(token));
        const text = draft(ids);
        assert(this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, text, status: 'success' }).ok);
      }
      const reducing = this.pending('discussionSummary')[0];
      if (reducing) {
        assert(this.send({ type: 'CLAIM', intentId: reducing.id }).ok);
        const work = this.context.intents.find(item => item.id === reducing.id)!;
        assert(!JSON.stringify(work.payload).includes(token));
        const answers = (work.payload.discussion as { results?: { answer: string }[] } | undefined)?.results ?? [];
        assert(answers.every(result => result.answer === ''));
        assert(this.send({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, fence: work, text: '本层已结算', status: 'success' }).ok);
      }
    }
  }
}

export interface SummaryRun {
  count: number; layer: number; material: string; summary: string; sourceIds: string[]; inlined: boolean;
}

function ownerMaterial(model: SummaryModel): SummaryRun {
  const owner = model.pending('owner')[0];
  assert(owner, model.context.discussion?.incomplete ?? model.context.reason);
  const summary = owner.payload.summary as string;
  const sourceIndex = owner.payload.sourceIndex as { id: string; documentId?: string; revision?: number; goalVersion?: number; content?: string }[];
  assert.equal(codePointLength(summary) <= savedPageCodePoints, true);
  assert(sourceIndex.length > 0);
  assert(sourceIndex.every(item => item.content === undefined && item.documentId && item.revision && item.goalVersion));
  assert(!JSON.stringify(owner.payload).includes(token));
  assert(!JSON.stringify(owner.payload.artifacts ?? []).includes(token));
  const material = JSON.stringify({ summary, sourceIndex });
  return { count: 0, layer: model.context.discussion!.mapReduce!.summaryLayer!.layer, material, summary,
    sourceIds: sourceIndex.map(item => item.id), inlined: model.inlined };
}

export function summarizeArticles(count: number): SummaryRun {
  const model = new SummaryModel();
  model.saveArticles(count);
  const bodies = model.context.artifacts.map(artifact => artifact.content).join('');
  if (codePointLength(bodies) <= savedPageCodePoints) {
    for (const artifact of model.context.artifacts) artifact.content = `${token}-${'文'.repeat(2500)}`;
  }
  model.requestSummary();
  model.settle();
  assert.equal(model.inlined, false);
  const run = ownerMaterial(model);
  run.count = count;
  if (count >= 100) assert(run.sourceIds.length < count);
  const saved = model.context.artifacts.find(artifact => artifact.content === run.summary);
  assert(saved);
  assert.match(saved.id, new RegExp(`^${model.context.taskId}:artifact:`));
  return run;
}

export function compareArticleCounts(): { smaller: SummaryRun; larger: SummaryRun } {
  const smaller = summarizeArticles(100);
  const larger = summarizeArticles(1000);
  assert(larger.layer > smaller.layer);
  assert(larger.material.length < smaller.material.length * 10);
  assert(larger.material.length <= savedPageCodePoints * 2);
  assert(smaller.material.length <= savedPageCodePoints * 2);
  return { smaller, larger };
}

export function readIndexedArticle(): { body: string; pageText: string; shortBoundary: boolean; charged: number } {
  const model = new SummaryModel();
  model.saveArticles(2);
  for (const artifact of model.context.artifacts) artifact.content = `${token}-${artifact.id.slice(0, 9)}-${'文'.repeat(2500)}`;
  model.requestSummary();
  model.settle();
  const run = ownerMaterial(model);
  const articleIdToRead = run.sourceIds.find(id => model.context.artifacts.find(artifact => artifact.id === id)?.content.includes(token));
  assert(articleIdToRead);
  const owner = model.pending('owner')[0]!;
  assert(model.send({ type: 'CLAIM', intentId: owner.id }).ok);
  const work = model.context.intents.find(item => item.id === owner.id)!;
  const before = model.context.usage.ordinary;
  assert(model.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'read-article', namespace: 'c'.repeat(64),
    requestHash: 'd'.repeat(64), action: { type: 'readArtifact', artifactId: articleIdToRead }, parentAttempt: work.attempt, messages: [], fence: work }).ok);
  assert(model.send({ type: 'LOCAL_CLAIM', intentId: work.id, operationId: 'read-article', parentAttempt: work.attempt,
    sessionId: 'summary-read', leaseAvailable: false, fence: work }).ok);
  const charged = model.context.usage.ordinary - before;
  const page = readSavedArtifact(model.context, work, { type: 'readArtifact', artifactId: articleIdToRead });
  assert(page.ok);
  const saved = model.context.artifacts.find(artifact => artifact.id === articleIdToRead)!;
  assert.equal(page.data.text, saved.content);
  const short = model.context.artifacts.find(artifact => artifact.content === run.summary)!;
  const shortPage = readSavedArtifact(model.context, work, { type: 'readArtifact', artifactId: short.id });
  assert.equal(shortPage.data.nextCursor, null);
  assert.equal(shortPage.data.atSavedBoundary, true);
  assert(model.send({ type: 'LOCAL_RESULT', intentId: work.id, operationId: 'read-article', sessionId: 'summary-read',
    result: page, settled: true, effectsKnown: true }).ok);
  return { body: saved.content, pageText: String(page.data.text), shortBoundary: shortPage.data.atSavedBoundary === true, charged };
}

export function stopWhenTopExceedsPage(): { reason: string; owners: number; keptDraft: boolean } {
  const model = new SummaryModel();
  model.saveArticles(2);
  for (const artifact of model.context.artifacts) artifact.content = `${token}-${'文'.repeat(2500)}`;
  model.requestSummary();
  model.settle(ids => `来源\n${ids.join('\n')}\n要点\n${'超'.repeat(savedPageCodePoints)}`);
  assert.equal(model.pending('owner').length, 0);
  assert.equal(model.inlined, false);
  assert.match(model.context.reason, /超过一页/);
  assert.equal(model.context.artifacts.some(artifact => artifact.content.includes('超'.repeat(100))), false);
  return { reason: model.context.reason, owners: model.pending('owner').length, keptDraft: false };
}

export function refuseWhenAssistsRunOut(): { notice: string; owners: number } {
  const model = new SummaryModel(input => { input.config.limits.assists = 0; });
  model.saveArticles(2);
  for (const artifact of model.context.artifacts) artifact.content = `${token}-${'文'.repeat(2500)}`;
  model.requestSummary();
  assert.equal(model.pending('assistance').length, 0);
  assert.equal(model.pending('owner').length, 0);
  assert.equal(model.inlined, false);
  const notice = model.context.messages.map(message => message.text).join('\n');
  assert.match(notice, /协助额度不足/);
  return { notice, owners: 0 };
}

export async function fixedCheckKeepsSummary(summary: string): Promise<{ unchanged: boolean; fullText: string }> {
  const fullText = '固定证据'.repeat(1024);
  const unchanged = summary;
  const config = createTeamConfig({});
  config.models = { default: 'review', services: { review: { baseUrl: 'https://review.example/v1', model: 'review', contextWindowTokens: 4096, maxTokens: 256,
    extraBody: { truncate_prompt_tokens: 20, truncate: true, truncation: 'auto', plugins: [{ id: 'context-compression' }] } } } };
  const materials = { requirements: [{ id: 'G1:goal:text', text: 'Verify the release claim', goalVersion: 1, sources: [{ kind: 'goal' as const, id: 'input-1' }] }],
    candidate: { revision: 'revision-1', text: unchanged }, artifacts: [{ id: 'draft-1', name: 'report.md', content: fullText }],
    rawInputs: [{ id: 'input-1', text: 'Verify the release claim' }], evidence: [], previousResults: [],
    verification: { id: 'receipt-1', stdout: 'All tests passed.', workspaceRevision: 'workspace-revision' } };
  const work: Intent = { id: 'task:E1:check', kind: 'check', target: 'facilitator', status: 'inflight', replay: 'safe', attempt: 1,
    epoch: 1, goalVersion: 1, deadline: null, bucket: 'checks', requestCount: 1, model: resolveModel(config, 'check', 'facilitator')!,
    payload: { checkMaterials: materials, capabilities: { localTools: true } } };
  const unavailable = async (): Promise<never> => { throw new Error('Checker must not call a tool'); };
  let calls = 0;
  const transport = (async () => { calls += 1; return new Response('{}'); }) as typeof fetch;
  const adapter = new OpenAICompatibleAdapter(config, { transport, env: {} });
  await assert.rejects(adapter.execute(work, new AbortController().signal, { authorizeAdditionalRequest: unavailable, regenerateModelOutput: unavailable,
    findSkills: unavailable, webSearch: unavailable, webFetch: unavailable, localTools: { catalog: { catalogVersion: 'test', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: undefined, invoke: unavailable, resume: unavailable } }), /CHECK_CONTEXT_LIMIT/);
  assert.equal(calls, 0);
  assert.equal(materials.artifacts[0]!.content, fullText);
  assert.equal(unchanged, summary);
  return { unchanged: unchanged === summary, fullText };
}

export async function summaryRequestOmitsProviderTruncation(): Promise<void> {
  const config = createTeamConfig({});
  config.models = { default: 'test', services: { test: { baseUrl: 'https://example.test/v1', model: 'test',
    extraBody: { truncate_prompt_tokens: 20, truncate: true, truncation: 'auto', plugins: [{ id: 'context-compression', enabled: true }] } } } };
  const work: Intent = { id: 'local-model:E1:owner:1', kind: 'owner', target: 'A', status: 'inflight', replay: 'safe', attempt: 1,
    epoch: 1, goalVersion: 1, deadline: null, bucket: 'ordinary', requestCount: 1, model: resolveModel(config, 'owner', 'A')!,
    payload: { hierarchicalSummary: true, summaryHandoff: true, summary: '来源\narticle-1\n要点\n点', sourceIndex: [{ id: 'article-1', documentId: 'article-1', revision: 1, goalVersion: 1 }],
      goal: { text: '汇总', constraints: [], criteria: [], requiredArtifacts: 0 }, artifacts: [], capabilities: { localTools: false, findSkills: false, webSearch: false, webFetch: false } } };
  let body = '';
  const transport = (async (_url: unknown, init?: { body?: string }) => { body = String(init?.body ?? ''); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'deliver', text: '已看到顶层摘要', artifactIds: [] }) } }] }); }) as typeof fetch;
  const unavailable = async (): Promise<never> => { throw new Error('unused'); };
  const adapter = new OpenAICompatibleAdapter(config, { transport, env: {} });
  await adapter.execute(work, new AbortController().signal, { authorizeAdditionalRequest: unavailable, regenerateModelOutput: unavailable,
    findSkills: unavailable, webSearch: unavailable, webFetch: unavailable });
  const sent = JSON.parse(body) as { truncate_prompt_tokens?: unknown; truncate?: unknown; truncation?: unknown; plugins?: { id: string; enabled?: boolean }[]; messages: { content: string }[] };
  assert.equal(sent.truncate_prompt_tokens, undefined);
  assert.equal(sent.truncate, undefined);
  assert.equal(sent.truncation, undefined);
  assert.equal(sent.plugins?.find(plugin => plugin.id === 'context-compression')?.enabled, false);
  assert(!sent.messages.some(message => message.content.includes(token)));
}
