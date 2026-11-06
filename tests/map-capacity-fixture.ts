import assert from 'node:assert/strict';
import { CloudflareWebTools, WorkRunner, type InputIntentSpec, type Intent, type TaskContext } from '../src/index.js';
import { InputIntentFixture, intentConfig, parsedIntent, type IntentRequest } from './input-intent-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { fixtureJudgments } from './delivery-protocol-fixture.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';

export const documentUrls = Array.from({ length: 8 }, (_, index) => `https://docs.fixture.example/doc-${index + 1}.md`);
const documentBodies = documentUrls.map((_, index) => `# 文档 ${index + 1}\n\n独有事实 DOC_${index + 1}_FACT：该文档的证据必须进入最终归并。`);
export const documentRequest = `分别阅读并研究以下八份独立文档；必须覆盖每份文档且保留原始出处；最后汇总为 Markdown 文档。\n${documentUrls.join('\n')}`;

export function groupedIntent(count: number): InputIntentSpec {
  return parsedIntent('request', { objective: documentRequest, constraints: ['必须覆盖每份文档且保留原始出处'],
    expectedOutputs: ['覆盖八份文档的 Markdown 汇总'], acceptanceCriteria: ['全部八份文档的独有事实和出处均出现'],
    ...(count >= 2 ? { decomposition: { kind: 'mapReduce' as const,
      partitions: Array.from({ length: count }, (_, group) => ({ id: `group-${group + 1}`,
        objective: `研究以下来源：${documentUrls.filter((_, index) => index % count === group).join(' ')}`,
        expectedOutput: '保留该组每份文档的独有事实和原始出处' })),
      synthesis: '完整汇总全部分组；逐一保留八份文档的事实与出处；明确任何失败或缺失。' } } : { decomposition: null }) });
}

