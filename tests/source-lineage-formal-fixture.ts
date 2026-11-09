import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ArtifactSource, Intent, TaskEvent } from '../src/types.js';
import { deliveryHost, type DeliveryBackend } from './delivery-composition-fixture.js';

export async function createSourceLineage(root: string, backend: DeliveryBackend, directory: string) {
  const host = await deliveryHost(root, backend, directory);
  const checkA = host.deliver(); assert(host.consume(checkA).ok); assert(host.send(host.bodyFor(checkA)).ok);
  const taskA = host.task, taskB = 'task:revision-b', taskC = 'task:revision-c';
  const oldArtifact = structuredClone(host.context().artifacts[0]!);
  const oldFinal = structuredClone(host.context().messages.find(item => item.kind === 'final')!);
  const referenceA = { sourceTaskId: taskA, artifactId: oldArtifact.id };
  const inputB = { id: 'revision-b', text: '修改 report.md，补充第二轮内容，输出 b.md', sourceArtifact: referenceA };
  let stage = 0, reopened = false, staleRejected = false, recovered = false, sequence = 0;
  let frozen: ArtifactSource | undefined;
  let badFrozenContent = false;
  let ownerA: Intent | undefined, ownerB: Intent | undefined, currentA: Intent | undefined, checkB: Intent | undefined;
  let checkBody: Record<string, unknown> | undefined;
  const context = (task: string) => host.engine.view(host.room, task)!.context;
  const send = (task: string, body: Record<string, unknown>) => host.engine.send(host.room, task, { id: 'lineage:' + ++sequence, at: 0, ...body } as TaskEvent);
  const observe = () => {
    const a = context(taskA), b = stage > 0 ? context(taskB) : undefined;
    assert.deepEqual(a.artifacts.find(item => item.id === oldArtifact.id), oldArtifact, 'FrozenSource: old document mutated');
    assert.deepEqual(a.messages.find(item => item.id === oldFinal.id), oldFinal, 'FrozenSource: old final selection mutated');
    if (b) {
      assert.deepEqual(b.sourceArtifact, frozen, 'FrozenSource: source snapshot changed after stop/republish/recovery');
      assert.equal(b.sourceArtifact?.content, oldArtifact.content, 'FrozenSource: snapshot must contain the selected original bytes');
      assert(!b.artifacts.some(item => item.id === oldArtifact.id), 'FrozenSource: input artifact became current output');
    }
    const c = stage === 15 ? context(taskC) : undefined;
    const direct = !c || c.sourceArtifact?.sourceTaskId === taskB && c.sourceArtifact?.artifactId === b?.publishedDelivery?.artifactIds[0];
    assert(direct, 'DirectLineage: third task must freeze the second task publication, not its ancestor');
    const sourceVersion = a.artifacts.find(item => item.id === a.publishedDelivery!.artifactIds[0])!.revision!;
    return { stage, sourceVersion, frozenVersion: b?.sourceArtifact?.revision ?? 0, direct, reopened, staleRejected, recovered, badFrozenContent };
  };
  const apply = (action: string) => {
    switch (action) {
      case 'FreezeB':
        assert(host.engine.submit(host.room, inputB).ok, 'FrozenSource: source selection must be reachable'); stage = 1;
        frozen = structuredClone(context(taskB).sourceArtifact!);
        badFrozenContent = frozen.content !== oldArtifact.content;
        assert(!badFrozenContent, 'FrozenSource: initial source bytes differ from selected publication');
        assert.deepEqual(frozen, { sourceTaskId: taskA, artifactId: oldArtifact.id, documentId: oldArtifact.documentId,
          revision: oldArtifact.revision, name: oldArtifact.name, owner: context(taskA).owner,
          publishedAt: context(taskA).publishedDelivery!.at, publicationRevision: context(taskA).publishedDelivery!.revision,
          content: oldArtifact.content, contentHash: createHash('sha256').update(oldArtifact.content).digest('hex') }, 'FrozenSource: initial snapshot must bind the selected publication bytes and identity');
        break;
      case 'StopB': assert(send(taskB, { type: 'STOP' }).ok); stage = 2; break;
      case 'ContinueA': assert(host.engine.submit(host.room, { id: 'continue-a', text: '继续原任务', intent: 'continue', replyToTaskId: taskA }).ok); stage = 3; break;
      case 'ClaimA': ownerA = host.claim('owner'); stage = 4; break;
      case 'DeliverA': assert(ownerA); host.submitDraft(ownerA, oldArtifact.id); stage = 5; break;
      case 'ClaimCheckA': currentA = host.claim('check'); stage = 6; break;
      case 'ConsumeA': assert(currentA); assert(host.consume(currentA).ok); stage = 7; break;
      case 'RepublishA': assert(currentA); assert(host.send(host.bodyFor(currentA)).ok); stage = 8; break;
      case 'RejectStale': {
        const before = Object.keys(host.store.read(host.room).tasks);
        const result = host.engine.submit(host.room, { ...inputB, id: 'new-stale-source' });
        assert.equal(result.code, 'SOURCE_ARTIFACT_UNAVAILABLE', 'FrozenSource: a new task accepted a superseded publication');
        assert.deepEqual(Object.keys(host.store.read(host.room).tasks), before); staleRejected = true; break;
      }
      case 'ResumeB': assert(host.engine.submit(host.room, { id: 'continue-b', text: '继续修订任务', intent: 'continue', replyToTaskId: taskB }).ok); stage = 9; break;
      case 'ClaimB':
        ownerB = host.engine.claim(host.room, taskB, host.engine.pending(host.room, taskB).find(work => work.kind === 'owner')!.id)!;
        assert(ownerB); stage = 10; break;
      case 'DeliverB': {
        assert(ownerB);
        assert(send(taskB, { type: 'DELIVER', workId: ownerB.id, fence: ownerB, text: '修订已完成', artifactIds: [],
          artifacts: [{ name: 'b.md', content: oldArtifact.content + '\nSecond document' }] }).ok);
        stage = 11; break;
      }
      case 'ClaimCheckB':
        checkB = host.engine.claim(host.room, taskB, host.engine.pending(host.room, taskB).find(work => work.kind === 'check')!.id)!;
        assert(checkB); stage = 12; break;
      case 'ConsumeB': {
        assert(checkB); assert(send(taskB, { type: 'CONSUME', intentId: checkB.id, fence: checkB, attempt: checkB.attempt }).ok);
        const candidate = context(taskB).candidate!;
        checkBody = { type: 'CHECK_RESULT', workId: checkB.id, fence: checkB, attempt: checkB.attempt, candidateRevision: candidate.revision,
          resultId: 'lineage-check-b', criteriaResults: candidate.acceptance!.criteria.map(item => ({ criterionId: item.id, status: 'passed' })) };
        stage = 13; break;
      }
      case 'PublishB': assert(checkBody); assert(send(taskB, checkBody).ok); assert.equal(context(taskB).outcome, 'complete'); stage = 14; break;
      case 'FreezeC': {
        const result = host.engine.submit(host.room, { id: 'revision-c', text: '修改 b.md，补充第三轮说明，输出 c.md' });
        assert(result.ok, 'DirectLineage: direct published child must be selectable'); stage = 15; break;
      }
      case 'ReplayFreeze': {
        const before = structuredClone(context(taskB).sourceArtifact), tasks = Object.keys(host.store.read(host.room).tasks);
        assert(host.engine.submit(host.room, inputB).duplicate, 'FrozenSource: repeated original selection must replay its receipt');
        assert.deepEqual(context(taskB).sourceArtifact, before);
        assert.deepEqual(Object.keys(host.store.read(host.room).tasks), tasks); break;
      }
      case 'ConflictReplay': {
        const currentId = context(taskA).publishedDelivery!.artifactIds[0]!;
        assert.equal(host.engine.submit(host.room, { ...inputB, sourceArtifact: { sourceTaskId: taskA, artifactId: currentId } }).code, 'REQUEST_ID_CONFLICT'); break;
      }
      case 'Reopen': host.reopen(); reopened = true; break;
      case 'RecoverFrozen': assert(send(taskB, { type: 'RECOVER', config: host.config }).ok); recovered = true; break;
      default: throw new Error('Unknown source lineage action: ' + action);
    }
    return observe();
  };
  return { observe, apply, close: host.close };
}
