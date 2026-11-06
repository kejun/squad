import { afterEach, describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '../src/web/contracts.js';
import { publish } from './artifact-reference-fixture.js';
import { createReferenceHttpHost, verifyReferenceConcurrency } from './artifact-reference-http-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function host() {
  const result = await createReferenceHttpHost();
  cleanup.push(result.close);
  return result;
}

describe('artifact reference HTTP boundary', () => {
  it('[BT_A29] validates source identity and returns source metadata without duplicating its body', async () => {
    const h = await host(); const original = h.service.engine.view(h.room.id, h.sourceArtifact.sourceTaskId);
    const reply = await h.submit({ id: 'revision', text: '补充部署说明，输出 b.md', sourceArtifact: h.sourceArtifact });
    expect(reply.status).toBe(200);
    const snapshot = await (await fetch(h.route)).json() as RoomSnapshot;
    const revised = snapshot.tasks.find(task => task.id === reply.data.taskId)!;
    expect(revised.sourceArtifact).toMatchObject({ ...h.sourceArtifact, name: 'a.md', owner: 'A' });
    expect(revised.sourceArtifact).not.toHaveProperty('content');
    expect(h.service.engine.view(h.room.id, reply.data.taskId)?.context.sourceArtifact?.content).toBe('# 原文\n保留内容');
    expect(h.service.engine.view(h.room.id, h.sourceArtifact.sourceTaskId)).toEqual(original);
  });

  it('[BT_A30] returns only same-room candidate metadata in a structured conflict response', async () => {
    const h = await host(); publish(h.service.engine, 'second', 'a.md', '# 第二份', h.room.id, 'A', Date.now());
    const secret = h.service.createRoom('另一个群'); publish(h.service.engine, 'private', 'a.md', '# 私密', secret.id, 'A', Date.now());
    const reply = await h.submit({ id: 'revision', text: '修改 a.md，补充部署说明' });
    expect(reply.status).toBe(409); expect(reply.data.code).toBe('AMBIGUOUS_SOURCE_ARTIFACT');
    expect(reply.data.sourceCandidates).toHaveLength(2);
    expect(reply.data.sourceCandidates?.map(source => source.sourceTaskId)).toEqual(['task:source', 'task:second']);
    expect(reply.data.sourceCandidates?.[0]).not.toHaveProperty('content');
    expect(h.service.snapshot(h.room.id).tasks).toHaveLength(2);
  });

  it.each([
    { sourceTaskId: 'task:source', artifactId: 'source:document', content: '伪造正文' },
    { sourceTaskId: 'task:source' },
    { sourceTaskId: '', artifactId: 'source:document' },
    { sourceTaskId: 'task:source', artifactId: 1 },
  ])('[BT_A31] rejects malformed source payloads %o', async sourceArtifact => {
    const h = await host();
    const reply = await h.submit({ id: 'bad', text: '修改来源', sourceArtifact });
    expect(reply.status).toBe(400); expect(h.service.snapshot(h.room.id).tasks).toHaveLength(1);
  });

  it('[BT_A33] rejects control fields instead of silently discarding them', async () => {
    const h = await host();
    const reply = await h.submit({ id: 'bad', text: '修改来源', sourceArtifact: h.sourceArtifact, extraOrdinary: 2 });
    expect(reply.status).toBe(400); expect(h.service.snapshot(h.room.id).tasks).toHaveLength(1);
  });

  it('[BT_A36] returns one task and the original receipt for concurrent identical HTTP requests', () => verifyReferenceConcurrency('same'));

  it('[BT_A36] creates at most one revision for concurrent distinct HTTP request identities', () => verifyReferenceConcurrency('distinct'));
});
