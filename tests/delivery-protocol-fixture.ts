import type { AcceptanceCriterion, CriterionCoverage, CriterionJudgment } from '../src/delivery-acceptance.js';
import type { Candidate } from '../src/types.js';

/** Scripted positive answers for transport fixtures that exercise behavior outside delivery quality. */
export function fixtureCheck(candidate: unknown) {
  const criteria = (candidate as Candidate | undefined)?.acceptance?.criteria;
  const criteriaResults: CriterionJudgment[] | undefined = criteria?.map(item => ({ criterionId: item.id, status: 'passed' }));
  return { type: 'check' as const, passed: true, gaps: [], ...(criteriaResults ? { criteriaResults } : {}) };
}

type Context = { acceptanceCriteria?: AcceptanceCriterion[]; candidate?: Candidate };
export function withFixtureAcceptance(output: unknown, request: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  const body = typeof request === 'string' ? JSON.parse(request) as unknown : request;
  const message = (body as { messages?: { content: string }[] } | undefined)?.messages?.[1];
  if (!message) return output;
  const context = (JSON.parse(message.content) as { context?: Context }).context;
  if ((value.type === 'answer' || value.type === 'deliver') && value.coverage === undefined && context?.acceptanceCriteria) {
    const coverage: CriterionCoverage[] = context.acceptanceCriteria.map(item => ({ criterionId: item.id, refs: [{ kind: 'candidateText' }] }));
    return { ...value, coverage };
  }
  if (value.type === 'check' && value.passed === true && Array.isArray(value.gaps) && !value.gaps.length && value.criteriaResults === undefined && context?.candidate?.acceptance) {
    return { ...value, criteriaResults: fixtureCheck(context.candidate).criteriaResults };
  }
  return output;
}
