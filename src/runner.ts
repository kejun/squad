import type { TeamEngine } from './engine.js';
import type { Decision, Intent, TaskEvent } from './types.js';
import { findSkills, type FoundSkill, type SkillSearchTransport } from './skills.js';
import { CloudflareWebTools, validWebFetchInput, validWebSearchInput, type WebTools } from './web-tools.js';

export type WorkOutput =
  | { type: 'help'; requestId: string; target: string; question: string; expected: string; refs?: string[] }
  | { type: 'answer'; text: string; status?: 'success' | 'partial' | 'failed' }
  | { type: 'deliver'; text: string; artifactIds: string[] }
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
export interface WorkScope {
  /** Stable conversation identity for provider routing; defaults to the persisted task ID. */
  readonly sessionId?: string;
  /** The first request is reserved on claim; call before each additional model/tool request. */
  authorizeAdditionalRequest(requestId: string): void;
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
    case 'help': return ['requestId', 'target', 'question', 'expected'].every(k => typeof v[k] === 'string' && (v[k] as string).trim().length > 0) && (v.refs === undefined || strings(v.refs));
    case 'answer': return typeof v.text === 'string' && (v.status === undefined || ['success', 'partial', 'failed'].includes(String(v.status)));
    case 'deliver': return typeof v.text === 'string' && strings(v.artifactIds);
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
    private readonly webTools: WebTools = new CloudflareWebTools()) {}
  async runOne(roomId: string, taskId: string): Promise<boolean> {
    if (this.engine.flushResults(roomId, taskId)) return true;
    const pending = this.engine.pending(roomId, taskId)[0];
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
    try {
      scope.authorizeAdditionalRequest('__initial_reserved_request__');
      output = await this.adapter.execute(work, controller.signal, scope);
    }
    catch (error) {
      if (controller.signal.aborted) {
        this.engine.send(roomId, taskId, { id: `${work.id}:cancelled`, at: this.clock(), type: 'SETTLE', intentId: work.id });
      } else {
        this.engine.send(roomId, taskId, { id: `${work.id}:failed:${work.attempt}`, at: this.clock(), type: 'WORK_FAILED', intentId: work.id,
          reason: String(error), transient: error instanceof WorkFailure && error.transient,
          resultUncertain: work.replay === 'unsafe' || (error instanceof WorkFailure && error.resultUncertain), fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
      }
      this.controllers.delete(work.id);
      return true;
    }
    this.controllers.delete(work.id);
    const base = { id: `result:${work.id}`, at: this.clock(), workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } };
    const allowed: Record<Intent['kind'], WorkOutput['type'][]> = {
      owner: ['help', 'answer', 'deliver', 'blocked', 'askUser'], assistance: ['answer'], facilitator: ['decision'], check: ['check'], tool: ['settled'], cancel: ['settled'],
    };
    if (!validWorkOutput(output) || !allowed[work.kind].includes(output.type)) {
      this.engine.send(roomId, taskId, { ...base, id: `${base.id}:invalid`, type: 'WORK_FAILED', intentId: work.id, reason: 'Invalid worker output', transient: false });
      return true;
    }
    let event: TaskEvent;
    switch (output.type) {
      case 'help': event = { ...base, type: 'HELP', caller: work.target, requestId: output.requestId, target: output.target, question: output.question, expected: output.expected, ...(output.refs ? { refs: output.refs } : {}) }; break;
      case 'answer':
        event = work.kind === 'assistance'
          ? { ...base, type: 'RECORD_RESULT', requestId: String(work.payload.requestId), resultId: base.id, status: output.status ?? 'success', answer: output.text }
          : { ...base, type: 'DELIVER', text: output.text, artifactIds: [] };
        break;
      case 'deliver': event = { ...base, type: 'DELIVER', text: output.text, artifactIds: output.artifactIds }; break;
      case 'decision': event = { ...base, type: 'COORDINATE', decision: output.decision }; break;
      case 'check': event = { ...base, type: 'CHECK_RESULT', resultId: base.id, passed: output.passed, gaps: output.gaps }; break;
      case 'blocked': event = { ...base, type: 'BLOCKED', reason: output.reason }; break;
      case 'askUser': event = { ...base, type: 'WAIT_USER', question: output.question }; break;
      case 'settled': event = { ...base, type: 'SETTLE', intentId: work.id }; break;
    }
    // If this commit fails, the error escapes. It is not misreported as a model failure.
    this.engine.send(roomId, taskId, event);
    return true;
  }
}
