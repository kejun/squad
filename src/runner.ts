import { randomUUID } from 'node:crypto';
import { localEnabled, localPhysicalPending, type LocalAction, type LocalCheckpoint, type LocalMessage, type LocalOperation, type LocalToolResult } from './local-operation.js';
import type { LocalRuntime } from './local-runtime.js';
import type { SkillPage } from './local-skills.js';
import type { TeamEngine } from './engine.js';
import type { ArtifactDraft, Decision, InputIntentSpec, InputReference, Intent, ModelOutputIssue, TaskEvent } from './types.js';
import { inputIntentSchema, validInputIntent } from './input-intent.js';
import { validArtifactDrafts, validSummary } from './presentation.js';
import { findSkills, type FoundSkill, type SkillSearchTransport } from './skills.js';
import { CloudflareWebTools, validWebFetchInput, validWebSearchInput, type WebTools } from './web-tools.js';

export type WorkOutput =
  | { type: 'interpretation'; spec: InputIntentSpec }
  | { type: 'help'; requestId: string; target: string; question: string; expected: string; refs?: string[] }
  | { type: 'answer'; text: string; status?: 'success' | 'partial' | 'failed'; summary?: string; artifacts?: ArtifactDraft[] }
  | { type: 'deliver'; text: string; artifactIds: string[]; summary?: string; artifacts?: ArtifactDraft[] }
  | { type: 'decision'; decision: Decision }
  | { type: 'check'; passed: boolean; gaps: string[] }
  | { type: 'blocked'; reason: string }
  | { type: 'askUser'; question: string }
  | { type: 'settled' };
export interface WorkAdapter {
  /** Must honor the idempotency identity and AbortSignal; external writes need reconciliation. */
  execute(intent: Intent, signal: AbortSignal, scope: WorkScope): Promise<WorkOutput>;
  cancel?(intent: Intent): Promise<void>;
}
export interface LocalWorkTools {
  readonly catalog: SkillPage;
  readonly checkpoint: LocalCheckpoint | undefined;
  invoke(action: LocalAction, messages: LocalMessage[], signal: AbortSignal): Promise<LocalToolResult>;
  resume(operationId: string, signal: AbortSignal): Promise<LocalToolResult>;
}
export interface WorkScope {
  readonly localTools?: LocalWorkTools;
  /** Stable conversation identity for provider routing; defaults to the persisted task ID. */
  readonly sessionId?: string;
  /** The first request is reserved on claim; call before each additional model/tool request. */
  authorizeAdditionalRequest(requestId: string): void;
  /** Authorize and persist a format repair before another request; absent hosts fail closed. */
  regenerateModelOutput?(issue: ModelOutputIssue): void;
  /** Available to every member by default; each search reserves one execution unit. */
  findSkills(query: string, signal?: AbortSignal): Promise<FoundSkill[]>;
  webSearch: WebTools['search'];
  webFetch: WebTools['fetch'];
}

export class WorkFailure extends Error {
  constructor(message: string, readonly transient = false, readonly resultUncertain = false) { super(message); }
}
export function validWorkOutput(value: unknown): value is WorkOutput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every(x => typeof x === 'string');
  switch (v.type) {
    case 'interpretation': return Object.keys(v).every(key => ['type', 'spec'].includes(key)) && inputIntentSchema.safeParse(v.spec).success;
    case 'help': return ['requestId', 'target', 'question', 'expected'].every(k => typeof v[k] === 'string' && (v[k] as string).trim().length > 0) && (v.refs === undefined || strings(v.refs));
    case 'answer': return typeof v.text === 'string' && validSummary(v.summary) && validArtifactDrafts(v.artifacts) && (v.status === undefined || ['success', 'partial', 'failed'].includes(String(v.status)));
    case 'deliver': return typeof v.text === 'string' && strings(v.artifactIds) && validSummary(v.summary) && validArtifactDrafts(v.artifacts);
    case 'decision': return !!v.decision && typeof v.decision === 'object';
    case 'check': return typeof v.passed === 'boolean' && strings(v.gaps);
    case 'blocked': return typeof v.reason === 'string';
    case 'askUser': return typeof v.question === 'string' && !!v.question.trim();
    case 'settled': return true;
    default: return false;
  }
}

