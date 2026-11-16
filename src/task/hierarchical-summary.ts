import { codePointLength, savedPageCodePoints } from '../evidence-reader.js';
import type { Artifact, DiscussionRound, Intent, SummaryLayer, TaskContext, TaskEvent } from '../types.js';
import { documentIdentity } from './delivery.js';
import { capabilities, discussionActive, fence } from './facts.js';
import { availableMapReduceMembers, mapReduceCapacity } from './map-reduce-capacity.js';
import { advanceMapQueue } from './map-queue.js';
import { message } from './operations.js';
import { processingWindow } from './resilience.js';

export interface ArtifactIndex {
  id: string; documentId: string; revision: number; goalVersion: number;
}

const summaryRequest = /汇总|归纳/;

export function summaryArticles(c: TaskContext): Artifact[] {
  return c.artifacts.filter(artifact => artifact.goalVersion === c.goalVersion);
}

export function corpusBodiesExceedPage(c: TaskContext): boolean {
  return codePointLength(summaryArticles(c).map(artifact => artifact.content).join('')) > savedPageCodePoints;
}

export function summaryRequested(c: TaskContext): boolean {
  const input = [...(c.inputAnalyses ?? [])].reverse().find(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion && item.status !== 'cancelled');
  return summaryRequest.test(input?.rawText ?? '');
}

export function hierarchicalSummaryPending(c: TaskContext): boolean {
  return summaryRequested(c) && corpusBodiesExceedPage(c);
}

export function artifactIndex(artifact: Artifact): ArtifactIndex {
  return { id: artifact.id, documentId: documentIdentity(artifact), revision: artifact.revision ?? 1, goalVersion: artifact.goalVersion };
}

export function shortArtifactSkeleton(ids: readonly string[]): string {
  return `来源\n${ids.join('\n')}\n要点\n`;
}

