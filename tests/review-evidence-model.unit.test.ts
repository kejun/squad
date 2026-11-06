import { describe, expect, it } from 'vitest';
import { Harness, candidateJudgments } from './helpers.js';
function reviewed(status: 'success' | 'partial' = 'success') {
  const h = new Harness();
  h.event({ type: 'HELP', caller: 'A', requestId: 'review-request', target: 'B', question: '完整候选正文：金额100', expected: '逐项审查' });
  h.event({ type: 'HELP_RESULT', requestId: 'review-request', resultId: 'review-result', status, answer: '核查金额100，建议补充来源' });
  return h;
}
function submit(h: Harness) {
  expect(h.event({ type: 'DELIVER', text: '交付', artifactIds: [] }).ok).toBe(true);
  return [...h.context().intents].reverse().find(work => work.kind === 'check')!;
}
describe('[BT_F24] persisted collaboration evidence', () => {
  it('freezes consumed review request and answer through recovery', () => {
    const h = reviewed();
    const work = submit(h); h.reopen();
    const records = h.context().intents.find(item => item.id === work.id)!.payload.reviewRecords as { id: string; content: string }[];
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe('review-result');
    expect(JSON.parse(records[0]!.content)).toMatchObject({ requestId: 'review-request', member: 'B', status: 'success', question: '完整候选正文：金额100', answer: '核查金额100，建议补充来源' });
    h.store.close();
  });
  it('accepts a verbatim citation to the frozen review result at the state boundary', () => {
    const h = reviewed(); submit(h);
    const check = h.authorizeCheck();
    const results = candidateJudgments(h.context().candidate).map(item => ({ ...item, source: { id: 'review-result', quote: '核查金额100，建议补充来源' } }));
    h.checkResult(check, results);
    expect(h.context().outcome).toBe('complete');
    h.store.close();
  });
  it('rejects a fabricated quote from a real review result', () => {
    const h = reviewed(); submit(h);
    const check = h.authorizeCheck();
    const results = candidateJudgments(h.context().candidate).map(item => ({ ...item, source: { id: 'review-result', quote: '并不存在的审查结论' } }));
    h.checkResult(check, results);
    expect(h.context().outcome).not.toBe('complete');
    expect(h.context().publishedDelivery).toBeUndefined();
    h.store.close();
  });
  it('preserves partial review status without converting it to success', () => {
    const h = reviewed('partial');
    const work = submit(h);
    expect(JSON.parse((work.payload.reviewRecords as { content: string }[])[0]!.content).status).toBe('partial');
    h.store.close();
  });
  it('excludes a completed review for an old goal', () => {
    const h = reviewed();
    h.event({ type: 'USER_INPUT', text: '新目标', goal: { text: '新目标', criteria: [], constraints: [], requiredArtifacts: 0 } });
    expect(submit(h).payload.reviewRecords).toEqual([]);
    h.store.close();
  });
  it('excludes a pending request without a consumed member result', () => {
    const h = new Harness(); h.help();
    expect(h.event({ type: 'DELIVER', text: '交付', artifactIds: [] }).ok).toBe(false);
    expect(h.context().intents.some(work => work.kind === 'check')).toBe(false);
    h.store.close();
  });
});
