import { createHash } from 'node:crypto';
import type { ArtifactReference, ArtifactSource, ArtifactSourceMetadata, TaskContext } from './types.js';
import { artifactSourceMetadata } from './types.js';
import { documentIdentity, publicationIds } from './task/delivery.js';
import type { ArtifactRequest } from './artifact-request.js';
export { parseArtifactRequest } from './artifact-request.js';
export { artifactSourceMetadata } from './types.js';

type SourceResolution = { kind: 'none' } | { kind: 'resolved'; sourceArtifact: ArtifactSource }
  | { kind: 'rejected'; code: string; detail: string; sourceCandidates?: ArtifactSourceMetadata[] };
type SourceTask = { phase: string; context: TaskContext };

function publishedSources(tasks: SourceTask[]): ArtifactSource[] {
  return tasks.flatMap(({ phase, context: c }) => {
    if (phase !== 'ended' || c.outcome !== 'complete') return [];
    const published = new Set(publicationIds(c) ?? []);
    return c.artifacts.filter(artifact => published.has(artifact.id) && /\.(?:md|markdown)$/i.test(artifact.name))
      .map(artifact => ({ sourceTaskId: c.taskId, artifactId: artifact.id,
        documentId: documentIdentity(artifact), revision: artifact.revision ?? 1,
        name: artifact.name, owner: c.owner,
        publishedAt: c.publishedDelivery?.at ?? c.messages.filter(message => message.kind === 'final').at(-1)?.at ?? c.lastActivityAt,
        ...(c.publishedDelivery?.revision ? { publicationRevision: c.publishedDelivery.revision } : {}),
        content: artifact.content,
        contentHash: createHash('sha256').update(typeof artifact.content === 'string' ? artifact.content : '').digest('hex') }));
  });
}

/** Called within the room transaction; only its committed copy becomes task input. */
export function resolveArtifactSource(tasks: SourceTask[], reference?: ArtifactReference, request?: ArtifactRequest): SourceResolution {
  const sources = publishedSources(tasks);
  const candidates = reference ? sources.filter(source => source.sourceTaskId === reference.sourceTaskId && source.artifactId === reference.artifactId)
    : sources.filter(source => source.name === request?.name);
  if (!candidates.length) return reference || request?.explicit
    ? { kind: 'rejected', code: 'SOURCE_ARTIFACT_UNAVAILABLE', detail: '来源不存在、尚未成功发布或版本已变化，请从当前群的交付清单重新选择 Markdown 产物。' }
    : { kind: 'none' };
  if (candidates.length > 1) return { kind: 'rejected', code: 'AMBIGUOUS_SOURCE_ARTIFACT',
    detail: '有多份同名产物，请选择要修改的来源。', sourceCandidates: candidates.map(artifactSourceMetadata) };
  const sourceArtifact = candidates[0]!;
  if (typeof sourceArtifact.content !== 'string' || !sourceArtifact.content.trim()) return {
    kind: 'rejected', code: 'SOURCE_ARTIFACT_UNREADABLE', detail: '来源正文为空或不可读取，请重新选择已交付的 Markdown 产物。' };
  if (Buffer.byteLength(sourceArtifact.content, 'utf8') > 32 * 1024) return {
    kind: 'rejected', code: 'SOURCE_ARTIFACT_TOO_LARGE', detail: '来源正文超过 32 KiB，请选择更小的 Markdown 产物。' };
  return { kind: 'resolved', sourceArtifact };
}
