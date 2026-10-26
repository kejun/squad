import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryStore, OpenAICompatibleAdapter, SqliteStore, TeamEngine, WorkRunner } from '../src/index.js';
import { Details } from '../web/src/Details.js';
import { conversationHistory } from '../src/conversation.js';
import { configuration, Harness } from './helpers.js';
import { artifactSnapshot, delivery, FULL_REPORT, HELPER_REPORT, HELPER_SUMMARY, helperDelivery, RESULT_SUMMARY } from './artifact-fixture.js';

const stores = new Set<SqliteStore>();
const directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'squad-result-')); directories.push(directory);
  const path = join(directory, 'state.sqlite'), store = new SqliteStore(path); stores.add(store); return { path, store };
}

describe('durable result artifacts and concise messages', () => {
  it('[BT_A01] keeps full candidate and real reports available to the checking model', () => {
    const h = new Harness(), work = h.claim('owner');
    expect(h.engine.send(h.room, h.task, delivery(h, work)).ok).toBe(true);
    expect(h.context().candidate?.text).toBe(FULL_REPORT);
    const report = h.context().artifacts[0]!;
    expect(report).toMatchObject({ name: '恢复方案.md', content: FULL_REPORT, author: 'A', workId: work.id, goalVersion: 1 });
    const checking = h.engine.pending(h.room, h.task).find(item => item.kind === 'check')!;
    expect(checking.payload.candidate).toMatchObject({ text: FULL_REPORT, artifactIds: [report.id] });
    expect(checking.payload.artifacts).toContainEqual(report);
    h.event({ type: 'CHECK_RESULT', resultId: 'check1', passed: true, gaps: [] });
    expect(h.context().messages.find(item => item.kind === 'final')).toMatchObject({ text: RESULT_SUMMARY, detailText: FULL_REPORT, artifactIds: [report.id], workId: work.id });
  });

  it('[BT_A02] gives the original owner the complete helper answer and report', () => {
    const h = new Harness(); h.help(); const work = h.claim('assistance');
    h.engine.send(h.room, h.task, helperDelivery(h, work)); h.engine.flushResults(h.room, h.task);
    expect(h.context().assists[0]?.answer).toBe(HELPER_REPORT);
    const report = h.context().artifacts[0]!;
    expect(report.author).toBe('B');
    expect(h.context().messages.find(message => message.author === 'B')).toMatchObject({ text: HELPER_SUMMARY, detailText: HELPER_REPORT, artifactIds: [report.id] });
    const owner = h.engine.pending(h.room, h.task).find(item => item.kind === 'owner')!;
    expect(owner.target).toBe('A'); expect(owner.payload.answer).toBe(HELPER_REPORT);
    expect(owner.payload.artifacts).toContainEqual(report);
  });

  it.each(['memory', 'sqlite'] as const)('[BT_A03] %s rolls the report and candidate back together on failed commit', kind => {
    const store = kind === 'memory' ? new MemoryStore() : database().store;
    const h = new Harness(configuration(), store), work = h.claim('owner');
    store.failNextCommit = true;
    expect(() => h.engine.send(h.room, h.task, delivery(h, work))).toThrow('Injected commit failure');
    const reopened = new TeamEngine(store, h.config, () => 0);
    expect(reopened.view(h.room, h.task)?.context.artifacts).toEqual([]);
    expect(reopened.view(h.room, h.task)?.context.candidate).toBeNull();
    expect(reopened.timeline(h.room).filter(message => message.kind === 'final')).toEqual([]);
  });

  it('[BT_A04] deduplicates a re-delivered report without creating another check', () => {
    const h = new Harness(), event = delivery(h, h.claim('owner'));
    expect(h.engine.send(h.room, h.task, event).ok).toBe(true);
    expect(h.engine.send(h.room, h.task, event).duplicate).toBe(true);
    expect(h.context().artifacts).toHaveLength(1);
    expect(h.context().intents.filter(work => work.kind === 'check')).toHaveLength(1);
  });

  it.each(['stop', 'newGoal'] as const)('[BT_A05] does not create a report from a %s invalidated worker', cause => {
    const h = new Harness(), event = delivery(h, h.claim('owner'));
    if (cause === 'stop') h.event({ type: 'STOP' });
    else h.event({ type: 'USER_INPUT', text: 'different goal', goal: { ...h.context().goal, text: 'new goal' } });
    expect(h.engine.send(h.room, h.task, event).ok).toBe(false);
    expect(h.context().artifacts).toEqual([]); expect(h.context().candidate).toBeNull();
    expect(h.context().messages.filter(message => message.kind === 'final')).toEqual([]);
  });

  it('[BT_A06] reopens SQLite and resumes one owner using the same saved helper report', () => {
    const db = database(), config = configuration(), h = new Harness(config, db.store);
    h.help(); const helper = h.claim('assistance'); h.engine.send(h.room, h.task, helperDelivery(h, helper));
    const reportId = h.context().artifacts[0]!.id;
    db.store.close(); stores.delete(db.store);
    const reopened = new SqliteStore(db.path); stores.add(reopened);
    const engine = new TeamEngine(reopened, config, () => 0); engine.recover(h.room); engine.recover(h.room);
    const c = engine.view(h.room, h.task)!.context;
    expect(c.artifacts).toHaveLength(1); expect(c.artifacts[0]?.id).toBe(reportId);
    expect(c.messages.filter(message => message.author === 'B')).toHaveLength(1);
    expect(c.messages.find(message => message.author === 'B')).toMatchObject({ text: HELPER_SUMMARY, artifactIds: [reportId] });
    expect(c.consumedResults).toEqual(['helper-result']);
    expect(engine.pending(h.room, h.task).filter(work => work.kind === 'owner')).toHaveLength(1);
  });

  it('[BT_A07] leaves short direct replies as direct messages', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: '可以。', artifactIds: [] });
    h.event({ type: 'CHECK_RESULT', resultId: 'short', passed: true, gaps: [] });
    expect(h.context().artifacts).toEqual([]);
    expect(h.context().messages.find(message => message.kind === 'final')?.text).toBe('可以。');
  });

  it('[BT_A08] preserves an old-protocol long reply as an actual report', () => {
    const h = new Harness(); h.event({ type: 'DELIVER', text: FULL_REPORT, artifactIds: [] });
    h.event({ type: 'CHECK_RESULT', resultId: 'long', passed: true, gaps: [] });
    const result = h.context().messages.find(message => message.kind === 'final')!;
    expect(result.text.length).toBeLessThanOrEqual(300); expect(result.detailText).toBe(FULL_REPORT);
    expect(h.context().artifacts).toHaveLength(1); expect(h.context().artifacts[0]?.content).toBe(FULL_REPORT);
    expect(result.artifactIds).toEqual([h.context().artifacts[0]!.id]);
  });

  it('[BT_A08] also recognizes a short document with many real line breaks', () => {
    const text = Array.from({ length: 13 }, (_, i) => `第${i + 1}条`).join('\n');
    const h = new Harness(); h.event({ type: 'DELIVER', text, artifactIds: [] });
    expect(h.context().artifacts).toHaveLength(1); expect(h.context().artifacts[0]?.content).toBe(text);
  });

  it('[BT_A01] rejects empty artifact drafts before persisting a candidate', async () => {
    const h = new Harness(); const runner = new WorkRunner(h.engine, { async execute() {
      return { type: 'deliver', text: FULL_REPORT, summary: RESULT_SUMMARY, artifactIds: [], artifacts: [{ name: 'empty.md', content: '  ' }] };
    } }, () => 0);
    await runner.runOne(h.room, h.task);
    expect(h.context().artifacts).toEqual([]); expect(h.context().candidate).toBeNull();
    expect(h.view().phase).toBe('waitingHuman');
  });

  it('[BT_A11] accepts report drafts through the real model adapter and does not add another model request', async () => {
    const config = configuration(); config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'test' } } };
    const h = new Harness(config);
    const http = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'deliver', text: FULL_REPORT,
      summary: RESULT_SUMMARY, artifactIds: [], artifacts: [{ name: '恢复方案.md', content: FULL_REPORT }] }) } }] }));
    const adapter = new OpenAICompatibleAdapter(config, { transport: http, env: {}, clock: () => 0 });
    await new WorkRunner(h.engine, adapter, () => 0).runOne(h.room, h.task);
    expect(http).toHaveBeenCalledTimes(1); expect(h.context().usage.ordinary).toBe(1);
    expect(h.context().candidate?.text).toBe(FULL_REPORT); expect(h.context().artifacts[0]?.content).toBe(FULL_REPORT);
    const prompt = JSON.parse(String(http.mock.calls[0]![1]?.body)).messages[0].content;
    expect(prompt).toContain('summary'); expect(prompt).toContain('artifacts');
  });

  it('[BT_A02] carries earlier report bodies to later reviewers instead of only their summaries', async () => {
    const h = new Harness(); h.engine.send(h.room, h.task, delivery(h, h.claim('owner')));
    h.event({ type: 'CHECK_RESULT', resultId: 'seed-check', passed: true, gaps: [] });
    const reviewTask = h.engine.submit(h.room, { id: 'review-report', text: '大家都提提意见' }).taskId!;
    const runner = new WorkRunner(h.engine, { async execute(work) {
      if (work.kind === 'facilitator') return { type: 'decision', decision: { action: 'review', question: '核查已保存的方案', expected: '具体依据', reason: '用户要求全员评审' } };
      if (work.kind === 'assistance') return { type: 'answer', text: HELPER_REPORT, summary: HELPER_SUMMARY, artifacts: [{ name: '核查报告.md', content: HELPER_REPORT }] };
      throw new Error('Unexpected reviewer fixture operation');
    } }, () => 0);
    await runner.runOne(h.room, reviewTask); await runner.runOne(h.room, reviewTask); await runner.runOne(h.room, reviewTask);
    const next = h.engine.pending(h.room, reviewTask).find(work => work.kind === 'assistance')!;
    expect(next.target).toBe('builder-1');
    expect(JSON.stringify(next.payload.artifacts)).toContain('核查报告');
    expect(JSON.stringify(next.payload.artifacts)).toContain('独特尾段');
    expect(JSON.stringify(next.payload.conversation)).toContain('恢复方案');
  });

  it('[BT_A08] counts retained full detail text against the bounded historical context', () => {
    const h = new Harness(); const c = h.context();
    c.messages.push({ id: 'oversized-detail', taskId: c.taskId, kind: 'answer', author: 'A', at: 1,
      text: '短摘要', detailText: '完整资料'.repeat(25_000) });
    const history = conversationHistory([c]);
    expect(history.truncated).toBe(true);
    expect(history.messages.some(message => message.id === 'oversized-detail')).toBe(false);
    const total = history.messages.reduce((size, message) => size + message.text.length + (message.detailText?.length ?? 0), 0)
      + history.artifacts.reduce((size, artifact) => size + artifact.content.length, 0);
    expect(total).toBeLessThanOrEqual(96_000);
    expect(c.messages.at(-1)?.detailText?.length).toBe(100_000);
  });
});

