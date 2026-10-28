import { afterEach, describe, expect, it } from 'vitest';
import { DiscussionFixture } from './background-discussion-fixture.js';
import { OpenAICompatibleAdapter, TeamEngine, WorkRunner } from '../src/index.js';
const fixtures: DiscussionFixture[] = [];
const setup = (ordinary?: number) => { const fixture = new DiscussionFixture(ordinary); fixtures.push(fixture); return fixture; };
afterEach(() => fixtures.splice(0).forEach(fixture => fixture.close()));

describe('bounded background discussion', () => {
  it.each(['所有人都参与讨论一下', '大家都提提意见', '请大家一起讨论这个方案', 'everyone discuss this'])('[BT_T01] immediately coordinates while A remains inflight: %s', text => {
    const f = setup(); f.invite(text);
    expect(f.pending().map(work => work.kind)).toEqual(['facilitator']);
    expect(f.context().intents.find(work => work.id === f.ownerWork.id)?.status).toBe('inflight');
    expect(f.context().intents.filter(work => work.kind === 'cancel')).toEqual([]);
  });
  it('[BT_T02] skips a busy helper and permits different idle members to be claimed concurrently', async () => {
    const f = setup(); await f.busyB(); f.invite(); await f.one();
    expect(f.pending().map(work => work.target)).toEqual(['builder-1', 'builder-2', 'builder-3']);
    for (const work of f.pending()) expect(f.engine.claim(f.room, f.task, work.id)).not.toBeNull();
    expect(f.context().intents.filter(work => work.status === 'inflight')).toHaveLength(4);
    expect(f.context().discussion?.skipped).toContainEqual({ target: 'B', reason: '正在工作' });
  });
  it('[BT_T02] refuses a primary helper claim when the same member is already discussing', async () => {
    const f = setup(); f.invite(); await f.one();
    const member = f.pending()[0]!; f.engine.claim(f.room, f.task, member.id);
    expect(f.engine.send(f.room, f.task, { type: 'HELP', id: 'owner-needs-B', at: 0, workId: f.ownerWork.id, fence: { epoch: 1, goalVersion: 1 }, caller: 'A', target: 'B', requestId: 'primary-B', question: '另外核查', expected: '资料' }).ok).toBe(true);
    const primary = f.context().intents.find(work => work.kind === 'assistance' && !work.discussionId)!;
    expect(f.engine.claim(f.room, f.task, primary.id)).toBeNull();
    expect(f.context().reply.code).toBe('WORK_BUSY');
    expect(f.pending().some(work => work.id === primary.id)).toBe(false);
  });
  it.each(['owner-first', 'discussion-first'])('[BT_T03] [BT_T04] joins both arrival orders once: %s', async order => {
    const f = setup(); f.invite();
    if (order === 'owner-first') {
      f.draft(); expect(f.pending().some(work => work.kind === 'check' || work.kind === 'owner')).toBe(false);
      expect(f.context().messages.some(message => message.kind === 'final')).toBe(false);
      await f.discuss();
    } else { await f.discuss(); expect(f.pending().some(work => work.kind === 'owner')).toBe(false); f.draft(); }
    f.assertHandoff(); await f.drain();
    expect(f.context().outcome).toBe('complete');
    expect(f.calls.filter(work => work.kind === 'owner')).toHaveLength(1);
    expect(f.calls.filter(work => work.kind === 'discussionSummary')).toHaveLength(1);
    expect(f.calls.filter(work => work.kind === 'check')).toHaveLength(1);
  });
  it.each([['成员', '失败'], ['成员', '超时'], ['安排', '失败'], ['汇总', '失败']])('[BT_T05] continues with truthful partial results after %s %s', async (stage, mode) => {
    const f = setup(); f.invite(); f.failStage = stage; f.failMode = mode; await f.discuss(); f.draft();
    const input = f.pending()[0]!.payload.discussion as { incomplete: string; summary: string };
    expect(input.incomplete).toBeTruthy(); expect(input.summary).toBeTruthy(); await f.drain(); expect(f.context().outcome).toBe('partial');
    if (stage === '成员') expect(f.context().discussion?.results).toHaveLength(4);
  });
  it.each([2, 4, 5, 6])('[BT_T06] retains summary and owner capacity at ordinary limit %s', async limit => {
    const f = setup(limit);
    f.invite(); await f.discuss(); f.draft(); await f.drain();
    expect(f.context().usage.ordinary).toBeLessThanOrEqual(limit);
    expect(f.context().usage.assists).toBeLessThanOrEqual(f.config.limits.assists);
    expect(f.context().outcome).toBe('partial');
    expect(f.context().messages.some(message => /额度|未参与/.test(message.detailText ?? message.text))).toBe(true);
  });
  it('[BT_T07] coalesces invitations and rejects repeated results without duplicating handoff', async () => {
    const f = setup(); f.invite(); const id = f.context().discussion!.id; f.invite(); await f.duplicateResult();
    expect(f.context().discussion?.id).toBe(id);
    expect(f.context().messages.filter(message => message.text === 'B 的唯一意见')).toHaveLength(1);
    await f.discuss(); f.draft(); await f.drain();
    expect(f.calls.filter(work => work.kind === 'facilitator')).toHaveLength(1);
    expect(f.calls.filter(work => work.kind === 'owner')).toHaveLength(1);
  });
  it.each(['stop', 'goal'])('[BT_T08] [BT_T09] isolates old work after %s', async event => {
    const f = setup(); f.invite(); await f.startClaimed();
    if (event === 'stop') f.engine.send(f.room, f.task, { type: 'STOP', id: 'stop', at: 0 }); else f.changeGoal();
    expect(f.engine.send(f.room, f.task, f.repeated!).ok).toBe(false);
    expect(f.context().discussion?.status).toBe('cancelled');
    expect(f.pending().every(work => work.kind === 'cancel')).toBe(true);
    expect(f.context().lateResults).toContainEqual(f.repeated);
  });
  it('[BT_T10] commits a member opinion once across SQLite restart and two recoveries', async () => {
    const f = setup(); f.invite(); f.sqlite(); await f.one(); await f.one();
    f.recover(); await f.drain();
    expect(f.context().outcome).toBe('complete');
    expect(f.context().messages.filter(message => message.author === 'B' && message.kind === 'answer')).toHaveLength(1);
    expect(f.calls.filter(work => work.discussionId && work.target === 'B')).toHaveLength(1);
  });
  it.each(['> 所有人都参与讨论一下', '```\n所有人都参与讨论一下\n```', '大家不要参与讨论', 'everyone do not discuss this'])('[BT_T11] does not authorize quoted or negative invitations: %s', text => {
    const f = setup(); f.invite(text); expect(f.context().discussion).toBeUndefined();
  });
  it('[BT_T13] reports no idle member while an older cancelled round is still settling', async () => {
    const f = setup(); await f.occupyAll(); const before = f.calls.length; f.invite();
    expect(f.context().discussion?.status).toBe('delivered');
    expect(f.context().discussion?.incomplete).toContain('暂无空闲');
    expect(f.context().discussion?.skipped).toHaveLength(4); expect(f.calls).toHaveLength(before);
  });
  it('[BT_T14] pauses and cancels the discussion if a member was removed on recovery', () => {
    const f = setup(); f.invite(); const config = structuredClone(f.config); config.bots = config.bots.filter(bot => bot.id !== 'builder-3');
    f.engine = new TeamEngine(f.store, config, () => 0); f.engine.recover(f.room);
    expect(f.engine.view(f.room, f.task)?.phase).toBe('waitingHuman');
    expect(f.context().discussion?.status).toBe('cancelled');
    expect(f.pending().every(work => work.kind === 'cancel')).toBe(true);
  });
  it('[BT_T12] uses member models and the coordinator summary protocol through controlled HTTP transport', async () => {
    const f = new DiscussionFixture(undefined, true); fixtures.push(f); f.invite();
    const requests: { kind: string; model: string; system: string; context: Record<string, unknown>; tools: unknown }[] = [];
    const adapter = new OpenAICompatibleAdapter(f.config, { clock: () => 0, transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      const match = /You are (\S+), executing (\S+) work/.exec(system)!;
      const work = f.context().intents.find(work => work.target === match[1] && work.kind === match[2] && work.status === 'inflight')!;
      requests.push({ kind: work.kind, model: body.model, system, context: JSON.parse(body.messages[1].content).context, tools: body.tools });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(f.output(work)) } }] });
    } });
    const runner = new WorkRunner(f.engine, adapter, () => 0);
    for (let n = 0; n < 10 && f.context().discussion?.status !== 'ready'; n++) expect(await runner.runOne(f.room, f.task)).toBe(true);
    f.draft();
    for (let n = 0; n < 5; n++) if (!await runner.runOne(f.room, f.task)) break;
    expect(f.context().outcome).toBe('complete');
    const summary = requests.find(request => request.kind === 'discussionSummary')!;
    expect(summary.model).toBe('coordinator-model'); expect(summary.tools).toBeUndefined();
    expect(summary.system).toContain('Preserve participant identities');
    expect((summary.context.discussion as { results: unknown[] }).results).toHaveLength(4);
    expect(requests.filter(request => request.kind === 'assistance').every(request => request.model === 'member-model')).toBe(true);
    expect(requests).toHaveLength(8);
  });
  it.each(['facilitator', 'assistance', 'discussionSummary'])('[BT_T05] settles invalid %s output without stranding the discussion', async stage => {
    const f = setup(); f.invite();
    const runner = new WorkRunner(f.engine, { execute: async work => work.kind === stage ? ({ type: 'invalid' } as never) : f.output(work) }, () => 0);
    for (let n = 0; n < 12 && f.context().discussion?.status !== 'ready'; n++) expect(await runner.runOne(f.room, f.task)).toBe(true);
    expect(f.context().discussion?.status).toBe('ready'); expect(f.context().discussion?.incomplete).toContain('Invalid worker output');
  });
  it('[BT_T15] gives a blocked owner the discussion rather than scheduling a competing supervisor', async () => {
    const f = setup(); f.invite();
    expect(f.engine.send(f.room, f.task, { type: 'BLOCKED', id: 'blocked', at: 0, workId: f.ownerWork.id, fence: { epoch: 1, goalVersion: 1 }, reason: '需要独立意见核实风险' }).ok).toBe(true);
    expect(f.engine.view(f.room, f.task)?.phase).toBe('running');
    await f.discuss();
    expect(f.pending().map(work => work.kind)).toEqual(['owner']);
    expect(f.pending()[0]!.payload.previousBlocker).toBe('需要独立意见核实风险');
    await f.drain(); expect(f.context().outcome).toBe('complete');
    expect(f.calls.filter(work => work.kind === 'facilitator')).toHaveLength(1);
  });
});
