import assert from 'node:assert/strict';
import { LocalFixture } from './local-tools-fixture.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkFailure, WorkRunner } from '../src/runner.js';
import { modelResponse } from './model-regeneration-fixture.js';
import type { WebTools } from '../src/web-tools.js';

const webAction = { type: 'web_fetch', url: 'https://source.fixture.example/doc-1' };
const alternative = { type: 'runCli', executable: 'node', args: ['-e', 'console.log("T2: target document content")'] };
const successfulAnswer = { type: 'answer', text: '已通过T2取得目标文档正文', status: 'success' };
const privateMarker = 'sensitive-provider-body-token';
export type RecoveryCase = 'fallback' | 'private' | 'limit' | 'cli' | 'no-alternative' | 'fatal-policy' | 'uncertain';

/** Real runner/SQLite/process boundary; model and Web errors are controlled, no OS-isolation claim. */
export async function webRecoveryAcceptance(kind: RecoveryCase, role = '并行成员') {
  const f = await LocalFixture.create(role === '负责人' || kind === 'uncertain' ? '方案师' : '后台讨论', true);
  let webCalls = 0;
  const work = f.h.engine.pending(f.h.room, f.h.task).find(item => item.kind === (role === '负责人' || kind === 'uncertain' ? 'owner' : 'assistance'))!;
  assert(work);
  const initialUsage = f.h.context().usage.ordinary;
  if (kind === 'limit') f.replies.push(webAction, webAction, webAction, alternative);
  else if (kind === 'cli') f.replies.push({ type: 'runCli', executable: 'node', args: ['-e', 'console.error("T1: unsupported");process.exit(2)'] }, alternative, successfulAnswer);
  else if (kind === 'no-alternative') f.replies.push(webAction, { type: 'answer', text: '没有其他获准的工具，未能取得目标资料', status: 'failed' });
  else f.replies.push(webAction, alternative, successfulAnswer);
  const web: WebTools = {
    search: async () => { throw new Error('Unexpected search'); },
    fetch: async () => {
      webCalls++;
      if (kind === 'fatal-policy') throw new WorkFailure('WEB_TOOLS_NOT_ALLOWED');
      if (kind === 'uncertain') throw new WorkFailure('web_fetch_unsupported_resource', false, true);
      throw new WorkFailure(kind === 'private' ? `web_fetch_conversion_failed (HTTP 502) ${privateMarker}` : 'web_fetch_unsupported_resource');
    },
  };
  const adapter = new OpenAICompatibleAdapter(f.h.config, { clock: () => f.h.now, transport: async (_url, init) => {
    f.requests.push(JSON.parse(String(init?.body)));
    assert(f.replies.length, 'Controlled responses exhausted');
    return modelResponse(f.replies.shift());
  } });
  try {
    const runner = new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, web, f.runtime);
    assert(await runner.runOne(f.h.room, f.h.task, work.id));
    const context = f.h.context(), settled = context.intents.find(item => item.id === work.id)!;
    const facts = settled.toolRecovery?.failures ?? [];
    const receipts = settled.localOperations ?? [];
    const snapshot = { modelRequests: f.requests.length, webCalls, cliCalls: f.backend.calls.length,
      failures: facts, workId: work.id, status: settled.status, ordinaryUsed: context.usage.ordinary - initialUsage,
      retries: context.usage.retries, phase: f.h.view().phase, pending: f.h.engine.pending(f.h.room, f.h.task).map(item => item.kind) };
    if (kind === 'fallback' || kind === 'private' || kind === 'cli') {
      assert.equal(snapshot.modelRequests, 3); assert.equal(snapshot.cliCalls, kind === 'cli' ? 2 : 1);
      assert.equal(snapshot.status, 'done'); assert.equal(context.intents.filter(item => item.id === work.id).length, 1);
      assert(!context.trace.some(item => item.event === 'WORK_FAILED' && item.detail.includes(work.id)));
      assert.equal(snapshot.ordinaryUsed, 5); assert.equal(snapshot.retries, 0);
      assert.equal(receipts.at(-1)?.result?.data.stdout, 'T2: target document content\n');
      assert.equal(facts.length, kind === 'cli' ? 0 : 1);
      assert(f.requests[1]!.messages.some(message => message.role === 'user' && message.content.includes('"ok":false')));
      if (kind === 'cli') assert.deepEqual(receipts.map(receipt => receipt.result?.data.exitCode), [2, 0]);
      else {
        assert.equal(facts[0]!.code, kind === 'private' ? 'WEB_TOOL_CONVERSION_FAILED' : 'WEB_TOOL_UNSUPPORTED_RESOURCE');
        assert(f.requests[1]!.messages.some(message => message.role === 'user' && message.content.includes('"acquired":false')));
      }
      assert(!JSON.stringify({ context, requests: f.requests }).includes(privateMarker));
      if (role !== '负责人') assert.equal(context.discussion!.results.find(result => result.target === work.target)?.status, 'success');
      else assert.equal(context.candidate?.text, successfulAnswer.text);
    } else if (kind === 'limit') {
      assert.equal(snapshot.modelRequests, 3); assert.equal(snapshot.webCalls, 3); assert.equal(snapshot.cliCalls, 0);
      assert.equal(facts.length, 2); assert.equal(f.replies.length, 1);
      assert(context.discussion!.results.some(result => result.status === 'failed' && result.answer.includes('TOOL_RECOVERY_EXHAUSTED')));
    } else if (kind === 'no-alternative') {
      assert.equal(snapshot.modelRequests, 2); assert.equal(snapshot.cliCalls, 0); assert.equal(facts.length, 1);
      assert.equal(context.discussion!.results[0]!.status, 'failed');
      assert(context.discussion!.results[0]!.answer.includes('没有其他获准'));
    } else {
      assert.equal(snapshot.modelRequests, 1); assert.equal(snapshot.cliCalls, 0); assert.equal(facts.length, 0);
      if (kind === 'uncertain') assert.equal(settled.status, 'uncertain');
    }
    return snapshot;
  } finally { await f.close(); }
}