describe('report and result detail navigation', () => {
  it('[BT_A09] previews the historical task report instead of the active task report', () => {
    const html = renderToStaticMarkup(createElement(Details, { snapshot: artifactSnapshot(), agent: null, onClose() {}, connected: true,
      target: { taskId: 'old-task', messageId: 'old-result', artifactId: 'old-report' } }));
    expect(html).toContain('独特尾段：报告全文必须保留。');
    expect(html).toContain('<h2>恢复方案.md</h2>'); expect(html).toContain('aria-label="导出详情"');
    expect(html).not.toContain('不应展示的新任务报告正文');
  });

  it('[BT_A10] shows full detail text, sources and the matching observable tool record', () => {
    const html = renderToStaticMarkup(createElement(Details, { snapshot: artifactSnapshot(), agent: null, onClose() {}, connected: true,
      target: { taskId: 'old-task', messageId: 'old-result' } }));
    for (const value of ['独特尾段：报告全文必须保留。', 'https://example.com/evidence', '读取官方资料', '版本围栏必须保留']) expect(html).toContain(value);
    expect(html).not.toContain('不应展示的新任务报告正文');
  });

  it('[BT_A09] does not substitute the current report when an old report is missing', () => {
    const html = renderToStaticMarkup(createElement(Details, { snapshot: artifactSnapshot(), agent: null, onClose() {}, connected: true,
      target: { taskId: 'missing-task', messageId: 'old-result', artifactId: 'old-report' } }));
    expect(html).not.toContain('独特尾段：报告全文必须保留。'); expect(html).not.toContain('不应展示的新任务报告正文');
  });
});
