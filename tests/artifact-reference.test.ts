import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, TeamEngine } from '../src/index.js';
import type { Submission } from '../src/engine.js';
import { configuration } from './helpers.js';
import { database, publish, setup, request, verifyRevisionIsolation, verifySourceAmbiguity, verifyReferenceReplay, verifyReferenceRecovery, cleanupReferenceFixtures, verifySourceRejections, verifySourceBeyondHistory, verifyLegacyPublication } from './artifact-reference-fixture.js';

afterEach(cleanupReferenceFixtures);

describe('fixed published artifact references', () => {
  it('creates a separate task with the exact original while preserving the source task', verifyRevisionIsolation);

  it('uses an explicit current member instead of the original owner', () => {
    const { engine, sourceArtifact } = setup();
    const reply = engine.submit('r', { ...request, text: '@B 修改 a.md，补充部署说明', sourceArtifact });
    expect(reply.ok).toBe(true); expect(engine.view('r', reply.taskId)?.context.owner).toBe('B');
  });

  it('does not choose a replacement when the source owner was removed', () => {
    const { store, sourceArtifact } = setup();
    const config = configuration(); config.bots = config.bots.filter(b => b.id !== 'A'); config.defaultBot = 'B';
    const engine = new TeamEngine(store, config, () => 10);
    expect(engine.submit('r', { ...request, sourceArtifact })).toMatchObject({ ok: false, code: 'SOURCE_OWNER_UNAVAILABLE' });
    expect(engine.submit('r', { ...request, id: 'assigned', sourceArtifact, mentions: ['B'] }).ok).toBe(true);
  });

  it('requests a same-room choice before creating or modifying any task', verifySourceAmbiguity);

  it.each(['running', 'waitingHuman'] as const)('rejects a revision while the room is %s without altering that task', phase => {
    const { engine, sourceArtifact } = setup();
    engine.submit('r', { id: 'active', text: '另一个任务' });
    if (phase === 'waitingHuman') engine.send('r', 'task:active', { type: 'WAIT_USER', id: 'wait', at: 4, question: '是否继续？' });
    const before = engine.view('r', 'task:active');
    expect(engine.submit('r', { ...request, sourceArtifact })).toMatchObject({ ok: false, code: 'ROOM_BUSY' });
    expect(engine.view('r', 'task:active')).toEqual(before);
  });

  it('does not append a direct revision to waitingHuman through an automatic decision marker', () => {
    const { engine } = setup(); engine.submit('r', { id: 'active', text: '另一个任务' });
    engine.send('r', 'task:active', { type: 'WAIT_USER', id: 'wait', at: 4, question: '是否继续？' });
    const before = engine.view('r', 'task:active');
    expect(engine.submit('r', { ...request, intent: 'decision', replyToTaskId: 'task:active' })).toMatchObject({ ok: false, code: 'ROOM_BUSY' });
    expect(engine.view('r', 'task:active')).toEqual(before);
  });

  it.each([
    { intent: 'continue' }, { intent: 'decision' }, { intent: 'supplement' }, { intent: 'retry' },
    { replyToTaskId: 'task:source' }, { retryAssistanceId: 'help' }, { extraOrdinary: 2 }, { text: '停止' }, { text: '继续' },
  ] satisfies Partial<Submission>[])('rejects a structured source combined with control fields: %o', control => {
    const { engine, sourceArtifact } = setup();
    expect(engine.submit('r', { ...request, ...control, sourceArtifact })).toMatchObject({ ok: false, code: 'INVALID_SOURCE_COMMAND' });
  });

  it('keeps a missing ordinary filename on the normal task path', () => {
    const engine = new TeamEngine(new MemoryStore(), configuration());
    const reply = engine.submit('r', request);
    expect(reply.ok).toBe(true); expect(engine.view('r', reply.taskId)?.context.sourceArtifact).toBeUndefined();
  });

  it.each([
    { text: '修改产物 missing.md，补充说明' },
    { sourceArtifact: { sourceTaskId: 'missing', artifactId: 'missing' } },
    { sourceArtifact: { sourceTaskId: 'task:private', artifactId: 'private:document' } },
  ])('rejects missing or cross-room explicit sources: %o', change => {
    const { engine } = setup(); publish(engine, 'private', 'private.md', '机密', 'secret');
    expect(engine.submit('r', { ...request, ...change })).toMatchObject({ ok: false, code: 'SOURCE_ARTIFACT_UNAVAILABLE' });
  });

  it('rejects drafts and failed tasks even when the exact source IDs are known', () => {
    const { engine } = setup(); engine.submit('r', { id: 'draft', text: '尚未完成' });
    engine.send('r', 'task:draft', { type: 'ARTIFACT', id: 'draft-artifact', at: 1,
      artifact: { id: 'draft-document', name: 'draft.md', content: '未发布' } });
    engine.send('r', 'task:draft', { type: 'STOP', id: 'stop-draft', at: 2 });
    expect(engine.submit('r', { ...request, sourceArtifact: { sourceTaskId: 'task:draft', artifactId: 'draft-document' } })).toMatchObject({ ok: false, code: 'SOURCE_ARTIFACT_UNAVAILABLE' });
  });

  it('reports oversized UTF-8 input rather than treating it as a workspace file', () => verifySourceRejections('超过32KiB'));

  it('replays the original receipt and rejects changed reference payloads', verifyReferenceReplay);

  it.each(['memory', 'sqlite'] as const)('rolls back all new task data and receipt in %s after commit failure', kind => {
    const store = kind === 'memory' ? new MemoryStore() : database().store;
    const { engine, sourceArtifact, config } = setup(store);
    const before = store.read('r'); store.failNextCommit = true;
    expect(() => engine.submit('r', { ...request, sourceArtifact })).toThrow('Injected commit failure');
    expect(store.read('r')).toEqual(before);
    const reopened = new TeamEngine(store, config, () => 10);
    expect(reopened.submit('r', { ...request, sourceArtifact })).toMatchObject({ ok: true, taskId: 'task:revision' });
    expect(Object.keys(store.read('r').tasks)).toHaveLength(2);
  });

  it('retains the fixed input across SQLite reopen and recovery', verifyReferenceRecovery);
  it('[BT_A34] retains a source beyond the history window', verifySourceBeyondHistory);
  it('[BT_A39] supports legacy publication and a direct revision chain', verifyLegacyPublication);

});
