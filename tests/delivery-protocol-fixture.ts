import assert from 'node:assert/strict';
import type { AcceptanceCriterion, CheckMaterials, CriterionJudgment } from '../src/delivery-acceptance.js';
import type { Candidate } from '../src/types.js';

/** Scripted positive answers for transport fixtures that exercise behavior outside delivery quality. */
export function fixtureCheck(candidate: unknown) {
  return fixtureJudgments((candidate as Candidate | undefined)?.acceptance?.criteria ?? []);
}

export function fixtureJudgments(criteria: readonly AcceptanceCriterion[]) {
  const criteriaResults: CriterionJudgment[] = criteria.map(item => ({ criterionId: item.id, status: 'passed' }));
  return { type: 'check' as const, criteriaResults };
}

/** Locate the original work envelope among optional host observations and tool receipts. */
export function fixtureWorkInput(request: unknown, expectedWorkId?: string): { workId: string; context: Record<string, unknown> } {
  const body = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  assert(body && typeof body === 'object' && !Array.isArray(body), 'Fixture request must contain model messages');
  const messages = (body as { messages?: unknown }).messages;
  assert(Array.isArray(messages), 'Fixture request must contain model messages');
  const matches: { workId: string; context: Record<string, unknown> }[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || message.role !== 'user' || typeof message.content !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(message.content) as unknown; } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const value = parsed as { workId?: unknown; context?: unknown };
    if (typeof value.workId !== 'string' || expectedWorkId !== undefined && value.workId !== expectedWorkId
      || !value.context || typeof value.context !== 'object' || Array.isArray(value.context)) continue;
    matches.push({ workId: value.workId, context: value.context as Record<string, unknown> });
  }
  assert.equal(matches.length, 1, 'Fixture request must contain exactly one original work envelope for the expected work');
  return matches[0]!;
}

export function withFixtureAcceptance(output: unknown, request: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  if (value.type !== 'check' || value.passed !== true || !Array.isArray(value.gaps) || value.gaps.length || value.criteriaResults !== undefined) return output;
  const body = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  if (!(body as { messages?: unknown } | undefined)?.messages) return output;
  const context = fixtureWorkInput(body).context as Partial<CheckMaterials>;
  if (context.requirements) {
    return fixtureJudgments(context.requirements);
  }
  return output;
}
