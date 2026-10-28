import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStore, OpenAICompatibleAdapter, WorkRunner, validateConfig, resolveModel,
  type InputReference,
} from '../src/index.js';
import { createTeamConfig } from '../team.config.js';
import { Details } from '../web/src/Details.js';
import { phaseLabel } from '../web/src/ui.js';
import { buildDetailDocument } from '../web/src/detail-document.js';
import type { RoomSnapshot } from '../src/web/contracts.js';
import { complexInput, InputIntentFixture, intentConfig, parsedIntent } from './input-intent-fixture.js';

const fixtures: InputIntentFixture[] = [];
const setup = (config = intentConfig(), sqlite = false) => { const f = new InputIntentFixture(config, sqlite); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });

describe('validated input interpretation', () => {
  it.each(['A', 'B', 'builder-1', 'builder-2', 'builder-3'])('[BT_I03] every owner %s receives the same user intent with its own role', async bot => {
    const f = setup(); expect(f.submit(complexInput, { mentions: [bot] }).ok).toBe(true); await f.run(); await f.run();
    const request = f.requests[1]!; expect(request.kind).toBe('owner');
    expect(request.context.inputIntents).toEqual(f.context().inputAnalyses);
    expect(request.messages[0]!.content).toContain(`You are ${bot}`);
    expect(JSON.stringify(request.context.messages)).toContain(complexInput);
  });

  it('[BT_I08] actual parser HTTP is aborted through the persisted cancellation path', async () => {
    const f = setup(); f.submit();
    let announce!: () => void;
    const started = new Promise<void>(resolve => { announce = resolve; });
    let requestSignal: AbortSignal | undefined;
    const adapter = new OpenAICompatibleAdapter(f.config, { clock: () => f.now, transport: async (_url, init) => {
      requestSignal = init!.signal!; announce();
      return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    const runner = new WorkRunner(f.engine, adapter, () => f.now), running = runner.runOne(f.room, f.task);
    await started;
    expect(f.submit('停止', { id: 'stop-parser' }).ok).toBe(true);
    expect(f.context().intents.some(i => i.kind === 'cancel')).toBe(true);
    await runner.runOne(f.room, f.task); await running;
    expect(requestSignal!.aborted).toBe(true); expect(f.view().phase).toBe('ended'); expect(f.context().outcome).toBe('stopped');
    expect(f.context().intents.some(i => i.kind === 'owner')).toBe(false);
  });

  it('[BT_I10] a failed claim commit prevents even the first parser HTTP request', async () => {
    const f = setup(); f.submit(); (f.store as MemoryStore).failNextCommit = true;
    await expect(f.run()).rejects.toThrow('Injected commit failure');
    expect(f.requests).toHaveLength(0); expect(f.work.status).toBe('pending'); expect(f.context().usage.ordinary).toBe(0);
  });

  it('[BT_I10] parser result rollback can be recovered without publishing a partial result', async () => {
    const f = setup(); f.submit(); f.beforeResponse = () => { (f.store as MemoryStore).failNextCommit = true; };
    await expect(f.run()).rejects.toThrow('Injected commit failure');
    expect(f.requests).toHaveLength(1); expect(f.context().inputAnalyses![0]!.spec).toBeUndefined();
    expect(f.work.status).toBe('inflight'); expect(f.context().intents.some(i => i.kind === 'owner')).toBe(false);
    f.beforeResponse = undefined; f.reopen(); await f.run();
    expect(f.context().inputAnalyses![0]!.status).toBe('resolved'); expect(f.context().usage.ordinary).toBe(2);
    expect(f.context().trace.filter(t => t.event === 'INPUT_INTERPRETED')).toHaveLength(1);
  });

  it('[BT_I07] schema repair cannot bypass a depleted ordinary budget', async () => {
    const f = setup(intentConfig({ ordinary: 1, retries: 5 })); f.submit(); f.replies = [{ type: 'interpretation', spec: {} }];
    await f.run(); expect(f.requests).toHaveLength(1); expect(f.context().usage.retries).toBe(0);
    expect(f.view().phase).toBe('waitingHuman'); expect(f.context().reason).toContain('BUDGET_EXHAUSTED');
  });

  it('[BT_I19] explicit continuation after a permanent failure retries interpretation, preserving usage', async () => {
    const f = setup(); f.submit(); f.replies = [new Response('private', { status: 401 })]; await f.run();
    expect(f.view().phase).toBe('waitingHuman');
    expect(f.submit('继续', { id: 'resume-parser' }).ok).toBe(true);
    expect(f.view().phase).toBe('interpreting'); expect(f.engine.pending(f.room, f.task).map(i => i.kind)).toEqual(['interpretation']);
    expect(f.context().usage.ordinary).toBe(1); await f.run(); expect(f.view().phase).toBe('running');
    expect(f.context().usage.ordinary).toBe(2);
  });

  it('[BT_I05] a short clarification answer still uses the model after a failed interpretation', async () => {
    const f = setup(); f.submit(); f.replies = [new Response('private', { status: 401 })]; await f.run();
    expect(f.submit('方案甲', { id: 'short-answer' }).ok).toBe(true); expect(f.view().phase).toBe('interpreting');
    await f.run(); expect(f.context().inputAnalyses!.at(-1)!.spec?.action).toBe('supplement');
    expect(f.context().inputAnalyses![0]!.status).toBe('cancelled'); expect(f.view().phase).toBe('running');
  });

  it('[BT_I04] current artifact and board bodies accompany their reference identities', async () => {
    const f = setup(); f.submit('整理方案');
    f.event({ type: 'ARTIFACT', artifact: { id: 'current-plan', name: 'plan.md', content: '恢复必须保留事务回执。' } });
    f.event({ type: 'BOARD_WRITE', entryId: 'current-evidence', author: 'user', text: 'SQLite事务', kind: 'evidence', sources: ['https://sqlite.org/atomiccommit.html'] });
    f.submit('修改这个方案，必须保留恢复保证', { id: 'current-ref' });
    expect(f.work.payload.artifacts).toEqual(f.context().artifacts); expect(f.work.payload.board).toEqual(f.context().board);
    const refs = (f.work.payload.references as InputReference[]).filter(ref => ref.id === 'current-plan' || ref.id === 'current-evidence');
    expect(refs).toHaveLength(2); f.replies = [{ type: 'interpretation', spec: parsedIntent('supplement', { references: refs }) }];
    await f.run(); expect(f.context().inputAnalyses!.at(-1)!.spec?.references).toEqual(refs);
  });

  it.each(['findSkills', 'web_search', 'help'])('[BT_I12] parser protocol cannot escape into %s', async type => {
    const f = setup(intentConfig({ retries: 0 })); f.submit(); f.replies = [{ type, query: 'escape', target: 'B', question: 'help', expected: 'result' }];
    await f.run(); expect(f.view().phase).toBe('waitingHuman'); expect(f.context().assists).toHaveLength(0);
    expect(f.context().usage.ordinary).toBe(1); expect(f.context().inputAnalyses![0]!.status).toBe('failed');
  });

  it('[BT_I18] host output validation rejects a custom adapter scheduling instead of interpreting', async () => {
    const f = setup(); f.submit();
    const runner = new WorkRunner(f.engine, { execute: async () => ({ type: 'help', requestId: 'unauthorized', target: 'B', question: 'delegate', expected: 'answer' }) }, () => f.now);
    await runner.runOne(f.room, f.task); expect(f.view().phase).toBe('waitingHuman'); expect(f.context().assists).toHaveLength(0);
    expect(f.context().reason).toContain('Invalid worker output');
  });

  it('[BT_I08] the machine rejects an expired result even before the timer runs', () => {
    const f = setup(); f.submit(); const work = f.claim(); f.now = work.deadline!;
    expect(f.result(work).code).toBe('WORK_EXPIRED'); expect(f.view().phase).toBe('waitingHuman');
    expect(f.context().inputAnalyses![0]!.status).toBe('failed'); expect(f.engine.pending(f.room, f.task)).toHaveLength(0);
  });

  it('[BT_I18] an unclaimed or unassociated result cannot move the interpretation phase', () => {
    const f = setup(); f.submit();
    expect(f.event({ type: 'INTERPRETATION_RESULT', inputId: 'input-1', spec: parsedIntent() }).ok).toBe(false);
    expect(f.view().phase).toBe('interpreting'); expect(f.work.status).toBe('pending');
    expect(f.context().inputAnalyses![0]!.status).toBe('pending');
    const work = f.claim(); expect(f.result(work).ok).toBe(true); expect(f.view().phase).toBe('running');
  });

  it.each(['missing constraints', 'extra owner', 'low confidence', 'wrong action', 'invalid references'])('[BT_I06] repairs %s without accepting the invalid result', async problem => {
    const f = setup(); f.submit(); const spec: Record<string, unknown> = { ...parsedIntent() };
    if (problem === 'missing constraints') delete spec.constraints;
    if (problem === 'extra owner') spec.owner = 'B';
    if (problem === 'low confidence') spec.confidence = 0.1;
    if (problem === 'wrong action') spec.action = 'review';
    if (problem === 'invalid references') spec.references = [{ kind: 'artifact', id: 'fake', taskId: f.task }];
    f.replies = [{ type: 'interpretation', spec }]; await f.run();
    expect(f.requests).toHaveLength(2); expect(f.context().usage.retries).toBe(1);
    expect(f.context().inputAnalyses![0]!.spec).toEqual(parsedIntent()); expect(f.context().owner).toBe('A');
    expect(f.requests[1]!.messages.at(-1)!.content).toContain('invalid_input_intent');
  });

  it('[BT_I15] independently configured intent models inherit settings and isolate endpoint credentials', async () => {
    const config = createTeamConfig({ MODEL_BASE_URL: 'https://default.example/v1', MODEL_NAME: 'base', MODEL_API_KEY: 'private',
      FACILITATOR_MODEL_NAME: 'coordinator', INTENT_MODEL_NAME: 'parser', INTENT_MODEL_BASE_URL: 'https://parser.example/v1' });
    expect(resolveModel(config, 'interpretation', 'facilitator')?.service).toMatchObject({ model: 'parser', apiKeyEnv: 'INTENT_MODEL_API_KEY' });
    const f = setup(config); f.submit(); await f.run(); expect(f.requests).toHaveLength(0); expect(f.context().reason).toContain('INTENT_MODEL_API_KEY');
    expect(JSON.stringify(f.context())).not.toContain('private');
    const invalid = intentConfig(); invalid.models!.intent = 'unknown'; expect(() => validateConfig(invalid)).toThrow('Unknown model service');
    expect(() => createTeamConfig({ SQUAD_INTENT_ANALYSIS_ENABLED: 'sometimes' })).toThrow();
  });

  it('[BT_I15] changing the interpretation switch during recovery remains paused', () => {
    const f = setup(); f.submit(); const changed = structuredClone(f.config); changed.inputAnalysis = { enabled: false };
    f.reopen(changed); expect(f.view().phase).toBe('waitingHuman'); expect(f.context().reason).toBe('Input analysis configuration changed');
    expect(f.engine.pending(f.room, f.task)).toHaveLength(0); expect(f.submit('继续', { id: 'blocked-resume' }).code).toBe('INCOMPATIBLE_EXECUTION');
  });

  it('[BT_I13] SQLite retains result deduplication after reopening', () => {
    const f = setup(intentConfig(), true); f.submit(); const work = f.claim(); expect(f.result(work).ok).toBe(true); f.reopen();
    expect(f.result(work).duplicate).toBe(true); expect(f.context().intents.filter(i => i.kind === 'owner' && i.status === 'pending')).toHaveLength(1);
    expect(f.context().usage.ordinary).toBe(1);
  });

  it('[BT_I16] task details display the interpretation entry and export its full data', async () => {
    const f = setup(); await f.parse(); const c = f.context();
    const snapshot: RoomSnapshot = { room: { id: f.room, title: '输入理解', createdAt: f.now },
      agents: c.config.bots.map(bot => ({ ...bot, model: null })), messages: c.messages,
      tasks: [{ id: f.task, goal: c.goal.text, owner: c.owner, phase: 'interpreting', outcome: null, reason: '',
        usage: c.usage, limits: c.config.limits, board: c.board, artifacts: c.artifacts, trace: c.trace, inputAnalyses: c.inputAnalyses! }],
      activeTaskId: f.task, works: [], events: [], modelConfigured: true, serverTime: f.now };
    expect(phaseLabel(snapshot.tasks[0])).toBe('正在理解输入');
    const html = renderToStaticMarkup(createElement(Details, { snapshot, agent: null, onClose: () => {}, connected: true }));
    expect(html).toContain('输入理解'); expect(html).toContain('正在理解输入');
    const document = buildDetailDocument(snapshot, { target: { taskId: f.task } });
    expect(document!.content).toContain(complexInput); expect(document!.content).toContain('Markdown 计划');
  });
});
