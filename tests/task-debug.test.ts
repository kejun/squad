import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createActor } from 'xstate';
import { createInspector } from '@statelyai/inspect';
import { debugEventTemplate, debugFrame, debugInput, stateTransitions, taskGraph, TaskSandbox, type DebugFeed, type DebugFrame } from '../src/task-debug.js';
import { initialTask, persistTask, stepTask, taskMachine } from '../src/task.machine.js';
import { TeamEngine } from '../src/engine.js';
import { MemoryStore, SqliteStore } from '../src/store.js';
import { DebugJournal } from '../src/web/debug-journal.js';
import { Workspace } from '../web/src/App.js';
import { debugHost, sandboxBoundary } from './task-debug-fixture.js';
import { DebugUIFixture } from './task-debug-ui-fixture.js';
import { mergeDebugFeed } from '../web/src/use-debug-feed.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('browser state-machine debug', () => {
  it('[BT_V01] hides the entry and rejects snapshot reads by default', async () => {
    const host = await debugHost(false); cleanup.push(host.close);
    expect(await (await fetch(host.url + '/api/debug')).json()).toEqual({ enabled: false });
    expect((await fetch(host.url + host.route)).status).toBe(404);
    const workspace = { rooms: [], roomId: null, snapshot: null, connected: true, error: '', setError: () => {}, chooseRoom: () => {},
      createRoom: async () => '', refreshRooms: async () => [] };
    expect(renderToStaticMarkup(createElement(Workspace, { workspace }))).not.toContain('打开状态机调试');
    expect(renderToStaticMarkup(createElement(Workspace, { workspace, debugEnabled: true }))).toContain('打开状态机调试');
  });
  it('[BT_V02] derives all states, guard branches and global events from the real machine', () => {
    const graph = taskGraph();
    expect(graph.states).toEqual(Object.keys(taskMachine.config.states!));
    expect(graph.states).toContain('interpreting');
    expect(graph.transitions).toContainEqual(expect.objectContaining({ source: '*', event: 'STOP', target: 'stopping', guards: ['valid'], actions: ['apply'] }));
    expect(stateTransitions(graph, 'stopping').filter(t => t.event === 'STOP')).toHaveLength(1);
    expect(stateTransitions(graph, 'stopping').find(t => t.event === 'STOP')?.guards).toEqual([]);
  });
  it('[BT_V03] executes the real pure conversion and retains context updates without an executor', () => {
    const sandbox = new TaskSandbox(), before = sandbox.snapshot;
    const helped = sandbox.send(JSON.stringify(debugEventTemplate(before, 'HELP')));
    expect(helped.value).toBe('waitingAssistance');
    const event = sandbox.history.at(-1)!.event;
    expect(persistTask(helped)).toEqual(persistTask(stepTask(before, event as Parameters<typeof stepTask>[1])));
    sandbox.send(JSON.stringify(debugEventTemplate(helped, 'HELP_RESULT')));
    expect(sandbox.snapshot.value).toBe('running');
    expect(sandbox.snapshot.context.assists[0]?.consumed).toBe(true);
  });
  it('[BT_V02] registers an actual machine definition with Inspector without running a shadow actor', () => {
    const sent: { type: string; definition?: string }[] = [];
    const inspector = createInspector({ send: event => sent.push(event) }, { autoStart: false });
    const snapshot = initialTask(debugInput());
    const metadata = createActor(taskMachine, { snapshot, input: debugInput(), id: 'metadata-only' });
    inspector.actor(metadata, { status: 'active', value: snapshot.value, context: snapshot.context });
    const registration = sent.find(event => event.type === '@xstate.actor')!;
    const definition = JSON.parse(registration.definition!);
    expect(Object.keys(definition.states).sort()).toEqual(taskGraph().states.sort());
    expect(definition.initial).toBe('running'); expect(definition.on.STOP.target).toBe('.stopping');
    const next = stepTask(snapshot, { type: 'STOP', id: 'stop', at: 1 });
    inspector.snapshot(metadata, { status: 'active', value: next.value, context: next.context });
    expect(next.value).toBe('ended'); expect(metadata.getSnapshot().value).toBe('running');
    inspector.stop();
  });
  it.each([['向自己求助', 'SELF_DEPENDENCY'], ['旧轮次结果', 'STALE_FENCE'], ['额度耗尽', 'BUDGET_EXHAUSTED'], ['停止后继续', 'running']])(
    '[BT_V04] preserves %s -> %s', (scenario, code) => expect(sandboxBoundary(new TaskSandbox(), scenario!)).toBe(code));
  it('[BT_V03] templates settle claimed work and charge the real budgets', () => {
    const sandbox = new TaskSandbox();
    const send = (type: string) => sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, type)));
    send('CLAIM'); expect(sandbox.snapshot.context.usage.ordinary).toBe(1);
    send('HELP'); send('CLAIM'); expect(sandbox.snapshot.context.usage.ordinary).toBe(2);
    send('HELP_RESULT'); expect(sandbox.snapshot.value).toBe('running');
    expect(sandbox.snapshot.context.intents.some(work => work.kind === 'assistance' && work.status === 'inflight')).toBe(false);
  });
  it('[BT_V05] preserves state on malformed input, branches from history and resets its seed', () => {
    const sandbox = new TaskSandbox(), initial = persistTask(sandbox.snapshot);
    expect(() => sandbox.send('{')).toThrow('JSON');
    expect(() => sandbox.send('{"type":"HELP"}')).toThrow();
    expect(() => sandbox.send('{"type":"STOP","at":-1}')).toThrow();
    expect(sandbox.history).toHaveLength(1); expect(persistTask(sandbox.snapshot)).toEqual(initial);
    sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, 'HELP'))); sandbox.send('{"type":"STOP"}');
    sandbox.select(0); sandbox.send('{"type":"WAIT_USER","question":"选择下一步"}');
    expect(sandbox.history).toHaveLength(2); expect(sandbox.snapshot.value).toBe('waitingHuman');
    sandbox.reset(); expect(persistTask(sandbox.snapshot)).toEqual(initial);
  });
  it('[BT_V06] never publishes a rolled-back transition and observer errors do not poison commits', () => {
    const config = debugInput().config, store = new MemoryStore(), observed: DebugFrame[] = [];
    const engine = new TeamEngine(store, config, () => 0, (_room, frame) => observed.push(frame));
    engine.submit('room', { id: 'one', text: '形成方案' });
    const before = store.read('room'), count = observed.length;
    store.failNextCommit = true;
    expect(() => engine.send('room', 'task:one', { type: 'STOP', id: 'stop', at: 1 })).toThrow();
    expect(store.read('room')).toEqual(before); expect(observed).toHaveLength(count);
    const next = new TeamEngine(store, config, () => 2, () => { throw new Error('debug unavailable'); });
    expect(next.send('room', 'task:one', { type: 'STOP', id: 'stop-again', at: 2 }).ok).toBe(true);
    expect(next.send('room', 'task:one', { type: 'CONTINUE', id: 'resume', at: 3 }).ok).toBe(true);
    expect(next.view('room', 'task:one')?.phase).toBe('running');
  });
  it('[BT_V07] exposes every fast transition once and isolates room/session cursors', async () => {
    const host = await debugHost(); cleanup.push(host.close);
    const engine = host.service.engine;
    const help = { type: 'HELP' as const, id: 'help', at: 1, requestId: 'H1', caller: 'A', target: 'B', question: '核查', expected: '依据' };
    engine.send(host.room.id, host.taskId, help);
    engine.send(host.room.id, host.taskId, { type: 'HELP_RESULT', id: 'result', at: 2, requestId: 'H1', resultId: 'R1', status: 'success', answer: '有依据' });
    engine.send(host.room.id, host.taskId, help);
    const feed = await (await fetch(host.url + host.route)).json() as DebugFeed;
    expect(feed.records.map(r => r.event.type)).toEqual(['@init', 'HELP', 'HELP_RESULT']);
    expect(feed.records.map(r => r.phase)).toEqual(['running', 'waitingAssistance', 'running']);
    expect(feed.current?.taskId).toBe(host.taskId);
    const second = host.service.createRoom('另一群');
    expect(host.service.debugSnapshot(second.id).records).toHaveLength(0);
    expect(host.service.debugSnapshot(host.room.id, feed.cursor, feed.sessionId).records).toHaveLength(0);
    expect(host.service.debugSnapshot(host.room.id, 0, 'previous-process').truncated).toBe(true);
    expect((await fetch(host.url + host.route + '?after=bad')).status).toBe(400);
    expect((await fetch(host.url + host.route + '?task=missing')).status).toBe(404);
    const journal = new DebugJournal(2);
    const frame = debugFrame(initialTask(debugInput()), { type: '@init', id: 'init', at: 0 }, null);
    for (let index = 0; index < 4; index++) journal.append('room', frame);
    expect(journal.read('room', 0).truncated).toBe(true); expect(journal.read('room').records).toHaveLength(2);
    expect(journal.read('room', 4).records).toHaveLength(0);
    const byteBounded = new DebugJournal(200, 1); byteBounded.append('room', frame);
    expect(byteBounded.read('room').records).toHaveLength(0); expect(byteBounded.read('room').truncated).toBe(true);
  });
  it('[BT_V08] copies a real persisted snapshot into an isolated sandbox and disallows arbitrary HTTP events', async () => {
    const host = await debugHost(); cleanup.push(host.close);
    const before = host.service.engine.view(host.room.id, host.taskId);
    const feed = host.service.debugSnapshot(host.room.id), calls = host.externalCalls;
    const sandbox = new TaskSandbox(feed.current!.snapshot); sandbox.send('{"type":"STOP"}');
    expect(sandbox.snapshot.value).toBe('ended');
    expect(host.service.engine.view(host.room.id, host.taskId)).toEqual(before);
    expect(host.externalCalls).toBe(calls);
    expect((await fetch(host.url + host.route, { method: 'POST', body: '{"type":"STOP"}' })).status).toBe(405);
    expect(host.service.engine.view(host.room.id, host.taskId)).toEqual(before);
  });
  it('[BT_V06] publishes all transitions of a multi-step command only after its final commit', () => {
    const store = new MemoryStore(), config = debugInput().config, observed: DebugFrame[] = [];
    config.limits.ordinary = 0;
    let engine: TeamEngine;
    engine = new TeamEngine(store, config, () => 0, (_room, frame) => {
      if (frame.event.type !== '@init') expect(engine.view('room', 'task:budget')!.phase).toBe('ended');
      observed.push(frame);
    });
    engine.submit('room', { id: 'budget', text: '形成方案' });
    const work = engine.pending('room', 'task:budget')[0]!;
    engine.send('room', 'task:budget', { type: 'CLAIM', id: 'claim', at: 1, intentId: work.id });
    expect(observed.map(frame => frame.event.type)).toEqual(['@init', 'CLAIM', 'EXHAUSTED']);
    expect(observed.at(-1)!.phase).toBe('ended');
  });
  it('[BT_V06] keeps SQLite rollback out of the committed observation log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'squad-debug-commit-'));
    const store = new SqliteStore(join(directory, 'team.sqlite')), frames: DebugFrame[] = [];
    try {
      const engine = new TeamEngine(store, debugInput().config, () => 0, (_room, frame) => frames.push(frame));
      engine.submit('sqlite', { id: 'one', text: '形成方案' });
      const before = store.read('sqlite'); store.failNextCommit = true;
      expect(() => engine.send('sqlite', 'task:one', { type: 'STOP', id: 'stop', at: 1 })).toThrow('Injected commit failure');
      expect(store.read('sqlite')).toEqual(before); expect(frames.map(frame => frame.event.type)).toEqual(['@init']);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('[BT_V07] bounds browser history and clears old sessions while retaining a current baseline', () => {
    const frame = debugFrame(initialTask(debugInput()), { type: '@init', id: 'init', at: 0 }, null);
    const record = { ...frame, roomId: 'room', taskId: 'sandbox', sequence: 1 };
    const feed: DebugFeed = { sessionId: 'one', cursor: 1, truncated: false, tasks: [], current: { taskId: 'sandbox', snapshot: frame.snapshot }, records: [record] };
    const next = mergeDebugFeed(feed, { ...feed, sessionId: 'two', records: [] });
    expect(next.records).toHaveLength(0); expect(next.current).toEqual(feed.current); expect(next.truncated).toBe(true);
    const huge = { ...record, snapshot: { detail: '字'.repeat(2 * 1024 * 1024) } };
    const trimmed = mergeDebugFeed(null, { ...feed, records: [huge] });
    expect(trimmed.records).toHaveLength(0); expect(trimmed.current).toEqual(feed.current); expect(trimmed.truncated).toBe(true);
  });
  it('[BT_V09] drives the browser panel controls and restores history without any requests', async () => {
    const ui = new DebugUIFixture(); cleanup.push(() => ui.close()); await ui.open();
    expect(ui.phase).toBe('running'); await ui.sendHelp(); expect(ui.phase).toBe('waitingAssistance');
    expect(document.querySelector('[aria-label="查看状态 waitingAssistance"]')?.getAttribute('data-active')).toBe('true');
    expect(document.querySelector('[aria-label="任务上下文"]')?.textContent).toContain('核对恢复风险');
    await ui.click('0. @initrunning'); expect(ui.phase).toBe('running');
    await ui.click('重置'); expect(ui.phase).toBe('running'); expect(document.querySelector('[role="alert"]')).toBeNull();
    await ui.escape(); expect(ui.closed).toBe(1); expect(ui.requests).toHaveLength(0);
  });
  it('[BT_V09] keeps the context disclosures reachable when wrapping keyboard focus', async () => {
    const ui = new DebugUIFixture(); cleanup.push(() => ui.close()); await ui.open();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭状态机调试');
    await ui.shiftTab(); expect(document.activeElement?.tagName).toBe('SUMMARY');
    expect(document.activeElement?.textContent).toBe('context');
  });
});

