import { localEnabled } from '../local-operation.js';
import { hostRetryReservation } from '../host-retry.js';
import { resolveModel } from '../model-config.js';
import { compactMessage } from '../presentation.js';
import { codePointLength, savedPageCodePoints } from '../saved-page.js';
import type { AggregationSource, Artifact, DiscussionRound, ModelService, ResultAggregationGroup, TaskContext, TaskEvent } from '../types.js';
import { workEvidenceIds } from './evidence.js';
import { artifactIndex } from './hierarchical-summary.js';
import { availableMapReduceMembers, mapReduceCapacity } from './map-reduce-capacity.js';
import { saveReports } from './operations.js';
import { processingWindow } from './resilience.js';

type Result = DiscussionRound['results'][number];
type Material = { source: AggregationSource; target: string; textDraft?: { eventId: string; content: string };
  bodyBytes: number; inlineBytes: number; indexBytes: number; pages: number };

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export const groupResultBytes = savedPageCodePoints;
export const validGroupResult = (text: string): boolean => !!text.trim() && bytes(JSON.stringify(text)) - 2 <= groupResultBytes;

function inputBudget(service: ModelService | undefined, limit: number): number {
  if (service?.contextWindowTokens === undefined) return limit;
  const configured = [service.maxTokens, service.extraBody?.max_tokens, service.extraBody?.max_completion_tokens]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const output = configured.length ? Math.max(...configured) : 2048;
  // A conservative serialized-byte allowance for data, after instructions and the output reserve.
  return Math.max(0, Math.min(limit, service.contextWindowTokens - output - 3 * savedPageCodePoints));
}

function taskMaterial(c: TaskContext, round: DiscussionRound) {
  return { goal: c.goal, request: round.request, synthesis: round.mapReduce!.synthesis,
    inputIntents: (c.inputAnalyses ?? []).filter(item => item.status === 'resolved' && item.goalVersion === c.goalVersion) };
}

function sourceDescription(round: DiscussionRound, source: AggregationSource) {
  const result = round.results.find(item => item.id === source.resultRef)!;
  const definition = round.mapReduce!.partitions.find(item => item.id === result.partitionId);
  return { ...source, partitionId: result.partitionId, status: result.status,
    ...(definition ? { objective: compactMessage(definition.objective), expected: compactMessage(definition.expectedOutput) } : {}),
    ...(result.reason ? { reason: compactMessage(result.reason) } : {}) };
}

function materialArtifacts(artifacts: Artifact[], inline: boolean) {
  return artifacts.map(item => ({ ...artifactIndex(item), name: item.name, ...(inline ? { content: item.content } : {}) }));
}

function originalPartitions(c: TaskContext, round: DiscussionRound) {
  const plan = round.mapReduce!;
  return plan.partitions.map(definition => {
    const part = plan.queue!.find(item => item.partitionId === definition.id)!;
    const result = round.results.find(item => item.id === part.resultRef);
    const evidenceIds = part.workId ? workEvidenceIds(c, part.workId) : [];
    return { id: definition.id, status: part.status, resultRef: part.resultRef,
      ...(result?.artifactIds.length ? { artifactIds: result.artifactIds } : {}),
      ...(evidenceIds.length ? { evidenceIds } : {}),
      ...(part.reusedSource ? { reusedSource: part.reusedSource } : {}),
      ...(part.reason ? { reason: compactMessage(part.reason) } : {}) };
  });
}

function groupSources(c: TaskContext, round: DiscussionRound, eventId: string): Material[] {
  return (round.mapReduce!.queue ?? []).flatMap((part, index) => {
    if (part.status !== 'succeeded' && part.status !== 'partial') return [];
    const result = round.results.find((item): item is Result & { id: string } => !!item.id && item.id === part.resultRef);
    if (!result) return [];
    const artifacts = c.artifacts.filter(item => item.goalVersion === c.goalVersion && result.artifactIds.includes(item.id));
    const textDraft = result.answer.trim() && !artifacts.some(item => item.content === result.answer)
      ? { eventId: `${eventId}:aggregation-source:${index + 1}`, content: result.answer } : undefined;
    if (textDraft) {
      // Use the same identity saveReports will assign if the tree is admitted.
      const id = `${c.taskId}:artifact:${textDraft.eventId}:1`;
      artifacts.push({ id, name: 'partition-answer.md', content: textDraft.content, author: result.target, goalVersion: c.goalVersion, documentId: id, revision: 1 });
    }
    if (!artifacts.length) return [];
    const source = { resultRef: result.id, artifactIds: artifacts.map(item => item.id) };
    const descriptionBytes = bytes(sourceDescription(round, source));
    return [{ source, target: result.target, ...(textDraft ? { textDraft } : {}),
      bodyBytes: bytes(artifacts.map(item => item.content)),
      inlineBytes: descriptionBytes + bytes(materialArtifacts(artifacts, true)),
      indexBytes: descriptionBytes + bytes(materialArtifacts(artifacts, false)),
      pages: artifacts.reduce((sum, item) => sum + Math.max(1, Math.ceil(codePointLength(item.content) / savedPageCodePoints)), 0) }];
  });
}

function packGroups(sources: Material[], count: number, inlineBudget: number) {
  const groups = Array.from({ length: count }, () => ({ sources: [] as Material[], size: 0, index: 0, pages: 0 }));
  for (const source of sources) {
    const group = groups.reduce((lightest, candidate) => candidate.size < lightest.size ? candidate : lightest);
    group.sources.push(source);
    group.size += source.inlineBytes;
    group.index += source.indexBytes;
    group.pages += source.pages;
  }
  return groups.map(group => ({ ...group, inline: group.size <= inlineBudget }));
}

