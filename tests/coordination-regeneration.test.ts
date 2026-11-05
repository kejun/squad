import { afterEach, describe, expect, it } from 'vitest';
import { CoordinationFixture, CoordinationWebFixture, assertRepairWait, assistDecision, decisionOutput, realHumanQuestion } from './coordination-regeneration-fixture.js';

const opened: CoordinationFixture[] = [];
let web: CoordinationWebFixture | undefined;
function fixture(owner = 'A', limits = {}, sqlite = false, blocked = true) {
  const created = new CoordinationFixture(owner, limits, sqlite, blocked); opened.push(created); return created;
}
afterEach(async () => { await web?.close(); web = undefined; for (const f of opened.splice(0).reverse()) f.close(); });

describe('coordination decision regeneration through the real execution engine', () => {
  it.each([
    ['A', 'A', 'continue', '无', 'running'], ['B', 'B', 'continue', '无', 'running'],
    ['B', 'B', 'assist', 'A', 'waitingAssistance'], ['A', '不存在的成员', 'assist', 'B', 'waitingAssistance'],
  ])('[BT_M23] repairs invalid assist target %s/%s into %s/%s before application', async (owner, invalid, action, target, phase) => {
    const f = fixture(owner); f.invalidThenCorrected(invalid, action, target);

    await f.run();

    expect(f.h.view().phase).toBe(phase); expect(f.context.owner).toBe(owner);
    expect(f.requests).toHaveLength(2); expect(f.repairs).toHaveLength(1);
    expect(f.context.usage.retries).toBe(1); expect(f.context.usage.ordinary).toBe(2);
    expect(f.context.trace.filter(trace => trace.event === 'COORDINATION_DECISION')).toHaveLength(1);
    expect(f.context.assists.map(assist => assist.target)).toEqual(action === 'assist' ? [target] : []);
    expect(f.requestContexts.map(context => context.owner)).toEqual([owner, owner]);
    expect(JSON.stringify(f.requests[0]!.messages)).toMatch(/assist.*owner|owner.*assist/isu);
    const feedback = f.requests[1]!.messages.at(-1)!.content;
    expect(feedback).toContain('invalid_decision'); expect(feedback).toContain('context.owner');
    expect(feedback).toMatch(/configured/iu);
  });

  it('[BT_M24] allows the original default member to assist after ownership moved to B', async () => {
    const f = fixture('B'); f.repair.fallback = decisionOutput(assistDecision('A'));

    await f.run();

    expect(f.h.view().phase).toBe('waitingAssistance'); expect(f.context.owner).toBe('B');
    expect(f.context.assists[0]!.target).toBe('A'); expect(f.requests).toHaveLength(1);
    expect(f.repairs).toHaveLength(0); expect(f.context.usage.retries).toBe(0);
    expect(f.requestContexts[0]!.owner).toBe('B');
  });

  it.each([
    ['重试额度', { retries: 0 }], ['普通额度', { ordinary: 1 }],
  ])('[BT_M25] explains a blocked correction without requesting beyond %s', async (_budget, limits) => {
    const f = fixture('A', limits); f.continueInvalid();

    await f.run();

    expect(f.h.view().phase).toBe('waitingHuman'); assertRepairWait(f.context.reason);
    expect(f.requests).toHaveLength(1); expect(f.repairs).toHaveLength(0);
    expect(f.context.usage.ordinary).toBe(1); expect(f.context.usage.retries).toBe(0);
    expect(f.context.assists).toEqual([]);
    expect(f.context.messages.some(message => message.author === 'facilitator' && message.kind === 'notice' && message.text.includes('修正'))).toBe(true);
  });

  it('[BT_M26] persists a rejected current self-assist reason after a subsequent successful activity receipt', () => {
    const f = fixture(); f.claim();

    const result = f.sendSelfDecision(); const reason = f.context.reason, messages = f.context.messages;
    const activity = f.h.event({ type: 'ACTIVITY', text: '等待人工前保留诊断' });

    expect(result.code).toBe('SELF_DEPENDENCY'); expect(result.ok).toBe(false);
    expect(f.h.view().phase).toBe('waitingHuman'); expect(reason).toMatch(/[\u4e00-\u9fff]/u);
    expect(messages.some(message => message.kind === 'notice' && /负责人|本人/u.test(message.text))).toBe(true);
    expect(activity.code).toBe('OK'); expect(f.context.reply.code).toBe('OK');
    expect(f.context.reason).toBe(reason); expect(f.context.messages).toEqual(messages);
  });

  it.each(['非协调状态', '旧目标版本'])('[BT_M27] preserves a real human question when a self-assist decision is %s', stale => {
    const f = fixture(); const work = f.claim();
    f.h.event({ type: 'COORDINATE', workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion },
      decision: { action: 'askUser', question: realHumanQuestion, reason: '必须确认环境' } });
    const messages = f.context.messages;

    f.sendSelfDecision(stale === '旧目标版本');

    expect(f.h.view().phase).toBe('waitingHuman'); expect(f.context.reason).toBe(realHumanQuestion);
    expect(f.context.messages).toEqual(messages);
  });

  it.each(['待领取', '重启恢复'])('[BT_M28] commits the current owner while claiming an old %s coordination intent', async previous => {
    const f = fixture('B', {}, true); await f.prepareLegacyWork(previous === '重启恢复');

    await f.run();

    expect(f.requests).toHaveLength(1); expect(f.requestContexts[0]!.owner).toBe('B');
    expect(f.work.payload.owner).toBe('B'); expect(f.h.view().phase).toBe('waitingAssistance');
    expect(f.context.assists[0]!.target).toBe('A'); expect(f.context.usage.retries).toBe(0);
  });

  it('[BT_M29] projects a helpful coordination failure message and saved repairs through WebService', async () => {
    web = await CoordinationWebFixture.create();

    await web.run();

    const snapshot = web.snapshot, task = snapshot.tasks[0]!;
    expect(task.phase).toBe('waitingHuman'); assertRepairWait(task.reason);
    expect(web.requests).toHaveLength(4); // One blocked owner plus three bounded facilitator requests.
    expect(snapshot.messages.some(message => message.author === 'facilitator' && /修正/u.test(message.text) && /请/u.test(message.text))).toBe(true);
    expect(snapshot.events.filter(event => event.title === '模型输出格式不合规，重新生成')).toHaveLength(2);
    expect(web.service.engine.view(web.room, web.task)!.context.usage.retries).toBe(2);
  });
});
