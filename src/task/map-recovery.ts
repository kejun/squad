import { z } from 'zod';
import type { AcceptanceCriterion } from '../delivery-acceptance.js';
import type { Candidate, Intent, MapPartitionRun, PartitionRecovery, TaskContext, TaskEvent } from '../types.js';
import { requiredResources, resourceAcquisitionSources, sameResourceIdentity, savedResourceAcquisitions } from '../resource-acquisition.js';
import { deliveryEvidence } from './evidence.js';

const identity = z.string().min(1).max(1024).refine(value => value === value.trim() && !/[\r\n\0]/.test(value));
const recoverySchema = z.array(z.strictObject({ discussionId: identity, partitionId: identity,
  sourceOperationIds: z.array(identity).min(1).max(16).refine(ids => new Set(ids).size === ids.length) })).max(8);
export function validPartitionRecoveries(value: unknown): value is PartitionRecovery[] | undefined {
  return value === undefined || recoverySchema.safeParse(value).success;
}
const eligible = (part: MapPartitionRun) => ['failed', 'partial', 'timeout'].includes(part.status);
const currentRound = (c: TaskContext) => {
  const round = c.discussion;
  return round?.mapReduce?.queue && round.status === 'delivered' && round.epoch === c.epoch && round.goalVersion === c.goalVersion
    ? round : undefined;
};
export const recoveryCriterionId = (discussionId: string, partitionId: string) => `map-recovery:${discussionId}:${partitionId}`;
type Delivery = Pick<Extract<TaskEvent, { type: 'DELIVER' }>, 'workId' | 'partitionRecoveries'>;

/** Validate only host-saved, settled evidence. No source is refreshed or acquired here. */
export function mapRecoveryProblem(c: TaskContext, delivery: Delivery): string | null {
  const claims = delivery.partitionRecoveries;
  if (!claims?.length) return null;
  const round = currentRound(c);
  if (!round) return 'MAP_RECOVERY_NOT_AVAILABLE';
  const owner = c.intents.find(work => work.id === delivery.workId && work.kind === 'owner' && work.target === c.owner
    && work.epoch === c.epoch && work.goalVersion === c.goalVersion);
  if (!owner) return 'MAP_RECOVERY_OWNER_REQUIRED';
  const evidence = deliveryEvidence(c, owner, c.deliveryCycle?.evidence);
  const acquiredWeb = new Map(savedResourceAcquisitions(c).filter(receipt => receipt.source === 'webFetch').map(receipt => [receipt.id, receipt]));
  const seen = new Set<string>();
  for (const claim of claims) {
    if (claim.discussionId !== round.id) return 'MAP_RECOVERY_STALE_DISCUSSION';
    if (seen.has(claim.partitionId)) return 'MAP_RECOVERY_DUPLICATE_PARTITION';
    seen.add(claim.partitionId);
    const part = round.mapReduce!.queue!.find(part => part.partitionId === claim.partitionId);
    if (!part || !eligible(part)) return 'MAP_RECOVERY_PARTITION_NOT_UNRESOLVED';
    for (const id of claim.sourceOperationIds) {
      const source = evidence?.sources.find(source => source.id === id);
      if (!source || source.metadata.epoch !== c.epoch || source.metadata.goalVersion !== c.goalVersion
        || source.metadata.status !== 'succeeded' || source.metadata.completeness !== 'complete'
        || !source.metadata.capturedContentHash || !source.stdout?.trim()) return 'MAP_RECOVERY_EVIDENCE_UNAVAILABLE';
      if (source.metadata.command.type === 'runCli') {
        if (source.metadata.exitCode !== 0) return 'MAP_RECOVERY_EVIDENCE_UNAVAILABLE';
      } else if (source.metadata.command.type === 'webFetch') {
        const receipt = acquiredWeb.get(id);
        if (!receipt || receipt.workId !== source.metadata.sourceWorkId || receipt.operationId !== source.metadata.sourceOperationId
          || receipt.requestHash !== source.metadata.command.requestHash || receipt.contentHash !== source.metadata.capturedContentHash
          || receipt.content !== source.stdout) return 'MAP_RECOVERY_EVIDENCE_UNAVAILABLE';
      } else return 'MAP_RECOVERY_EVIDENCE_UNAVAILABLE';
    }
    const partition = round.mapReduce!.partitions.find(item => item.id === claim.partitionId);
    if (!partition) return 'MAP_RECOVERY_PARTITION_NOT_UNRESOLVED';
    const scope = (work: Intent): Intent => ({ ...work, payload: { ...work.payload, partition } });
    const requirements = requiredResources(c, scope(owner));
    if (requirements.length) {
      // Query each actual source owner; attaching a partition scopes its obligations without
      // changing the receipt's work/attempt/epoch or relabelling saved content as a new read.
      const sources = (evidence?.sources ?? []).filter(source => claim.sourceOperationIds.includes(source.id)).flatMap(source => {
        const work = c.intents.find(item => item.id === source.metadata.sourceWorkId);
        return work ? resourceAcquisitionSources(c, scope(work), [source.id]).filter(receipt =>
          receipt.workId === source.metadata.sourceWorkId && receipt.operationId === source.metadata.sourceOperationId) : [];
      });
      if (requirements.some(requirement => !sources.some(source => sameResourceIdentity(requirement.resource, source.resource))))
        return 'MAP_RECOVERY_RESOURCE_UNVERIFIED';
    }
  }
  return null;
}

