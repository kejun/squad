import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { MemoryStore, SqliteStore, TeamEngine, type Store, type TaskContext, type TeamConfig } from '../src/index.js';
import { configuration, passFixtureCheck } from './helpers.js';

const original = '# 原方案\n\n保留事务与版本隔离。\n\n原文最后一行。';
const cleanup: (() => void)[] = [];
export function cleanupReferenceFixtures() { cleanup.splice(0).reverse().forEach(fn => fn()); }
export function database() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-reference-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const store = new SqliteStore(path); cleanup.push(() => store.close());
  return { store, path };
}
export function publish(engine: TeamEngine, id = 'source', name = 'a.md', content = original, room = 'r', owner = 'A', at = 0) {
  const taskId = engine.submit(room, { id, text: '编写方案', mentions: [owner] }).taskId!;
  assert.equal(engine.send(room, taskId, { type: 'ARTIFACT', id: `${id}:artifact`, at: at + 1,
    artifact: { id: `${id}:document`, name, content } }).ok, true);
  assert.equal(engine.send(room, taskId, { type: 'DELIVER', id: `${id}:delivery`, at: at + 2,
    text: '方案已交付', artifactIds: [`${id}:document`] }).ok, true);
  passFixtureCheck(engine, room, taskId, `${id}:check`, at + 3);
  assert.equal(engine.view(room, taskId)?.context.outcome, 'complete');
  return { sourceTaskId: taskId, artifactId: `${id}:document` };
}
export function setup(store: Store = new MemoryStore(), config = configuration()) {
  const engine = new TeamEngine(store, config, () => 10);
  const sourceArtifact = publish(engine);
  return { engine, store, config, sourceArtifact };
}
export const request = { id: 'revision', text: '修改 a.md，补充部署说明，输出为 b.md' };


export function verifyRevisionIsolation() {
  const { engine, sourceArtifact } = setup();
  const before = engine.view('r', sourceArtifact.sourceTaskId);
  const reply = engine.submit('r', request);
  assert.equal(reply.ok, true); assert.equal(reply.taskId, 'task:revision');
  const c = engine.view('r', reply.taskId)!.context;
  assert.equal(c.sourceArtifact?.sourceTaskId, sourceArtifact.sourceTaskId);
  assert.equal(c.sourceArtifact?.artifactId, sourceArtifact.artifactId);
  assert.equal(c.sourceArtifact?.content, original);
  assert.equal(c.sourceArtifact?.contentHash, createHash('sha256').update(original).digest('hex'));
  assert.equal(c.owner, 'A'); assert(c.goal.requiredArtifacts >= 1);
  assert.deepEqual(c.artifacts, []);
  assert.equal(c.history?.artifacts.some(a => a.id === sourceArtifact.artifactId && a.taskId === sourceArtifact.sourceTaskId), false);
  assert.equal(engine.send('r', reply.taskId!, { type: 'DELIVER', id: 'revised-delivery', at: 11,
    text: '已补充部署说明', artifactIds: [], artifacts: [{ name: 'b.md', content: original + '\n\n## 部署说明\n运行 npm start。' }] }).ok, true);
  assert.equal(engine.view('r', reply.taskId)?.context.outcome, null);
  passFixtureCheck(engine, 'r', reply.taskId!, 'revised-check', 12);
  const revised = engine.view('r', reply.taskId)!.context;
  assert.equal(revised.outcome, 'complete');
  assert.equal(revised.artifacts[0]?.name, 'b.md');
  assert.notEqual(revised.artifacts[0]?.id, sourceArtifact.artifactId);
  assert.notEqual(revised.artifacts[0]?.documentId, before?.context.artifacts[0]?.documentId);
  assert.deepEqual(engine.view('r', sourceArtifact.sourceTaskId), before);
}

export function prepareSourceAmbiguity() {
  const { engine, store } = setup(); publish(engine, 'another', 'a.md', '# 第二份');
  const before = store.read('r'); const reply = engine.submit('r', request);
  assert.equal(reply.ok, false); assert.equal(reply.code, 'AMBIGUOUS_SOURCE_ARTIFACT');
  assert.equal(reply.sourceCandidates?.length, 2);
  assert.equal(reply.sourceCandidates?.[0]?.name, 'a.md');
  assert.equal(reply.sourceCandidates?.[0]?.owner, 'A');
  assert.equal(typeof reply.sourceCandidates?.[0]?.publishedAt, 'number');
  assert(!Object.hasOwn(reply.sourceCandidates![0]!, 'content'));
  assert.deepEqual(store.read('r'), before);
  return { select() {
    const chosen = engine.submit('r', { ...request, id: 'selected', mentions: ['B'],
      sourceArtifact: { sourceTaskId: 'task:source', artifactId: 'source:document' } });
    assert.equal(chosen.ok, true);
    assert.equal(engine.view('r', chosen.taskId)?.context.owner, 'B');
    assert.equal(engine.view('r', chosen.taskId)?.context.sourceArtifact?.content, original);
  } };
}

