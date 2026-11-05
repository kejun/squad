import type { LocalAction, LocalOperation } from '../local-operation.js';
import type { Intent, TaskContext } from '../types.js';

type ValidationCommand = Extract<LocalAction, { type: 'runCli' }>;
export type DeliveryVerificationPlan = { status: 'required'; action: ValidationCommand } | { status: 'unavailable' };

const script = '(?:test|build|check|lint|typecheck|verify)(?::[a-z0-9_.-]+)*';
const command = `(?:npm|pnpm|yarn|bun)[ \\t]+(?:run[ \\t]+${script}|test)`
  + `|(?:make|cargo)[ \\t]+(?:test|build|check)|go[ \\t]+test[ \\t]+\\./\\.\\.\\.|swift[ \\t]+test|(?:python3?[ \\t]+-m[ \\t]+)?pytest`;
const commandForm = new RegExp(`^(?:${command})$`, 'i');
const instruction = '(?:^|[，,；;。\\n][ \\t]*|\\b(?:and|then)[ \\t]+|(?:并且?|然后|最后|再))(?:please[ \\t]+|请[ \\t]*)?(?:run\\b|execute\\b|运行|执行|跑一下|跑)[ \\t]*';
const quotation = /`[^`\r\n]+`|“[^”\r\n]+”|"[^"\r\n]+"/g;
const instructionForm = new RegExp(`${instruction}(?:\x60([^\x60\\r\\n]+)\x60|(${command})(?=$|[，,；。！？!?\\n]|[ \\t]+(?:and|then)\\b|[ \\t]*(?:并|然后|后|以)|[.]$))|${quotation.source}`, 'gi');
const testRequirement = new RegExp(`${instruction}(?:the[ \\t]+)?(?:\\b(?:tests?|test suite|unit tests|integration tests|regression tests|build)\\b|(?:单元|集成|回归|真实)?测试|构建|${command})`, 'i');

function directVerificationText(source: string): string {
  const direct: string[] = [];
  let fence: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (marker) fence = marker;
    else if (!/^\s*>/.test(line)) direct.push(line);
  }
  return direct.join('\n').trim();
}

/** Only a direct user instruction can supply a bounded sandbox command. */
export function deliveryVerificationPlan(c: TaskContext): DeliveryVerificationPlan | undefined {
  const inputs = (c.inputAnalyses ?? []).filter(input => input.status === 'resolved' && input.goalVersion === c.goalVersion && input.action !== 'review');
  const trusted = new Set([c.goal.text, ...c.goal.constraints, ...c.goal.criteria, ...inputs.map(input => input.rawText)].map(directVerificationText));
  const commands = new Set<string>();
  let unavailable = false;
  for (const text of trusted) {
    if (commandForm.test(text)) commands.add(text.replace(/[ \t]+/g, ' '));
    for (const match of text.matchAll(instructionForm)) {
      const candidate = (match[1] ?? match[2])?.trim();
      if (candidate && commandForm.test(candidate)) commands.add(candidate.replace(/[ \t]+/g, ' '));
      else if (candidate && /\b(?:test|build|check|verify|pytest)\b/i.test(candidate)) unavailable = true;
    }
  }
  if (unavailable || commands.size > 1) return { status: 'unavailable' };
  const selected = commands.values().next().value;
  if (selected) {
    const [executable, ...args] = selected.split(' ');
    return { status: 'required', action: { type: 'runCli', executable: executable!, args, execution: 'sandbox' } };
  }
  const requirements = inputs.flatMap(input => [...(input.spec?.constraints ?? []), ...(input.spec?.acceptanceCriteria ?? [])]);
  if ([...trusted, ...requirements.map(directVerificationText)].some(text => testRequirement.test(text.replace(quotation, '')))) return { status: 'unavailable' };
  return undefined;
}

const planFor = (work: Intent) => work.payload.verification as DeliveryVerificationPlan | undefined;

function matchesCommand(action: LocalAction, plan: ValidationCommand): boolean {
  return action.type === 'runCli' && action.executable === plan.executable && action.execution === 'sandbox'
    && action.args.length === plan.args.length && action.args.every((arg, index) => arg === plan.args[index])
    && action.cwd === undefined && action.timeoutMs === undefined && action.skillId === undefined && action.reason === undefined;
}

export function deliveryValidationOperation(work: Intent): LocalOperation | undefined {
  const plan = planFor(work);
  if (plan?.status !== 'required') return undefined;
  return work.localOperations?.find(op => matchesCommand(op.action, plan.action));
}

export function deliveryVerificationEvidence(work: Intent): { id: string; workspaceRevision: string; stdout?: string; stderr?: string } | undefined {
  const test = deliveryValidationOperation(work);
  if (!test || deliveryVerificationProblem(work, false)) return undefined;
  const data = test.result!.data;
  return { id: test.id, workspaceRevision: test.workspaceRevision!,
    ...(data.truncated === false && typeof data.stdout === 'string' ? { stdout: data.stdout } : {}),
    ...(data.truncated === false && typeof data.stderr === 'string' ? { stderr: data.stderr } : {}) };
}

export function deliveryVerificationProblem(work: Intent, final: boolean): string | null {
  const plan = planFor(work);
  if (!plan) return null;
  if (plan.status === 'unavailable') return 'WORKSPACE_VALIDATION_UNAVAILABLE';
  const test = deliveryValidationOperation(work);
  if (test?.result?.data.validationInputsChanged === true) return 'CHECK_INPUTS_CHANGED';
  if (test?.result?.ok === false) return test.result.code;
  if (test?.status !== 'succeeded' || !test.sessionId || !test.isolated || !test.workspaceRevision || test.result?.data.exitCode !== 0) {
    return 'WORKSPACE_VALIDATION_REQUIRED';
  }
  if (!final) return null;
  const check = work.localOperations?.find(op => op.action.type === 'verifyWorkspace'
    && op.action.expectedRevision === test.workspaceRevision && op.workspaceId === test.workspaceId && op.parentAttempt === work.attempt);
  if (check?.result?.ok === false) return check.result.code;
  return check?.status === 'succeeded' && check.sessionId && check.result?.ok
    && check.result.data.expectedRevision === test.workspaceRevision && check.result.data.currentRevision === test.workspaceRevision
    && check.result.data.copyRevision === test.workspaceRevision ? null : 'WORKSPACE_VERIFICATION_REQUIRED';
}

export function verificationActionProblem(work: Intent, action: LocalAction, workspaceId: string | undefined, currentId?: string): string | null {
  if (work.kind !== 'check') return null;
  const plan = planFor(work);
  if (plan?.status !== 'required') return 'CHECK_LOCAL_TOOLS_NOT_ALLOWED';
  const test = deliveryValidationOperation(work);
  if (action.type === 'runCli' && matchesCommand(action, plan.action) && (!test || test.id === currentId)) return null;
  if (action.type === 'verifyWorkspace' && work.requestCount > 0 && test?.workspaceRevision === action.expectedRevision && test.workspaceId === workspaceId
    && !deliveryVerificationProblem(work, false) && !work.localOperations?.some(op => op.action.type === 'verifyWorkspace' && op.id !== currentId && op.parentAttempt === work.attempt)) return null;
  return 'CHECK_LOCAL_TOOLS_NOT_ALLOWED';
}