/** Provider responses and source HTTP transport are controlled; production web_fetch parses each body. */
export class MapCapacityFixture extends InputIntentFixture {
  readonly documentReads: string[] = [];
  readonly sourceTools = new CloudflareWebTools({ env: {}, transport: async url => {
    const address = String(url); this.documentReads.push(address);
    const index = documentUrls.indexOf(address); assert(index >= 0, `Unexpected source ${address}`);
    return new Response(documentBodies[index], { headers: { 'content-type': 'text/markdown' } });
  } });
  readonly releases: (() => void)[] = [];
  parallel?: Promise<boolean[]>;
  firstOverCapacity = false;
  firstCapacityOverride = false;
  readonly beforeProviderOrdinary: number[] = [];
  constructor(maxPartitions?: 0 | 1) {
    const config = intentConfig({ retries: 1 });
    if (maxPartitions !== undefined) config.limits.ordinary = maxPartitions + 3;
    super(config);
    this.beforeResponse = request => { if (request.kind === 'interpretation') this.beforeProviderOrdinary.push(this.context().usage.ordinary); };
    this.response = request => this.reply(request);
  }
  reply(request: IntentRequest): Response {
    if (request.kind === 'interpretation') {
      const cap = request.context.maxPartitions;
      assert.equal(typeof cap, 'number', 'Interpretation must receive host-fixed maxPartitions');
      const first = this.requests.filter(item => item.kind === 'interpretation').length === 1;
      const spec = groupedIntent(this.firstOverCapacity && first ? 8 : Math.min(4, cap as number));
      if (this.firstCapacityOverride && first) Object.assign(spec, { maxPartitions: 8 });
      return modelResponse({ type: 'interpretation', spec });
    }
    if (request.kind === 'check') return modelResponse(fixtureJudgments(request.context.requirements as AcceptanceCriterion[]));
    if (request.kind === 'assistance') {
      const partition = request.context.partition as { objective: string };
      const assigned = partition.objective.match(/https:\/\/docs\.fixture\.example\/doc-\d\.md/g) ?? [];
      const pages = request.messages.slice(2).filter(message => message.role === 'user').map(message => {
        try { return JSON.parse(message.content) as { type?: string; text?: string }; } catch { return {}; }
      }).filter(message => message.type === 'web_fetch_result');
      if (pages.length < assigned.length) return modelResponse({ type: 'web_fetch', url: assigned[pages.length] });
      assert.equal(pages.length, assigned.length);
      return modelResponse({ type: 'answer', text: pages.map(page => page.text).join('\n\n'), status: 'success' });
    }
    const discussion = request.context.discussion as { results: { answer: string }[] };
    const completeEvidence = discussion.results.map(result => result.answer).join('\n\n');
    if (request.kind === 'discussionSummary') return modelResponse({ type: 'answer', text: completeEvidence, status: 'success' });
    return modelResponse({ type: 'deliver', text: '八份文档的汇总已生成。', artifactIds: [],
      artifacts: [{ name: 'documents.md', content: `# 八份文档汇总\n\n${completeEvidence}` }] });
  }
  override run() {
    return new WorkRunner(this.engine, this.adapter, () => this.now, undefined, this.sourceTools).runOne(this.room, this.task);
  }
  pending(kind: Intent['kind']) { return this.engine.pending(this.room, this.task).filter(work => work.kind === kind); }
  async recognize() { assert.equal(this.submit(documentRequest).ok, true); assert.equal(await this.run(), true); }
  assertPlan(expected = 4) {
    const interpretations = this.requests.filter(request => request.kind === 'interpretation');
    assert.equal(interpretations[0]?.context.maxPartitions, expected);
    assert.equal(this.beforeProviderOrdinary[0], 1);
    const plan = this.context().inputAnalyses?.[0]?.spec?.decomposition;
    assert(plan); assert.equal(plan.partitions.length, expected);
    const assigned = plan.partitions.flatMap(part => part.objective.match(/https:\/\/docs\.fixture\.example\/doc-\d\.md/g) ?? []);
    assert.deepEqual(assigned.sort(), [...documentUrls].sort());
    assert.equal(this.pending('assistance').length, expected);
  }
  async beginParallel() {
    const works = this.pending('assistance'); assert.equal(works.length, 4);
    let started!: () => void;
    const allStarted = new Promise<void>(resolve => { started = resolve; });
    const original = this.response!; const seen = new Set<string>();
    this.response = request => {
      const response = original(request);
      if (request.kind !== 'assistance') return response;
      const partition = request.context.partition as { id: string };
      if (seen.has(partition.id)) return response;
      seen.add(partition.id);
      return new Response(new ReadableStream<Uint8Array>({ start: controller => {
        this.releases.push(() => { void response.arrayBuffer().then(bytes => { controller.enqueue(new Uint8Array(bytes)); controller.close(); }); });
        if (seen.size === 4) started();
      } }));
    };
    this.parallel = Promise.all(works.map(work => new WorkRunner(this.engine, this.adapter, () => this.now, undefined, this.sourceTools).runOne(this.room, this.task, work.id)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([allStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('All four maps must begin before releasing the first')), 2000); })]); }
    catch (error) { this.releaseMaps(); await this.parallel; throw error; }
    finally { clearTimeout(timer); this.response = original; }
    assert.equal(this.context().intents.filter(work => work.kind === 'assistance' && work.status === 'inflight').length, 4);
    assert.equal(this.pending('discussionSummary').length, 0);
  }
  releaseMaps() { for (const release of this.releases.splice(0)) release(); }
  async finish() {
    this.releaseMaps(); await this.parallel;
    assert.equal(this.pending('discussionSummary').length, 1);
    assert.deepEqual([...this.documentReads].sort(), [...documentUrls].sort());
    assert.equal(await this.run(), true);
    assert.equal(this.pending('owner').length, 1);
    assert.equal(await this.run(), true); assert.equal(await this.run(), true);
    assert.equal(this.context().outcome, 'complete');
    assert.equal(this.requests.filter(request => request.kind === 'discussionSummary').length, 1);
    assert.equal(this.requests.filter(request => request.kind === 'owner').length, 1);
    const artifact = this.context().artifacts.find(item => item.name === 'documents.md'); assert(artifact);
    documentUrls.forEach((url, index) => {
      assert(artifact.content.includes(url)); assert(artifact.content.includes(`DOC_${index + 1}_FACT`));
    });
    const owner = this.requests.find(request => request.kind === 'owner'); assert(owner);
    assert(JSON.stringify(owner.context.messages).includes('必须覆盖每份文档且保留原始出处'));
  }
  assertOwnerFallback() {
    assert.equal(this.pending('assistance').length, 0); assert.equal(this.pending('owner').length, 1);
    const payload = JSON.stringify(this.pending('owner')[0]!.payload);
    documentUrls.forEach(url => assert(payload.includes(url)));
    assert(payload.includes('必须覆盖每份文档且保留原始出处'));
    assert.equal(this.context().usage.assists, 0);
  }
  assertCapacity(expected: number) {
    assert.equal(this.requests[0]?.context.maxPartitions, expected);
    assert.equal(this.beforeProviderOrdinary[0], 1);
    assert(this.pending('assistance').every(work => work.target !== this.context().owner
      && this.config.bots.some(bot => bot.id === work.target)));
  }
}

