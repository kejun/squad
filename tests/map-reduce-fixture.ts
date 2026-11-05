import assert from 'node:assert/strict';
import { InputIntentFixture, intentConfig, parsedIntent, type IntentRequest } from './input-intent-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { fixtureJudgments } from './delivery-protocol-fixture.js';
import type { AcceptanceCriterion } from '../src/delivery-acceptance.js';
import { WorkRunner, type Intent, type TaskEvent } from '../src/index.js';

export const mapIntent = () => parsedIntent('request', { decomposition: { kind: 'mapReduce', partitions: [
  { id: 'alpha', objective: '研究甲来源', expectedOutput: '甲证据与出处' },
  { id: 'beta', objective: '研究乙来源', expectedOutput: '乙证据与出处' },
], synthesis: '比较证据并说明差异和未知' } });
export class MapReduceFixture extends InputIntentFixture {
  failure?: string;
  releases: (() => void)[] = [];
  parallel?: Promise<unknown[]>;
  repeated?: TaskEvent;
  constructor(limit?: string, sqlite = false) {
    const config = intentConfig({ retries: 0 });
    if (limit === '普通额度不足') config.limits.ordinary = 4;
    if (limit === '协助额度不足') config.limits.assists = 1;
    if (limit === '可用成员不足') config.bots = config.bots.slice(0, 2);
    super(config, sqlite);
    this.response = request => this.reply(request);
  }
  reply(request: IntentRequest): Response {
    if (request.kind === 'interpretation') return modelResponse({ type: 'interpretation', spec: mapIntent() });
    if (request.kind === 'check') return modelResponse(fixtureJudgments(request.context.requirements as AcceptanceCriterion[]));
    const part = request.context.partition as { id: string } | undefined;
    if (part?.id === 'alpha' && this.failure === '失败') return new Response('service unavailable', { status: 401 });
    const status = part?.id === 'alpha' && this.failure === '部分完成' ? 'partial' : 'success';
    return modelResponse({ type: 'answer', text: part ? `${part.id} 原始证据，来源 https://example.com/${part.id}`
      : request.kind === 'discussionSummary' ? '归并认为已经全部完成' : '合并甲乙两份公开来源证据的报告', status });
  }
  async recognize() { assert(this.submit('分别研究甲乙两个来源；必须仅使用公开资料并保留出处；最后汇总差异').ok); await this.run(); }
  pending(kind: Intent['kind']) { return this.engine.pending(this.room, this.task).filter(work => work.kind === kind); }
  async beginParallel() {
    const works = this.pending('assistance'); assert.equal(works.length, 2);
    let started!: () => void;
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const original = this.response!;
    this.response = request => {
      if (request.kind !== 'assistance') return original(request);
      const response = original(request);
      return new Response(new ReadableStream<Uint8Array>({ start: controller => {
        this.releases.push(() => { void response.arrayBuffer().then(bytes => { controller.enqueue(new Uint8Array(bytes)); controller.close(); }); });
        if (this.releases.length === 2) started();
      } }));
    };
    this.parallel = Promise.all(works.map(work => new WorkRunner(this.engine, this.adapter, () => this.now).runOne(this.room, this.task, work.id)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([bothStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Both map HTTP calls must start before release')), 2000); })]); }
    catch (error) { this.releaseMaps(); await this.parallel; throw error; }
    finally { clearTimeout(timer); }
    this.response = original;
  }
  releaseMaps() { for (const release of this.releases.splice(0)) release(); }
  assertParallel() {
    assert.equal(this.context().intents.filter(work => work.kind === 'assistance' && work.status === 'inflight').length, 2);
    const maps = this.requests.filter(request => request.kind === 'assistance');
    assert.deepEqual(maps.map(request => (request.context.partition as { id: string }).id), ['alpha', 'beta']);
    assert(maps.every(request => JSON.stringify(request.context).includes('必须仅使用公开资料并保留出处')));
    assert(maps.every(request => request.messages[0]!.content.includes('independent read-only map subtask')));
    assert.equal(this.pending('owner').length, 0); assert.equal(this.pending('discussionSummary').length, 0);
  }
  async finishMaps() { this.releaseMaps(); await this.parallel; assert.equal(this.pending('discussionSummary').length, 1); await this.run(); }
  assertHandoff() {
    const work = this.pending('owner'); assert.equal(work.length, 1); assert.equal(work[0]!.target, 'A');
    const round = work[0]!.payload.discussion as { results: unknown[]; mapReduce: { synthesis: string } };
    assert.equal(round.results.length, 2); assert.equal(round.mapReduce.synthesis, mapIntent().decomposition!.synthesis);
    assert(JSON.stringify(work[0]!.payload).includes('alpha 原始证据')); assert(JSON.stringify(work[0]!.payload).includes('beta 原始证据'));
  }
  async drain() { for (let n = 0; n < 12; n++) if (!await this.run()) return; assert.fail('Map task did not settle in bounded steps'); }
  claimMaps() { return this.pending('assistance').map(work => { const claimed = this.engine.claim(this.room, this.task, work.id); assert(claimed); return claimed; }); }
  record(work: Intent) {
    const event: TaskEvent = { id: `map-result:${work.id}`, at: this.now, type: 'DISCUSSION_RESULT', workId: work.id, attempt: work.attempt,
      fence: work, discussionId: work.discussionId!, text: 'alpha 原始证据', status: 'success' };
    this.repeated = event; return this.engine.send(this.room, this.task, event);
  }
}