/** Admission reserves one root and the estimated saved reads, using only settled work. */
export function beginResultAggregation(c: TaskContext, e: TaskEvent): boolean {
  const round = c.discussion!, plan = round.mapReduce!;
  const members = availableMapReduceMembers(c);
  const max = Math.min(members.length, mapReduceCapacity(c, 0, 1));
  if (max < 2) return false;
  const candidates = groupSources(c, round, e.id);
  const size = candidates.reduce((sum, item) => sum + item.bodyBytes, 0);
  const material = taskMaterial(c, round);
  const rootService = resolveModel(c.config, 'owner', c.owner)?.service;
  const fixedRootInputs = { ...material, inputs: c.inputs.filter(note => note.applied), sourceArtifact: c.sourceArtifact, partitions: originalPartitions(c, round) };
  const rootBudget = inputBudget(rootService, 6 * savedPageCodePoints) - bytes(fixedRootInputs) - 256;
  const groupBudget = Math.min(...members.map(member => inputBudget(resolveModel(c.config, 'assistance', member.id)?.service, 8 * savedPageCodePoints))) - bytes(material) - 256;
  const inlineBudget = Math.min(groupBudget, 4 * savedPageCodePoints - bytes(material) - 256);
  const readers = members.filter(member => localEnabled(c.config, member.id)).length;
  const sourceRefs = bytes(candidates.map(item => item.source));
  const ordinary = c.config.limits.ordinary - c.usage.ordinary - hostRetryReservation(c) - 1;
  const sourceOrder = [...candidates].sort((a, b) => b.inlineBytes - a.inlineBytes);
  let selected: ReturnType<typeof packGroups> | undefined;
  let minReads = Infinity;
  for (let count = 2; count <= Math.min(max, candidates.length); count++) {
    const resultCost = count * (groupResultBytes + 384) + sourceRefs;
    if (resultCost >= size || resultCost >= rootBudget) break;
    const groups = packGroups(sourceOrder, count, inlineBudget);
    const pages = groups.filter(group => !group.inline).reduce((sum, group) => sum + group.pages, 0);
    if (groups.some(group => group.index > inlineBudget || !group.inline && group.size + 1024 * group.pages > groupBudget)
      || groups.filter(group => !group.inline).length > readers
      || count + 2 * pages > ordinary || pages >= minReads) continue;
    selected = groups;
    minReads = pages;
    if (!pages) break;
  }
  if (!selected) return false;

  const groups: Record<string, ResultAggregationGroup> = {};
  const deadline = Math.min(e.at + c.config.limits.workTimeoutMs, processingWindow(c).hardDeadline, processingWindow(c).repairDeadline ?? Number.MAX_SAFE_INTEGER);
  let sequence = 0;
  for (const group of selected.sort((a, b) => Number(a.inline) - Number(b.inline))) {
    let id = `aggregate:${++sequence}`;
    while (plan.partitions.some(part => part.id === id)) id = `aggregate:${++sequence}`;
    const sources = group.sources.map(({ source, target, textDraft }) => {
      if (textDraft) saveReports(c, { ...e, id: textDraft.eventId }, '', target, [{ name: 'partition-answer.md', content: textDraft.content }]);
      return source;
    });
    groups[id] = { sources, inline: group.inline };
    plan.queue!.push({ partitionId: id, attempt: 0, status: 'queued', deadline });
  }
  plan.concurrency = selected.length;
  plan.resultAggregation = groups;
  c.trace.push({ event: 'RESULT_AGGREGATION', at: e.at, detail: JSON.stringify({ groups: selected.length, sourceBytes: size, pages: minReads }) });
  return true;
}

export function aggregationGroupPayload(c: TaskContext, group: ResultAggregationGroup) {
  const round = c.discussion!;
  const artifactIds = new Set(group.sources.flatMap(source => source.artifactIds));
  const artifacts = c.artifacts.filter(item => artifactIds.has(item.id));
  return { ...taskMaterial(c, round), resultAggregation: 'group',
    sources: group.sources.map(source => sourceDescription(round, source)),
    artifacts: materialArtifacts(artifacts, group.inline),
    capabilities: { webSearch: false, webFetch: false, findSkills: false },
  };
}

export function resultAggregationHandoff(c: TaskContext) {
  const round = c.discussion, plan = round?.mapReduce;
  if (!plan?.resultAggregation || !round || round.status !== 'delivered' || round.epoch !== c.epoch || round.goalVersion !== c.goalVersion) return undefined;
  const groups = Object.entries(plan.resultAggregation).map(([id, group]) => {
    const part = plan.queue!.find(item => item.partitionId === id)!;
    const result = round.results.find(item => item.id === part.resultRef);
    const artifact = c.artifacts.find(item => result?.artifactIds.includes(item.id));
    return { id, status: part.status, sources: group.sources,
      ...(artifact ? { artifactId: artifact.id, content: artifact.content } : {}),
      ...(part.reason ? { reason: compactMessage(part.reason) } : {}) };
  });
  return { ...taskMaterial(c, round), resultAggregation: 'owner', groups, partitions: originalPartitions(c, round),
    ...(c.sourceArtifact ? { sourceArtifact: c.sourceArtifact } : {}), artifacts: [] };
}