export function verifySourceAmbiguity() {
  prepareSourceAmbiguity().select();
}

export function verifyReferenceReplay() {
  const { engine, sourceArtifact, store } = setup(); const input = { ...request, sourceArtifact };
  const sourceBefore = engine.view('r', sourceArtifact.sourceTaskId);
  const first = engine.submit('r', input);
  assert.equal(first.ok, true);
  assert.deepEqual(engine.submit('r', input), { ...first, duplicate: true });
  assert.equal(engine.submit('r', { ...input, sourceArtifact: { ...sourceArtifact, artifactId: 'other' } }).code, 'REQUEST_ID_CONFLICT');
  assert.deepEqual(Object.keys(store.read('r').tasks), ['task:source', 'task:revision']);
  assert.deepEqual(engine.view('r', sourceArtifact.sourceTaskId), sourceBefore);
}

export function verifyReferenceRecovery() {
  const db = database(); const { engine, config, sourceArtifact } = setup(db.store);
  assert.equal(engine.submit('r', { ...request, sourceArtifact }).ok, true);
  const saved = engine.view('r', 'task:revision')?.context.sourceArtifact;
  const second = new SqliteStore(db.path); cleanup.push(() => second.close());
  const reopened = new TeamEngine(second, config, () => 11); reopened.recover('r');
  assert.deepEqual(reopened.view('r', 'task:revision')?.context.sourceArtifact, saved);
  assert.equal(reopened.pending('r', 'task:revision').length, 1);
}

export function verifyReferenceRollback(kind: 'memory' | 'sqlite') {
  const store = kind === 'memory' ? new MemoryStore() : database().store;
  const { engine, sourceArtifact, config } = setup(store);
  const before = store.read('r'); store.failNextCommit = true;
  assert.throws(() => engine.submit('r', { ...request, sourceArtifact }), /Injected commit failure/);
  assert.deepEqual(store.read('r'), before);
  const reopened = new TeamEngine(store, config, () => 10);
  assert.equal(reopened.submit('r', { ...request, sourceArtifact }).ok, true);
  assert.equal(Object.keys(store.read('r').tasks).length, 2);
}

function changeSource(store: Store, update: (c: TaskContext) => void) {
  store.transact('r', tx => {
    const record = tx.room.tasks['task:source'] as { snapshot: { context: TaskContext } };
    update(record.snapshot.context);
  });
}

export function verifySourceRejections(kind: string) {
  const { engine: originalEngine, store, config, sourceArtifact } = setup();
  let engine = originalEngine;
  let chosen = sourceArtifact;
  let expected = 'SOURCE_ARTIFACT_UNAVAILABLE';
  switch (kind) {
    case '缺失': chosen = { sourceTaskId: 'missing', artifactId: 'missing' }; break;
    case '跨群': chosen = publish(engine, 'private', 'private.md', '私密', 'secret'); break;
    case '草稿': changeSource(store, c => { c.outcome = null; delete c.publishedDelivery; }); break;
    case '部分完成': changeSource(store, c => { c.outcome = 'partial'; }); break;
    case '已被新发布取代': changeSource(store, c => { c.publishedDelivery = { goalVersion: 2, artifactIds: ['new-document'], at: 8 }; }); break;
    case '超过32KiB': changeSource(store, c => { c.artifacts[0]!.content = '中'.repeat(11_000); }); expected = 'SOURCE_ARTIFACT_TOO_LARGE'; break;
    case '空正文': changeSource(store, c => { c.artifacts[0]!.content = ' '; }); expected = 'SOURCE_ARTIFACT_UNREADABLE'; break;
    case '非Markdown': changeSource(store, c => { c.artifacts[0]!.name = 'a.txt'; }); break;
    case '负责人已移除': {
      config.bots = config.bots.filter(bot => bot.id !== 'A'); config.defaultBot = 'B';
      engine = new TeamEngine(store, config, () => 10); expected = 'SOURCE_OWNER_UNAVAILABLE'; break;
    }
    default: throw new Error(`Unknown source rejection ${kind}`);
  }
  const before = store.read('r');
  const result = engine.submit('r', { ...request, sourceArtifact: chosen });
  assert.equal(result.ok, false); assert.equal(result.code, expected);
  assert.deepEqual(store.read('r'), before);
}

export function verifyReferenceControls(text: string) {
  const { engine } = setup();
  const result = engine.submit('r', { id: 'control', text });
  assert.equal(result.sourceCandidates, undefined);
  assert.equal(engine.view('r', result.taskId)?.context.sourceArtifact, undefined);
}