export function mapRecoveryCriteria(c: TaskContext, claims: readonly PartitionRecovery[] = []): AcceptanceCriterion[] {
  const round = currentRound(c);
  if (!round) return [];
  return claims.flatMap(claim => {
    const partition = round.mapReduce!.partitions.find(part => part.id === claim.partitionId);
    if (!partition || claim.discussionId !== round.id) return [];
    return [{ id: recoveryCriterionId(round.id, partition.id), goalVersion: c.goalVersion,
      text: `逐片核实负责人已实际补齐原分片${partition.id}，并将完整内容纳入当前交付。原目标：${partition.objective}。预期结果：${partition.expectedOutput}。归并要求：${round.mapReduce!.synthesis}。须从指定完整成功来源逐字引用并验证与本片目标对应；命令成功或负责人自述不足以证明恢复。`,
      sources: [{ kind: 'goal' as const, id: round.mapReduce!.inputId }], requiredSourceIds: [...claim.sourceOperationIds] }];
  });
}

/** A declaration only permits inspection; it never resolves a historical failure itself. */
export function mapRecoveryCheckProblem(c: TaskContext, check: Intent): string | null {
  const candidate = c.candidate;
  if (!candidate?.partitionRecoveries?.length) return null;
  const fixed = check.payload.candidate as Candidate | undefined;
  if (!fixed || fixed.revision !== candidate.revision || JSON.stringify(fixed.partitionRecoveries) !== JSON.stringify(candidate.partitionRecoveries))
    return 'MAP_RECOVERY_CANDIDATE_CHANGED';
  return mapRecoveryProblem(c, { ...(candidate.workId ? { workId: candidate.workId } : {}), partitionRecoveries: candidate.partitionRecoveries });
}

export function uncoveredMapRecoveries(c: TaskContext): string[] {
  const round = currentRound(c);
  if (!round) return [];
  const claimed = new Set(c.candidate?.partitionRecoveries?.filter(claim => claim.discussionId === round.id).map(claim => claim.partitionId));
  return round.mapReduce!.queue!.filter(part => part.status !== 'succeeded' && !claimed.has(part.partitionId)).map(part => part.partitionId);
}

/** Called only after the bound independent check accepted every original and recovery criterion. */
export function resolveMapRecoveries(c: TaskContext, check: Intent, at: number): void {
  const round = currentRound(c), candidate = c.candidate;
  if (!round || !candidate?.revision || !candidate.partitionRecoveries?.length || uncoveredMapRecoveries(c).length) return;
  for (const claim of candidate.partitionRecoveries) {
    const part = round.mapReduce!.queue!.find(part => part.partitionId === claim.partitionId)!;
    part.resolution = { ...structuredClone(claim), candidateRevision: candidate.revision, checkWorkId: check.id,
      criterionId: recoveryCriterionId(round.id, part.partitionId), owner: c.owner, epoch: c.epoch, goalVersion: c.goalVersion, at };
  }
  // The failed attempts stay in queue.status and round.results. Only the proven outstanding debt is retired.
  delete round.incomplete;
}