/** Host driver: persisted claim precedes every adapter call. No XState entry action starts I/O. */
export class WorkRunner {
  private controllers = new Map<string, AbortController>();
  constructor(readonly engine: TeamEngine, private readonly adapter: WorkAdapter, private readonly clock: () => number = Date.now,
    private readonly skillSearchTransport: SkillSearchTransport = globalThis.fetch,
    private readonly webTools: WebTools = new CloudflareWebTools(),
    private readonly localRuntime?: LocalRuntime) {}
  async runOne(roomId: string, taskId: string, intentId?: string): Promise<boolean> {
    if (this.engine.flushResults(roomId, taskId)) return true;
    const available = this.engine.pending(roomId, taskId);
    const pending = intentId ? available.find(work => work.id === intentId) : available[0];
    if (!pending) return false;
    const work = this.engine.claim(roomId, taskId, pending.id);
    // A denied recovery claim may settle a reviewer and schedule synthesis in the same transaction.
    if (!work) return this.engine.pending(roomId, taskId).some(item => item.id !== pending.id);
    if (work.kind === 'cancel') {
      const id = String(work.payload.intentId);
      this.controllers.get(id)?.abort();
      try {
        const original = this.engine.view(roomId, taskId)!.context.intents.find(i => i.id === id)!;
        if (this.adapter.cancel) await this.adapter.cancel(original);
        // Cancellation acknowledgement only means settled when the worker confirms it.
        this.engine.send(roomId, taskId, { id: `${work.id}:cancelSent`, at: this.clock(), type: 'SETTLE', intentId: work.id });
      } catch (error) {
        this.engine.send(roomId, taskId, { id: `${work.id}:cancelFailed`, at: this.clock(), type: 'WORK_FAILED', intentId: work.id, reason: String(error), transient: false });
      }
      return true;
    }
    const controller = new AbortController();
    this.controllers.set(work.id, controller);
    let output: WorkOutput;
    let skillSearchSequence = 0;
    let webSequence = 0;
    let repairSequence = 0;
    const authorizeWeb = (capability: 'web_search' | 'web_fetch', signal: AbortSignal) => {
      signal.throwIfAborted();
      if (this.engine.config.webTools?.enabled === false) throw new WorkFailure('WEB_TOOLS_DISABLED');
      const response = this.engine.send(roomId, taskId, { type: 'CONSUME', capability, intentId: work.id,
        id: `request:${work.id}:${work.attempt}:${capability}:${++webSequence}`, at: this.clock(),
        fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
      if (!response.ok) throw new WorkFailure(response.code);
    };
    const scope: WorkScope = { sessionId: taskId, authorizeAdditionalRequest: requestId => {
      const response = this.engine.send(roomId, taskId, { type: 'CONSUME', intentId: work.id, id: `request:${work.id}:${work.attempt}:${requestId}`, at: this.clock(), fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
      if (!response.ok) throw new WorkFailure(response.code);
    }, regenerateModelOutput: issue => {
      controller.signal.throwIfAborted();
      const response = this.engine.send(roomId, taskId, { type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue,
        id: `repair:${work.id}:${work.attempt}:${++repairSequence}`, at: this.clock(),
        fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
      if (!response.ok) throw new WorkFailure(`模型输出格式不合规，无法继续重新生成 (${response.code})`);
    }, findSkills: async (query, signal) => {
      const current = this.engine.view(roomId, taskId)!.context;
      if (this.engine.config.skillSearch?.enabled === false || current.config.skillSearch?.enabled === false) throw new WorkFailure('SKILL_SEARCH_DISABLED');
      if (!['owner', 'assistance', 'facilitator'].includes(work.kind)) throw new WorkFailure('SKILL_SEARCH_NOT_ALLOWED');
      if (typeof query !== 'string' || !query.trim()) throw new WorkFailure('INVALID_SKILL_QUERY');
      signal?.throwIfAborted();
      scope.authorizeAdditionalRequest(`findSkills:${++skillSearchSequence}`);
      return findSkills(query, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, this.skillSearchTransport);
    }, webSearch: async (input, signal) => {
      if (!validWebSearchInput(input)) throw new WorkFailure('invalid_web_search_input');
      const combined = AbortSignal.any([controller.signal, signal]);
      authorizeWeb('web_search', combined);
      const result = await this.webTools.search(input, combined);
      combined.throwIfAborted();
      return result;
    }, webFetch: async (input, signal) => {
      if (!validWebFetchInput(input)) throw new WorkFailure('invalid_web_fetch_input');
      const combined = AbortSignal.any([controller.signal, signal]);
      authorizeWeb('web_fetch', combined);
      const result = await this.webTools.fetch(input, combined);
      combined.throwIfAborted();
      return result;
    } };
    if (this.localRuntime) {
      const runtime = this.localRuntime;
      const executeLocal = async (operationId: string, externalSignal: AbortSignal): Promise<LocalToolResult> => {
        const remaining = work.deadline === null ? this.engine.config.limits.workTimeoutMs : work.deadline - this.clock();
        const signal = AbortSignal.any([controller.signal, externalSignal, AbortSignal.timeout(Math.max(1, Math.min(remaining, 2_147_483_647)))]);
        let op: LocalOperation | undefined;
        while (true) {
          signal.throwIfAborted();
          if (!localEnabled(this.engine.config, work.target)) throw new WorkFailure('LOCAL_TOOLS_DISABLED');
          op = this.engine.view(roomId, taskId)?.context.intents.find(i => i.id === work.id)?.localOperations?.find(o => o.id === operationId);
          if (!op) throw new WorkFailure('LOCAL_OPERATION_MISSING');
          if (['succeeded', 'failed', 'cancelled'].includes(op.status) && op.result) return op.result;
          if (op.status !== 'queued') throw new WorkFailure('LOCAL_OPERATION_UNCERTAIN', false, true);
          const generation = op.workspaceId ? runtime.workspaceGeneration(op.workspaceId) : 0;
          const claim = this.engine.claimLocal(roomId, taskId, work.id, op.id, work.attempt);
          if (claim.response.ok) { op = claim.operation!; break; }
          if (claim.response.code !== 'WORKSPACE_BUSY') {
            const result = { ok: false, code: claim.response.code, data: {} };
            this.engine.send(roomId, taskId, { type: 'LOCAL_REJECTED', id: `local-reject:${randomUUID()}`, at: this.clock(), intentId: work.id,
              operationId: op.id, parentAttempt: op.parentAttempt, result });
            throw new WorkFailure(claim.response.code);
          }
          await runtime.waitForWorkspace(op.workspaceId!, generation, signal);
        }
        const currentWork = () => this.engine.view(roomId, taskId)!.context.intents.find(i => i.id === work.id)!;
        let execution;
        let enteredRuntime = false;
        try {
          signal.throwIfAborted();
          // Permission and cancellation are checked again after the durable claim, before filesystem/process I/O.
          const context = this.engine.view(roomId, taskId)!.context;
          if (context.stopped || context.epoch !== work.epoch || context.goalVersion !== work.goalVersion || !localEnabled(this.engine.config, work.target)) throw new WorkFailure('LOCAL_EXECUTION_REVOKED');
          enteredRuntime = true;
          execution = await runtime.execute(currentWork(), op, signal, metadata => {
            const started = this.engine.send(roomId, taskId, { type: 'LOCAL_STARTED', id: `local-start:${op!.sessionId}`, at: this.clock(),
              intentId: work.id, operationId: op!.id, sessionId: op!.sessionId!, ...metadata });
            if (!started.ok) throw new WorkFailure(started.code);
          });
        } catch (error) {
          // An unknown host failure after a claim is never converted to permission to replay a write.
          const safe = !enteredRuntime || op.action.type !== 'runCli';
          execution = { result: { ok: false, code: signal.aborted ? 'cancelled' : 'LOCAL_EXECUTION_FAILED', data: {} }, settled: safe, effectsKnown: safe };
        }
        const response = this.engine.send(roomId, taskId, { type: 'LOCAL_RESULT', id: `local-result:${op.sessionId}`, at: this.clock(),
          intentId: work.id, operationId: op.id, sessionId: op.sessionId!, ...execution });
        if (response.ok && execution.settled && execution.effectsKnown && op.workspaceId) runtime.notifyWorkspace(op.workspaceId);
        if (!response.ok || !execution.settled || !execution.effectsKnown) throw new WorkFailure(response.ok ? 'LOCAL_OPERATION_UNCERTAIN' : response.code, false, true);
        signal.throwIfAborted();
        return execution.result;
      };
      Object.defineProperty(scope, 'localTools', { value: {
        catalog: runtime.catalog(), checkpoint: work.localCheckpoint,
        invoke: async (action: LocalAction, messages: LocalMessage[], signal: AbortSignal) => {
          signal.throwIfAborted(); controller.signal.throwIfAborted();
          if (!localEnabled(this.engine.config, work.target)) throw new WorkFailure('LOCAL_TOOLS_DISABLED');
          const op = this.engine.requestLocal(roomId, taskId, work.id, work.attempt, action, messages, ['runCli', 'verifyWorkspace'].includes(action.type) ? runtime.workspaceId(work, this.engine.localNamespace(roomId, taskId)) : undefined);
          return executeLocal(op.id, signal);
        },
        resume: executeLocal,
      } satisfies LocalWorkTools, enumerable: true });
    }
    try {
      scope.authorizeAdditionalRequest('__initial_reserved_request__');
      output = await this.adapter.execute(work, controller.signal, scope);
    }
    catch (error) {
      if (controller.signal.aborted && !this.engine.view(roomId, taskId)!.context.intents.some(i => i.id === work.id && localPhysicalPending(i))) {
        this.engine.send(roomId, taskId, { id: `${work.id}:cancelled`, at: this.clock(), type: 'SETTLE', intentId: work.id });
      } else {
        this.engine.send(roomId, taskId, { id: `${work.id}:failed:${work.attempt}`, at: this.clock(), type: 'WORK_FAILED', intentId: work.id,
          reason: String(error), transient: error instanceof WorkFailure && error.transient,
          resultUncertain: work.replay === 'unsafe' || (error instanceof WorkFailure && error.resultUncertain), fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
      }
      this.controllers.delete(work.id);
      return true;
    }
    const base = { id: `result:${work.id}`, at: this.clock(), workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } };
    const allowed: Record<Intent['kind'], WorkOutput['type'][]> = {
      interpretation: ['interpretation'], owner: ['help', 'answer', 'deliver', 'blocked', 'askUser'], assistance: ['answer'], facilitator: ['decision'], discussionSummary: ['answer'], check: ['check'], tool: ['settled'], cancel: ['settled'],
    };
    if (!validWorkOutput(output) || !allowed[work.kind].includes(output.type)
      || (output.type === 'interpretation' && !validInputIntent(output.spec,
        (work.payload.input as { action: unknown }).action, work.payload.references as InputReference[]))) {
      this.engine.send(roomId, taskId, { ...base, id: `${base.id}:invalid`, type: 'WORK_FAILED', intentId: work.id, reason: 'Invalid worker output', transient: false });
      this.controllers.delete(work.id);
      return true;
    }
    let event: TaskEvent;
    const presentation = output.type === 'answer' || output.type === 'deliver' ? {
      ...(output.summary === undefined ? {} : { summary: output.summary }),
      ...(output.artifacts === undefined ? {} : { artifacts: output.artifacts }),
    } : {};
    if (work.discussionId) {
      if (output.type === 'decision') event = { ...base, type: 'DISCUSSION_PLAN', discussionId: work.discussionId, decision: output.decision };
      else if (output.type === 'answer') event = { ...base, ...presentation, type: 'DISCUSSION_RESULT', discussionId: work.discussionId, text: output.text, status: output.status ?? 'success' };
      else throw new Error('Unexpected discussion output after role validation');
      this.engine.send(roomId, taskId, event);
      this.controllers.delete(work.id);
      return true;
    }
    switch (output.type) {
      case 'interpretation': event = { ...base, type: 'INTERPRETATION_RESULT', inputId: (work.payload.input as { id: string }).id, spec: output.spec }; break;
      case 'help': event = { ...base, type: 'HELP', caller: work.target, requestId: output.requestId, target: output.target, question: output.question, expected: output.expected, ...(output.refs ? { refs: output.refs } : {}) }; break;
      case 'answer':
        event = work.kind === 'assistance'
          ? { ...base, ...presentation, type: 'RECORD_RESULT', requestId: String(work.payload.requestId), resultId: base.id, status: output.status ?? 'success', answer: output.text }
          : { ...base, ...presentation, type: 'DELIVER', text: output.text, artifactIds: [] };
        break;
      case 'deliver': event = { ...base, ...presentation, type: 'DELIVER', text: output.text, artifactIds: output.artifactIds }; break;
      case 'decision': event = { ...base, type: 'COORDINATE', decision: output.decision }; break;
      case 'check': event = { ...base, type: 'CHECK_RESULT', resultId: base.id, passed: output.passed, gaps: output.gaps }; break;
      case 'blocked': event = { ...base, type: 'BLOCKED', reason: output.reason }; break;
      case 'askUser': event = { ...base, type: 'WAIT_USER', question: output.question }; break;
      case 'settled': event = { ...base, type: 'SETTLE', intentId: work.id }; break;
    }
    if (event.type === 'CHECK_RESULT' && event.passed && scope.localTools && this.localRuntime) {
      const current = this.engine.view(roomId, taskId)!.context.intents.find(i => i.id === work.id)!;
      const validation = current.localOperations?.find(op => op.action.type === 'runCli' && op.isolated && op.workspaceRevision);
      if (validation) {
        try {
          const verification = await scope.localTools.invoke({ type: 'verifyWorkspace', expectedRevision: validation.workspaceRevision! },
            [...(current.localCheckpoint?.messages ?? []), { role: 'assistant', content: JSON.stringify(output) },
              { role: 'user', content: JSON.stringify({ type: 'host_workspace_validation', expectedRevision: validation.workspaceRevision }) }], controller.signal);
          if (current.localOperations?.some(op => op.result?.data.validationInputsChanged === true)) {
            event = { ...event, passed: false, gaps: [...event.gaps, '检查过程中源文件已改变，结果不能证明原工程通过验证 (CHECK_INPUTS_CHANGED)'] };
          }
          if (!verification.ok) event = { ...event, passed: false, gaps: [...event.gaps, `工程验证版本已失效：${JSON.stringify(verification.data)} (${verification.code})`] };
        } catch (error) {
          this.engine.send(roomId, taskId, { ...base, id: `${base.id}:validation-failed:${work.attempt}`, type: 'WORK_FAILED', intentId: work.id,
            reason: error instanceof WorkFailure ? error.message : 'Workspace validation failed', transient: false });
          this.controllers.delete(work.id);
          return true;
        }
      }
    }
    // If this commit fails, the error escapes. It is not misreported as a model failure.
    this.engine.send(roomId, taskId, event);
    this.controllers.delete(work.id);
    return true;
  }
}