export async function webRecoveryResumeAcceptance() {
  const f = await LocalFixture.create('方案师', true);
  let calls = 0, webCalls = 0;
  f.replies.push(webAction);
  const adapter = new OpenAICompatibleAdapter(f.h.config, { clock: () => f.h.now, transport: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); f.requests.push(request); calls++;
    if (calls === 2) throw new WorkFailure('controlled transient model interruption', true);
    return modelResponse(f.replies.shift());
  } });
  const web: WebTools = { search: async () => { throw new Error('Unexpected search'); },
    fetch: async () => { webCalls++; throw new WorkFailure('web_fetch_unsupported_resource'); } };
  try {
    const first = f.h.engine.pending(f.h.room, f.h.task).find(work => work.kind === 'owner')!;
    assert(await new WorkRunner(f.h.engine, adapter, () => f.h.now, undefined, web, f.runtime).runOne(f.h.room, f.h.task, first.id));
    const interrupted = f.h.context().intents.find(work => work.id === first.id)!;
    assert.equal(interrupted.status, 'pending');
    const saved = structuredClone(interrupted.toolRecovery);
    assert.equal(saved?.failures.length, 1);
    f.h.reopen(); f.replies.push(alternative, successfulAnswer);
    const resumed = new OpenAICompatibleAdapter(f.h.config, { clock: () => f.h.now, transport: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof f.requests[number]; f.requests.push(request);
      const context = request.messages.filter(message => message.role === 'user').map(message => {
        try { return JSON.parse(message.content) as { workId?: string; toolRecovery?: unknown }; } catch { return undefined; }
      }).find(message => message?.workId === first.id);
      assert.deepEqual(context?.toolRecovery, saved, 'Resumed model must see the already saved failure facts');
      return modelResponse(f.replies.shift());
    } });
    assert(await new WorkRunner(f.h.engine, resumed, () => f.h.now, undefined, web, f.runtime).runOne(f.h.room, f.h.task, first.id));
    const work = f.h.context().intents.find(work => work.id === first.id)!;
    assert.equal(work.attempt, 2); assert.equal(webCalls, 1); assert.equal(f.backend.calls.length, 1);
    assert.deepEqual(work.toolRecovery, saved); assert.equal(f.h.context().candidate?.text, successfulAnswer.text);
    return { failures: work.toolRecovery!.failures.length, attempts: work.attempt, webCalls, cliCalls: f.backend.calls.length };
  } finally { await f.close(); }
}