/** Build legacy/resource-change fixtures through the stored snapshot seam, never the model's output. */
export function updateMapContext(fixture: InputIntentFixture, update: (context: TaskContext) => void) {
  fixture.store.transact(fixture.room, tx => {
    const record = tx.room.tasks[fixture.task] as { snapshot: { context: TaskContext } };
    update(record.snapshot.context);
  });
}

function occupyMember(context: TaskContext) {
  const base = context.intents.find(work => work.kind === 'interpretation'); assert(base);
  context.intents.push({ ...structuredClone(base), id: 'busy-member-operation', kind: 'tool', target: 'B', status: 'uncertain', payload: {} });
}

export function prepareCapacitySnapshot(limit: string) {
  const fixture = new MapCapacityFixture();
  try {
    switch (limit) {
      case '四名可用成员': break;
      case '仅三名空闲成员': break;
      case '剩余两次协助': fixture.config.limits.assists = 2; break;
      case '普通额度只够三片及归并续办': fixture.config.limits.ordinary = 6; break;
      case '本次理解后只够一片': fixture.config.limits.ordinary = 4; break;
      case '本次理解后不足一片': fixture.config.limits.ordinary = 3; break;
      case '资源充足仍受协议上限约束':
        fixture.config.bots.push(...Array.from({ length: 6 }, (_, index) => ({ id: `extra-${index}`, name: `Extra ${index}`, tools: [], instructions: '独立研究' }))); break;
      default: throw new Error(`Unknown capacity limit ${limit}`);
    }
    assert.equal(fixture.submit(documentRequest).ok, true);
    if (limit === '仅三名空闲成员') updateMapContext(fixture, occupyMember);
    return fixture;
  } catch (error) { fixture.close(); throw error; }
}

export async function verifyCapacitySnapshot(limit: string, expected: number) {
  const fixture = prepareCapacitySnapshot(limit);
  try { assert.equal(await fixture.run(), true); fixture.assertCapacity(expected); }
  finally { fixture.close(); }
}

export function verifyCapacityDispatchFallback(change: string) {
  const fixture = new MapCapacityFixture();
  try {
    assert.equal(fixture.submit(documentRequest).ok, true);
    const work = fixture.claim(); assert.equal(work.payload.maxPartitions, 4);
    updateMapContext(fixture, context => {
      if (change === '成员忙碌') occupyMember(context);
      else if (change === '协助余额降低') context.usage.assists = context.config.limits.assists - 3;
      else if (change === '普通余额降低') context.usage.ordinary = context.config.limits.ordinary - 5;
      else throw new Error(`Unknown dispatch change ${change}`);
    });
    const before = fixture.context().usage;
    assert.equal(fixture.result(work, groupedIntent(4)).ok, true);
    assert.equal(fixture.pending('assistance').length, 0);
    assert.equal(fixture.pending('owner').length, 1);
    assert.deepEqual(fixture.context().usage, before);
    const owner = JSON.stringify(fixture.pending('owner')[0]!.payload);
    documentUrls.forEach(url => assert(owner.includes(url)));
    assert(fixture.context().messages.some(message => message.text.includes('未启动并行分片')));
  } finally { fixture.close(); }
}

export async function verifyLegacyCapacityDispatch(limited = false) {
  const fixture = new MapCapacityFixture();
  try {
    assert.equal(fixture.submit(documentRequest).ok, true);
    const original = fixture.claim();
    updateMapContext(fixture, context => {
      delete context.intents.find(work => work.id === original.id)!.payload.maxPartitions;
      if (limited) context.usage.assists = context.config.limits.assists - 3;
    });
    fixture.reopen();
    const work = fixture.claim();
    assert.equal(fixture.result(work, groupedIntent(4)).ok, true);
    assert.equal(fixture.pending('assistance').length, limited ? 0 : 4);
    if (limited) assert.equal(fixture.pending('owner').length, 1);
    const count = fixture.context().intents.length;
    assert.equal(fixture.result(work, groupedIntent(4)).duplicate, true);
    assert.equal(fixture.context().intents.length, count);
    if (!limited) {
      const first = fixture.pending('assistance')[0]!;
      assert.equal(await fixture.run(), true);
      assert.equal(fixture.context().discussion?.results.length, 1);
      const reads = [...fixture.documentReads];
      fixture.reopen(); fixture.reopen();
      assert.equal(fixture.context().intents.find(item => item.id === first.id)?.status, 'done');
      assert.equal(fixture.pending('assistance').length, 3);
      assert.equal(await fixture.run(), true); assert.equal(await fixture.run(), true); assert.equal(await fixture.run(), true);
      assert.deepEqual(fixture.documentReads.filter(url => reads.includes(url)), reads);
      await fixture.finish();
    }
  } finally { fixture.close(); }
}