export function verifyReferenceBusy(kind: string) {
  const { engine, store, sourceArtifact } = setup();
  if (kind === '引用与互斥控制字段同时提交') {
    const before = store.read('r');
    const result = engine.submit('r', { ...request, sourceArtifact, intent: 'continue', replyToTaskId: sourceArtifact.sourceTaskId });
    assert.equal(result.code, 'INVALID_SOURCE_COMMAND'); assert.deepEqual(store.read('r'), before); return;
  }
  engine.submit('r', { id: 'active', text: '另一个任务' });
  if (kind === '等待用户任务') engine.send('r', 'task:active', { type: 'WAIT_USER', id: 'waiting', at: 4, question: '是否继续？' });
  const before = store.read('r');
  assert.equal(engine.submit('r', { ...request, sourceArtifact }).code, 'ROOM_BUSY');
  assert.deepEqual(store.read('r'), before);
}

export function verifySourceBeyondHistory() {
  const { engine, store, sourceArtifact, config } = setup();
  for (let index = 0; index < 25; index++) publish(engine, `later-${index}`, `later-${index}.md`, `# 新资料 ${index}`);
  assert.equal(engine.submit('r', { ...request, sourceArtifact }).ok, true);
  const sourceBefore = engine.view('r', 'task:revision')!.context.sourceArtifact;
  assert.equal(sourceBefore?.content, original);
  engine.submit('r', { id: 'supplement', text: '还要补充安装要求' });
  assert.equal(engine.send('r', 'task:revision', { type: 'STOP', id: 'pause-revision', at: 11 }).ok, true);
  assert.equal(engine.submit('r', { id: 'continue-source', text: '继续', intent: 'continue', replyToTaskId: sourceArtifact.sourceTaskId }).ok, true);
  assert.equal(engine.send('r', sourceArtifact.sourceTaskId, { type: 'ARTIFACT', id: 'source-new-artifact', at: 12,
    artifact: { id: 'source-new-document', name: 'a.md', content: '新发布正文' } }).ok, true);
  assert.equal(engine.send('r', sourceArtifact.sourceTaskId, { type: 'DELIVER', id: 'source-new-delivery', at: 13,
    text: '更新原任务交付', artifactIds: ['source-new-document'] }).ok, true);
  passFixtureCheck(engine, 'r', sourceArtifact.sourceTaskId, 'source-new-check', 14);
  assert.equal(engine.view('r', sourceArtifact.sourceTaskId)?.context.publishedDelivery?.artifactIds.includes(sourceArtifact.artifactId), false);
  assert.equal(engine.submit('r', { ...request, id: 'stale-reference', sourceArtifact }).code, 'SOURCE_ARTIFACT_UNAVAILABLE');
  assert.equal(engine.submit('r', { id: 'continue-revision', text: '继续', intent: 'continue', replyToTaskId: 'task:revision' }).ok, true);
  const reopened = new TeamEngine(store, config, () => 21); reopened.recover('r');
  const c = reopened.view('r', 'task:revision')!.context;
  assert.deepEqual(c.sourceArtifact, sourceBefore);
  assert.equal(c.history?.artifacts.some(a => a.id === sourceArtifact.artifactId && a.taskId === sourceArtifact.sourceTaskId), false);
  assert.equal(reopened.pending('r', 'task:revision')[0]?.payload.sourceArtifact &&
    (reopened.pending('r', 'task:revision')[0]!.payload.sourceArtifact as { content: string }).content, original);
}

export function verifyLegacyPublication() {
  const { engine, store, sourceArtifact } = setup();
  changeSource(store, c => { delete c.publishedDelivery; delete c.artifacts[0]!.documentId; delete c.artifacts[0]!.revision; });
  const old = engine.view('r', sourceArtifact.sourceTaskId);
  assert.equal(engine.submit('r', { ...request, sourceArtifact }).ok, true);
  const source = engine.view('r', 'task:revision')!.context.sourceArtifact;
  assert.equal(source?.documentId, sourceArtifact.artifactId); assert.equal(source?.revision, 1);
  assert.equal(engine.send('r', 'task:revision', { type: 'DELIVER', id: 'revised-delivery', at: 11,
    text: '修订完成', artifactIds: [], artifacts: [{ name: 'b.md', content: original + '\n\n部署说明' }] }).ok, true);
  passFixtureCheck(engine, 'r', 'task:revision', 'revised-check', 12);
  const b = engine.view('r', 'task:revision')!.context.artifacts[0]!;
  const next = engine.submit('r', { id: 'third', text: '修改 b.md，补充后续说明' });
  assert.equal(next.ok, true);
  assert.equal(engine.view('r', next.taskId)?.context.sourceArtifact?.sourceTaskId, 'task:revision');
  assert.equal(engine.view('r', next.taskId)?.context.sourceArtifact?.artifactId, b.id);
  assert.deepEqual(engine.view('r', sourceArtifact.sourceTaskId), old);
}
