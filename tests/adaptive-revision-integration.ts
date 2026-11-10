import assert from 'node:assert/strict';
import { WorkRunner } from '../src/runner.js';
import { Harness, configuration } from './helpers.js';
import type { Candidate } from '../src/types.js';

export async function verifyAdaptiveRevisionRunner() {
  const h = new Harness(configuration({ ordinary: 10, checks: 5 }));
  let checks = 0;
  const runner = new WorkRunner(h.engine, { async execute(work) {
    if (work.kind === 'owner') return { type: 'deliver', text: `本轮候选${checks + 1}`, artifactIds: [] };
    assert.equal(work.kind, 'check');
    const candidate = work.payload.candidate as Candidate;
    checks++;
    return { type: 'check', criteriaResults: candidate.acceptance!.criteria.map((item, index) => checks < 3 && index === 0
      ? { criterionId: item.id, status: 'failed' as const, reason: '内容仍有缺口' }
      : { criterionId: item.id, status: 'passed' as const }) };
  } }, () => h.now);
  for (let step = 0; step < 10 && await runner.runOne(h.room, h.task); step++) { /* bounded integration driver */ }
  assert.equal(checks, 3);
  assert.equal(h.context().outcome, 'complete');
  assert.equal(h.context().deliveryCycle?.revisions?.used, 2);
  assert.equal(h.context().publishedDelivery?.revision, h.context().candidate?.revision);
  assert.equal(h.context().usage.checks, 3);
}
