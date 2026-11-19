import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalRuntime } from '../src/local-runtime.js';
import { WorkRunner } from '../src/runner.js';
import type { Intent } from '../src/types.js';
import { InputIntentFixture, intentConfig, type IntentRequest } from './input-intent-fixture.js';
import { ControlledProcessBackend } from './local-tools-fixture.js';
import { mapIntent } from './map-reduce-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { rawMarker } from './owner-result-aggregation-model-fixture.js';

export type ArtifactRef = { id: string; content?: string };
export type Group = { status: string; content?: string; reason?: string; artifactId?: string; sources: { resultRef: string; artifactIds: string[] }[] };
const command = { type: 'runCli', executable: 'node', args: ['-e', 'console.log("ORIGINAL_COMMAND_RECEIPT")'] };

export function receiptMessages(request: IntentRequest, code: string) {
  return request.messages.flatMap(message => {
    if (message.role !== 'user') return [];
    const value = JSON.parse(message.content);
    return value.type === 'local_tool_result' && value.code === code ? [value.data] : [];
  });
}

export class OwnerAggregationFixture extends InputIntentFixture {
  readonly backend = new ControlledProcessBackend();
  runtime?: LocalRuntime;
  failGroup = false;
  interrupted?: Intent;

  constructor(readonly variant = '多来源调研', readonly limit?: string) {
    const config = intentConfig({ ordinary: limit === '普通额度仅够原交接' ? 5 : 40, assists: 20 });
    if (limit === '只有一名空闲成员') config.bots = config.bots.slice(0, 2);
    super(config, true);
    this.response = request => this.reply(request);
  }

  private reply(request: IntentRequest) {
    const { context } = request;
    if (request.kind === 'interpretation') return modelResponse({ type: 'interpretation', spec: mapIntent() });
    if (context.resultAggregation === 'group') {
      if (this.failGroup) return modelResponse(command);
      const pages = receiptMessages(request, 'ARTIFACT_PAGE');
      for (const artifact of context.artifacts as ArtifactRef[]) {
        if (artifact.content !== undefined) continue;
        const last = pages.filter(page => page.artifact.artifactId === artifact.id).at(-1);
        if (!last || last.nextCursor) return modelResponse({ type: 'readArtifact', artifactId: artifact.id, ...(last ? { cursor: last.nextCursor } : {}) });
      }
      const paged = (context.artifacts as ArtifactRef[]).some(item => item.content === undefined);
      if (paged) assert(pages.some(page => page.text.includes(rawMarker)) && pages.some(page => page.text.includes('END_OF_LONG_PARTITION')));
      return modelResponse({ type: 'answer', status: 'success', text: '覆盖项、原始来源与分歧均已整理，未核验的事实留给主笔。' });
    }
    if (request.kind === 'owner') {
      const failed = (context.groups as Group[] | undefined)?.find(group => group.status === 'failed');
      if (failed && receiptMessages(request, 'ARTIFACT_PAGE').length === 0)
        return modelResponse({ type: 'readArtifact', artifactId: failed.sources[0]!.artifactIds[0] });
      if (this.variant === '含执行凭证的工程交付' && receiptMessages(request, 'EVIDENCE_PAGE').length === 0) {
        const source = (context.partitions as { evidenceIds?: string[] }[]).find(partition => partition.evidenceIds?.length)!;
        return modelResponse({ type: 'readEvidence', sourceOperationId: source.evidenceIds![0], stream: 'stdout' });
      }
      return modelResponse({ type: 'deliver', text: '已完成综合交付并标明未核验处。', artifactIds: [] });
    }
    if (request.kind === 'check') {
      const requirements = context.requirements as { id: string }[];
      return modelResponse({ type: 'check', criteriaResults: requirements.map(({ id }) => ({ criterionId: id, status: 'passed' })) });
    }
    if (request.kind === 'discussionSummary') return modelResponse({ type: 'answer', text: '原有归并交接' });
    const part = context.partition as { id: 'alpha' | 'beta' };
    const engineering = this.variant === '含执行凭证的工程交付' && part.id === 'alpha';
    if (engineering && !request.messages.some(message => message.content.includes('ORIGINAL_COMMAND_RECEIPT'))) return modelResponse(command);
    const body = this.limit === '短答复' ? '短结果' : `${rawMarker}_${part.id}-${'x'.repeat(engineering ? 18000 : part.id === 'alpha' ? 9300 : 6800)}END_OF_LONG_PARTITION`;
    return modelResponse({ type: 'answer', status: this.variant === '保留分歧的方案评审' && part.id === 'beta' ? 'partial' : 'success',
      text: engineering ? '实际退出凭证及正文见附件' : body,
      ...(engineering ? { artifacts: [{ name: 'receipt.json', content: body }, { name: 'facts.txt', content: 'ORIGINAL_COMMAND_RECEIPT' }] } : {}) });
  }

  async prepareResults() {
    const workspaceRoot = join(this.directory!, 'source');
    await mkdir(workspaceRoot);
    this.runtime = await LocalRuntime.create({ dataRoot: join(this.directory!, 'local'), workspaceRoot, skillRoots: [],
      cliCatalog: [], backend: this.backend, clock: () => this.now });
    assert(this.submit('分别核对两份资料；必须保留每个原始来源和不足；最后提供合并报告。').ok);
    assert(await this.run());
    while (this.pending('assistance').some(work => !work.payload.resultAggregation)) {
      const next = this.pending('assistance').find(work => !work.payload.resultAggregation)!;
      assert(await this.run(next.id));
    }
    assert.equal(this.context().discussion!.mapReduce!.partitions.length, 2);
  }

  pending(kind: Intent['kind']) { return this.engine.pending(this.room, this.task).filter(work => work.kind === kind); }
  override run(id?: string) { return new WorkRunner(this.engine, this.adapter, () => this.now, undefined, undefined, this.runtime).runOne(this.room, this.task, id); }

  async resolveGroups() {
    const jobs = this.pending('assistance');
    assert.equal(jobs.length, 2);
    assert((await Promise.all(jobs.map(job => this.run(job.id)))).every(Boolean));
    await this.finishDelivery();
  }

  async finishDelivery() {
    const owner = this.pending('owner');
    assert.equal(owner.length, 1);
    assert(await this.run(owner[0]!.id));
    assert(await this.run(this.pending('check')[0]!.id));
    assert.equal(this.context().outcome, 'complete');
  }

  async prepareInterruptedGroup() {
    const [first, second] = this.pending('assistance');
    assert(first && second && await this.run(first.id));
    this.interrupted = this.engine.claim(this.room, this.task, second.id)!;
    assert(this.interrupted);
  }

  async reopenAfterInterruption() {
    const interrupted = this.interrupted!;
    this.reopen();
    const restored = this.pending('assistance');
    assert.deepEqual(restored.map(work => work.id), [interrupted.id]);
    this.failGroup = true;
    assert(await this.run(interrupted.id));
    assert(!this.staleResult(interrupted).ok);
    assert(!this.staleResult(this.context().intents.find(work => work.id === interrupted.id)!).ok);
    await this.finishDelivery();
  }

  staleResult(work: Intent) {
    return this.event({ type: 'DISCUSSION_RESULT', discussionId: work.discussionId!, workId: work.id, attempt: work.attempt,
      fence: work, status: 'success', text: '旧结果不得保存' });
  }

  async dispose() { await this.runtime?.close(); this.close(); }
}
