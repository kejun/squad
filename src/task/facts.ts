import { type Intent, type TaskContext, type TaskEvent } from '../types.js';
import { localEnabled, localPhysicalPending, localRecoveryBlocked } from '../local-operation.js';
import { modelSignature, resolveModel } from '../model-config.js';
import { isMarkdownRevision } from '../delivery-acceptance.js';

export const ok = (c: TaskContext, detail = 'applied') => { c.reply = { ok: true, code: 'OK', detail }; };

export const reject = (c: TaskContext, code: string) => { c.reply = { ok: false, code, detail: code }; };

export const fence = (c: TaskContext) => ({ epoch: c.epoch, goalVersion: c.goalVersion });

export const fresh = (c: TaskContext, e: TaskEvent) => !e.fence || (e.fence.epoch === c.epoch && e.fence.goalVersion === c.goalVersion);

export const allInflight = (c: TaskContext) => c.intents.filter(i => i.status === 'inflight' && i.kind !== 'cancel');

export const inflight = (c: TaskContext) => allInflight(c).filter(i => !i.discussionId);

export const discussionActive = (c: TaskContext) => !!c.discussion && !['delivered', 'cancelled'].includes(c.discussion.status);

/** Recovery or known local settlement may retire obsolete logical work, never unknown external effects. */
export const canRetireDiscussionWork = (c: TaskContext, work: Intent) => !!work.discussionId
  && ['pending', 'inflight'].includes(work.status) && work.replay === 'safe' && !localPhysicalPending(work)
  && (!discussionActive(c) || work.discussionId !== c.discussion!.id || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion);

export const remainingInflight = (c: TaskContext, e: TaskEvent) => inflight(c).filter(i => i.id !== e.workId);

export const activeHelp = (c: TaskContext) => c.assists.find(h => h.epoch === c.epoch && ['pending', 'running', 'answered'].includes(h.status));

export const hasOrdinary = (c: TaskContext) => c.usage.ordinary < c.config.limits.ordinary;

export const isBot = (c: TaskContext, id: string) => c.config.bots.some(b => b.id === id);

export const capabilities = (c: TaskContext, target = c.owner) => ({ localTools: localEnabled(c.config, target), findSkills: c.config.skillSearch?.enabled !== false,
  webSearch: c.config.webTools?.enabled !== false, webFetch: c.config.webTools?.enabled !== false });

export const unresolvedInput = (c: TaskContext) => (c.inputAnalyses ?? []).some(input =>
  input.epoch === c.epoch && input.goalVersion === c.goalVersion && ['pending', 'inflight', 'clarification', 'failed'].includes(input.status));

export const pendingInput = (c: TaskContext) => c.inputAnalyses?.find(input =>
  input.epoch === c.epoch && input.goalVersion === c.goalVersion && input.status === 'pending'
  && !c.intents.some(work => work.id === input.workId && ['pending', 'inflight'].includes(work.status)));

export const incompatibleExecution = localRecoveryBlocked;

/** Lane and member locks are shared by the read projection and transactional claim guard. */
export function workLaneAvailable(c: TaskContext, work: Intent): boolean {
  if (allInflight(c).some(item => item.target === work.target)
    || c.intents.some(item => item.status === 'uncertain' && item.target === work.target)) return false;
  return work.discussionId ? discussionActive(c) && work.discussionId === c.discussion?.id : inflight(c).length === 0;
}

export function discussionIncomplete(c: TaskContext) {
  const round = c.discussion;
  return round && round.epoch === c.epoch && round.goalVersion === c.goalVersion ? round.incomplete : undefined;
}

export function deliveryHandoffPending(c: TaskContext): boolean {
  return discussionActive(c) || unresolvedInput(c) || c.inputs.some(input => !input.applied) || !!activeHelp(c)
    || !!c.review && !['summarizing', 'complete', 'cancelled'].includes(c.review.status);
}

export function completeProblem(c: TaskContext): string | null {
  if (discussionActive(c)) return 'UNFINISHED_DISCUSSION';
  if (unresolvedInput(c)) return 'UNRESOLVED_INPUT_INTENT';
  if (c.inputs.some(input => !input.applied)) return 'UNAPPLIED_USER_INPUT';
  if (c.review && (c.review.incomplete || !['summarizing', 'complete'].includes(c.review.status))) return 'UNFINISHED_REVIEW';
  if (!c.candidate || !c.candidate.text.trim()) return 'NO_DELIVERY';
  if (c.candidate.goalVersion !== c.goalVersion) return 'STALE_DELIVERY';
  if (activeHelp(c)) return 'UNSETTLED_ASSISTANCE';
  const ids = new Set(c.candidate.artifactIds);
  if (ids.size < c.goal.requiredArtifacts) return 'MISSING_ARTIFACTS';
  for (const id of ids) {
    const artifact = c.artifacts.find(a => a.id === id);
    if (!artifact || !artifact.content.trim() || artifact.goalVersion !== c.goalVersion) return 'MISSING_OR_STALE_ARTIFACT';
  }
  if (c.sourceArtifact && !c.artifacts.some(artifact => ids.has(artifact.id) && artifact.id !== c.sourceArtifact!.artifactId
    && artifact.goalVersion === c.goalVersion && isMarkdownRevision(artifact))) return 'MISSING_MARKDOWN_REVISION';
  return null;
}

export function recoveryIssue(c: TaskContext, config: TaskContext['config']): string | null {
  if (c.config.version !== config.version || c.config.toolVersion !== config.toolVersion) return 'Execution version incompatible';
  if (modelSignature(c.config.models) !== modelSignature(config.models)) return 'Model configuration changed';
  if (unresolvedInput(c) && (c.config.inputAnalysis?.enabled !== false) !== (config.inputAnalysis?.enabled !== false)) return 'Input analysis configuration changed';
  if (!config.bots.some(b => b.id === c.owner)) return 'Execution member unavailable';
  if (discussionActive(c) && c.discussion!.targets.some(target => !config.bots.some(bot => bot.id === target))) return 'Execution member unavailable';
  if (c.review && ['pending', 'reviewing'].includes(c.review.status)
    && c.review.targets.some(target => !config.bots.some(bot => bot.id === target))) return 'Execution member unavailable';
  for (const i of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && !canRetireDiscussionWork(c, i))) {
    if (modelSignature(i.model) !== modelSignature(resolveModel(config, i.kind, i.target))) return 'Model configuration changed';
    if (['owner', 'assistance', 'tool'].includes(i.kind) && !config.bots.some(b => b.id === i.target)) return 'Execution member unavailable';
    const tools = config.bots.find(b => b.id === i.target)?.tools ?? [];
    if (i.kind === 'tool' && !tools.includes(String(i.payload.tool))) return 'Tool permission revoked';
    if (i.kind === 'assistance' && ((i.payload.requiredTools as string[] | undefined) ?? []).some(t => !tools.includes(t))) return 'Tool permission revoked';
  }
  return null;
}

export const d = (event: TaskEvent) => event.type === 'COORDINATE' ? event.decision : null;
