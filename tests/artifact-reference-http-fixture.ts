import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createWebServer } from '../src/web/http.js';
import { WebService } from '../src/web/service.js';
import type { CommandResult } from '../src/engine.js';
import { configuration } from './helpers.js';
import { publish } from './artifact-reference-fixture.js';

export async function createReferenceHttpHost() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-reference-http-'));
  const service = new WebService(configuration(), join(directory, 'state.sqlite'), {
    async execute() { return { type: 'askUser', question: '请确认部署环境' }; },
  });
  const server = createWebServer(service);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    } finally {
      try { await service.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  }
  try {
    const room = service.createRoom('修订方案');
    const sourceArtifact = publish(service.engine, 'source', 'a.md', '# 原文\n保留内容', room.id, 'A', Date.now());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const route = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/rooms/${room.id}`;
    async function submit(payload: unknown) {
      const response = await fetch(`${route}/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
      return { status: response.status, data: await response.json() as CommandResult & { error?: string } };
    }
    return { service, room, sourceArtifact, submit, route, close };
  } catch (error) { await close(); throw error; }
}

export async function verifyReferenceConcurrency(kind?: 'same' | 'distinct'): Promise<void> {
  if (!kind) { await verifyReferenceConcurrency('same'); await verifyReferenceConcurrency('distinct'); return; }
  const h = await createReferenceHttpHost();
  try {
    const before = h.service.engine.view(h.room.id, h.sourceArtifact.sourceTaskId);
    const payload = { text: '补充部署说明，输出 b.md', sourceArtifact: h.sourceArtifact };
    const replies = await Promise.all([
      h.submit({ ...payload, id: 'revision-a' }),
      h.submit({ ...payload, id: kind === 'same' ? 'revision-a' : 'revision-b' }),
    ]);
    if (kind === 'same') {
      assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
      assert.deepEqual(replies.map(reply => reply.data.taskId), ['task:revision-a', 'task:revision-a']);
      assert.equal(replies.filter(reply => reply.data.duplicate).length, 1);
    } else {
      assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
      assert.equal(replies.find(reply => reply.status === 409)?.data.code, 'ROOM_BUSY');
    }
    assert.equal(h.service.snapshot(h.room.id).tasks.length, 2);
    assert.deepEqual(h.service.engine.view(h.room.id, h.sourceArtifact.sourceTaskId), before);
  } finally { await h.close(); }
}