/** Fan-in is however many direct source ids still leave room for points on one existing page. */
export function sourceBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const id of ids) {
    const next = [...batch, id];
    if (codePointLength(shortArtifactSkeleton(next)) >= savedPageCodePoints) {
      if (batch.length) batches.push(batch);
      else batches.push([id]);
      batch = batch.length ? [id] : [];
    } else batch = next;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function directSourceIds(body: string): string[] {
  if (!body.startsWith('来源\n')) return [];
  const mark = body.indexOf('\n要点\n');
  if (mark < 0) return [];
  return body.slice('来源\n'.length, mark).split('\n').map(item => item.trim()).filter(Boolean);
}

export function validShortArtifact(body: string, expected: readonly string[]): boolean {
  if (codePointLength(body) > savedPageCodePoints || codePointLength(body) === 0) return false;
  const points = body.split('\n要点\n')[1]?.trim() ?? '';
  if (!points) return false;
  const ids = directSourceIds(body);
  return ids.length === expected.length && expected.every(id => ids.includes(id));
}

export function summaryTop(c: TaskContext): Artifact | undefined {
  const id = c.discussion?.mapReduce?.summaryLayer?.topId;
  return id ? c.artifacts.find(artifact => artifact.id === id) : undefined;
}

export function hierarchicalContext(c: TaskContext, batch: readonly ArtifactIndex[] = []) {
  return {
    hierarchicalSummary: true,
    goal: c.goal,
    inputIntents: (c.inputAnalyses ?? []).filter(input => input.status === 'resolved'),
    roster: c.config.bots.map(bot => ({ id: bot.id, name: bot.name, instructions: bot.instructions, tools: bot.tools })),
    capabilities: capabilities(c),
    artifacts: batch,
  };
}

export function summaryHandoffPayload(c: TaskContext, top: Artifact) {
  const direct = directSourceIds(top.content).map(id => {
    const artifact = c.artifacts.find(item => item.id === id);
    return artifact ? artifactIndex(artifact) : { id };
  });
  return { ...hierarchicalContext(c), summaryHandoff: true, summary: top.content, sourceIndex: direct, artifacts: [] };
}

export function discussionWithoutAnswers(round: DiscussionRound): DiscussionRound {
  const copy = structuredClone(round);
  for (const result of copy.results) result.answer = '';
  return copy;
}

function capacityReason(c: TaskContext): string {
  if (!availableMapReduceMembers(c).length) return '可用成员不足';
  if (c.config.limits.assists - c.usage.assists < 1) return '协助额度不足';
  return '普通额度不足';
}

function latestInput(c: TaskContext) {
  return [...(c.inputAnalyses ?? [])].reverse().find(item => item.epoch === c.epoch && item.goalVersion === c.goalVersion && item.status === 'resolved');
}

function absorbRound(c: TaskContext): void {
  const round = c.discussion!, plan = round.mapReduce!, layer = plan.summaryLayer!;
  for (const part of plan.queue ?? []) {
    if (part.status === 'succeeded') {
      const result = round.results.find(item => item.id === part.resultRef);
      for (const id of result?.artifactIds ?? []) if (!layer.producedIds.includes(id)) layer.producedIds.push(id);
    } else if (part.status !== 'queued' && part.status !== 'running' && part.status !== 'uncertain') {
      for (const id of layer.roundSources[part.partitionId] ?? []) {
        if (!layer.carried.some(item => item.id === id)) layer.carried.push({ id, status: part.status, ...(part.reason ? { reason: part.reason } : {}) });
      }
    }
  }
}

export function openSummaryRound(c: TaskContext, e: TaskEvent): boolean {
  const round = c.discussion!, plan = round.mapReduce!, layer = plan.summaryLayer!;
  if (mapReduceCapacity(c) < 1 || !layer.pendingSourceIds.length) {
    round.status = 'cancelled';
    round.incomplete = capacityReason(c);
    message(c, e, 'facilitator', `未启动并行分片：${round.incomplete}。未形成顶层摘要，不把未归并的文章交给方案师。`, 'notice');
    return false;
  }
  const capacity = mapReduceCapacity(c);
  const batches = sourceBatches(layer.pendingSourceIds);
  const taken = batches.slice(0, capacity);
  const takenIds = new Set(taken.flat());
  layer.pendingSourceIds = layer.pendingSourceIds.filter(id => !takenIds.has(id));
  layer.rounds += 1;
  layer.roundSources = {};
  plan.partitions = taken.map((ids, index) => {
    const id = `L${layer.layer}R${layer.rounds}-${index + 1}`;
    layer.roundSources[id] = ids;
    return { id, objective: '把本批直接来源编号和要点写成一条不超过一页的短产物', expectedOutput: '直接来源编号与要点' };
  });
  plan.concurrency = Math.min(availableMapReduceMembers(c).length, plan.partitions.length);
  const deadline = Math.min(e.at + c.config.limits.workTimeoutMs, processingWindow(c).hardDeadline, processingWindow(c).repairDeadline ?? Number.MAX_SAFE_INTEGER);
  plan.queue = plan.partitions.map(part => ({ partitionId: part.id, attempt: 0, status: 'queued' as const, deadline }));
  round.status = 'collecting';
  advanceMapQueue(c, e);
  c.trace.push({ event: 'SUMMARY_ROUND', at: e.at, detail: JSON.stringify({ layer: layer.layer, batches: plan.partitions.length, pending: layer.pendingSourceIds.length }) });
  return true;
}

/** Host-owned batches. Returns true when this path owns the request, including a capacity refusal. */
export function beginHierarchicalSummary(c: TaskContext, e: TaskEvent): boolean {
  if (!hierarchicalSummaryPending(c)) return false;
  if (c.discussion?.mapReduce?.summaryLayer) return true;
  if (discussionActive(c)) return false;
  const input = latestInput(c);
  if (input) input.decompositionApplied = true;
  const sources = summaryArticles(c).map(artifact => artifact.id);
  const layer: SummaryLayer = { layer: 1, rounds: 0, pendingSourceIds: sources, producedIds: [], carried: [], inputCount: sources.length, roundSources: {} };
  c.discussion = { id: `summary:${input?.id ?? e.id}`, request: input?.rawText ?? c.goal.text, targets: [], status: 'collecting',
    results: [], skipped: [], mapReduce: { kind: 'mapReduce', partitions: [], synthesis: '逐层把直接来源收成一条不超过一页的摘要',
      inputId: input?.id ?? e.id, assignments: [], queue: [], summaryLayer: layer }, ...fence(c) };
  openSummaryRound(c, e);
  return true;
}

export type SummarySettlement = 'continue' | 'handoff' | 'stop' | 'capacity';

export function settleHierarchicalLayer(c: TaskContext, e: TaskEvent): SummarySettlement {
  const layer = c.discussion?.mapReduce?.summaryLayer;
  if (!layer) return 'handoff';
  absorbRound(c);
  if (layer.pendingSourceIds.length) return openSummaryRound(c, e) ? 'continue' : 'capacity';
  if (layer.producedIds.length === 1 && layer.carried.length === 0) {
    const top = c.artifacts.find(artifact => artifact.id === layer.producedIds[0]);
    if (!top || codePointLength(top.content) > savedPageCodePoints) return 'stop';
    layer.topId = top.id;
    return 'handoff';
  }
  const next = [...layer.producedIds];
  for (const failure of layer.carried) if (!next.includes(failure.id)) next.push(failure.id);
  if (!next.length || next.length >= layer.inputCount) return 'stop';
  layer.layer += 1;
  layer.pendingSourceIds = next;
  layer.inputCount = next.length;
  layer.producedIds = [];
  layer.carried = [];
  layer.roundSources = {};
  return openSummaryRound(c, e) ? 'continue' : 'capacity';
}

export function batchIndexes(c: TaskContext, ids: readonly string[]): ArtifactIndex[] {
  return ids.flatMap(id => {
    const artifact = c.artifacts.find(item => item.id === id);
    return artifact ? [artifactIndex(artifact)] : [];
  });
}

/** Shard payload lists this batch only, with no article or short-artifact body. */
export function assignSummaryBatch(c: TaskContext, work: Intent, partitionId: string): void {
  const ids = c.discussion?.mapReduce?.summaryLayer?.roundSources[partitionId];
  if (!ids) return;
  const round = discussionWithoutAnswers(c.discussion!);
  work.payload = { ...hierarchicalContext(c, batchIndexes(c, ids)), sourceIds: ids,
    partition: c.discussion!.mapReduce!.partitions.find(item => item.id === partitionId),
    discussion: round, question: '把本批直接来源编号和要点写成一条不超过一页的短产物', expected: '直接来源编号与要点',
    ...(work.payload.partitionAttempt !== undefined ? { partitionAttempt: work.payload.partitionAttempt } : {}),
    ...(typeof work.payload.instructions === 'string' ? { instructions: work.payload.instructions } : {}) };
}
