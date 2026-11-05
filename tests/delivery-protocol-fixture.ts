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

export function withFixtureAcceptance(output: unknown, request: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  const body = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  const message = (body as { messages?: { content: string }[] } | undefined)?.messages?.[1];
  if (!message) return output;
  const context = (JSON.parse(message.content) as { context?: Partial<CheckMaterials> }).context;
  if (value.type === 'check' && value.passed === true && Array.isArray(value.gaps) && !value.gaps.length && value.criteriaResults === undefined && context?.requirements) {
    return fixtureJudgments(context.requirements);
  }
  return output;
}
