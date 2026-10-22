import { createHash, randomUUID } from 'node:crypto';
import { initialTask, persistTask, restoreTask, stepTask, taskPhase, type TaskSnapshot } from './task.machine.js';
import type { Store, Transaction } from './store.js';
import { validateConfig, type Goal, type Intent, type Reply, type TaskContext, type TaskEvent, type TeamConfig } from './types.js';

interface StoredTask { version: 1; snapshot: unknown }
export interface CommandResult extends Reply { taskId?: string; duplicate?: boolean }
export interface Submission {
  id: string; text: string; mentions?: string[]; goal?: Goal;
  intent?: 'new' | 'supplement' | 'decision' | 'continue'; replyToTaskId?: string;
  extraOrdinary?: number;
}
export interface TaskView { phase: ReturnType<typeof taskPhase>; context: TaskContext }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function fingerprint(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function decode(value: unknown): TaskSnapshot {
  const record = value as StoredTask;
  if (record?.version !== 1) throw new Error('Incompatible machine snapshot');
  const result = restoreTask(record.snapshot);
  if (result.context.schemaVersion !== 1) throw new Error('Incompatible task context');
  return result;
}
function storeTask(tx: Transaction, snapshot: TaskSnapshot) {
  const id = snapshot.context.taskId;
  tx.room.tasks[id] = { version: 1, snapshot: persistTask(snapshot) } satisfies StoredTask;
  if (taskPhase(snapshot) === 'ended') { if (tx.room.activeTaskId === id) tx.room.activeTaskId = null; }
  else tx.room.activeTaskId = id;
}

/** All public commands cross the same transaction seam; no effect is executed here. */
export class TeamEngine {
  private storageFault = false;
  private readonly instanceId = randomUUID();
  constructor(readonly store: Store, readonly config: TeamConfig, private readonly clock: () => number = Date.now) { validateConfig(config); }

  private transact<T>(roomId: string, fn: (tx: Transaction) => T): T {
    if (this.storageFault) throw new Error('Storage fault: reopen engine before dispatching more work');
    try { return this.store.transact(roomId, fn); }
    catch (error) {
      // Domain rejections are values; thrown errors at this seam are storage/program faults.
      this.storageFault = true;
      throw error;
    }
  }
  private receipt(tx: Transaction, id: string, payload: unknown, operation: () => CommandResult): CommandResult {
    const hash = fingerprint(payload);
    const previous = tx.receipt(id);
    if (previous) {
      if (previous.fingerprint !== hash) return { ok: false, code: 'REQUEST_ID_CONFLICT', detail: 'A request identity cannot be reused for different content' };
      return { ...(previous.result as CommandResult), duplicate: true };
    }
    const result = operation();
    tx.remember(id, hash, result);
    return result;
  }
  submit(roomId: string, input: Submission): CommandResult {
    return this.transact(roomId, tx => this.receipt(tx, input.id, input, () => {
      const at = this.clock();
      const existingId = input.replyToTaskId ?? tx.room.activeTaskId ?? (input.intent === 'decision' ? Object.keys(tx.room.tasks).at(-1) : null);
      if (existingId && tx.room.tasks[existingId]) {
        const current = decode(tx.room.tasks[existingId]);
        if (input.intent === 'decision') {
          const next = stepTask(current, { type: 'HUMAN_DECISION', id: input.id, at, text: input.text }); storeTask(tx, next);
          return { ...next.context.reply, taskId: existingId };
        }
        if (input.intent === 'continue') {
          if (tx.room.activeTaskId && tx.room.activeTaskId !== existingId) return { ok: false, code: 'ROOM_BUSY', detail: 'Another task is active' };
          const event: TaskEvent = { type: 'CONTINUE', id: input.id, at, ...(input.extraOrdinary === undefined ? {} : { extraOrdinary: input.extraOrdinary }) };
          const next = stepTask(current, event); storeTask(tx, next);
          return { ...next.context.reply, taskId: existingId };
        }
        if (taskPhase(current) === 'ended') return { ok: false, code: 'EXPLICIT_CONTINUATION_REQUIRED', detail: 'Explicitly continue the referenced ended task' };
        if (input.intent === 'new') {
          tx.room.notices.push({ id: input.id, text: '另开群或等待当前工作结束' });
          return { ok: false, code: 'ROOM_BUSY', detail: '另开群或等待当前工作结束' };
        }
        const next = stepTask(current, { type: 'USER_INPUT', id: input.id, at, text: input.text, ...(input.goal ? { goal: input.goal } : {}) });
        storeTask(tx, next);
        return { ...next.context.reply, taskId: existingId };
      }
      if (input.intent === 'continue') return { ok: false, code: 'TASK_NOT_FOUND', detail: 'Provide an existing task to continue' };
      const owner = input.mentions?.[0] ?? this.config.defaultBot;
      if (!this.config.bots.some(bot => bot.id === owner)) return { ok: false, code: 'UNKNOWN_BOT', detail: owner };
      const taskId = `task:${input.id}`;
      const goal = input.goal ?? { text: input.text, constraints: [], criteria: ['Answer the user request'], requiredArtifacts: 0 };
      const snapshot = initialTask({ taskId, owner, goal, config: this.config, at,
        message: { id: input.id, text: input.text, author: 'user', at, taskId, kind: 'user' } });
      storeTask(tx, snapshot);
      return { ok: true, code: 'OK', detail: 'created', taskId };
    }));
  }
  send(roomId: string, taskId: string, event: TaskEvent): CommandResult {
    const { at: _at, ...identity } = event;
    return this.transact(roomId, tx => this.receipt(tx, event.id, { taskId, event: identity }, () => {
      if (!tx.room.tasks[taskId]) return { ok: false, code: 'TASK_NOT_FOUND', detail: taskId };
      const current = decode(tx.room.tasks[taskId]);
      let next = stepTask(current, event);
      const reply = { ...next.context.reply, taskId };
      if (event.type === 'CLAIM' && reply.code === 'BUDGET_EXHAUSTED') {
        next = stepTask(next, { type: 'EXHAUSTED', id: `${event.id}:budget`, at: event.at, reason: 'Execution budget exhausted' });
      }
      storeTask(tx, next);
      return reply;
    }));
  }
  view(roomId: string, taskId?: string): TaskView | null {
    const room = this.store.read(roomId);
    const id = taskId ?? room.activeTaskId;
    if (!id || !room.tasks[id]) return null;
    const snapshot = decode(room.tasks[id]);
    return structuredClone({ phase: taskPhase(snapshot), context: snapshot.context });
  }
  timeline(roomId: string) {
    return Object.values(this.store.read(roomId).tasks).flatMap(value => decode(value).context.messages).sort((a, b) => a.at - b.at);
  }
  pending(roomId: string, taskId: string): Intent[] {
    const view = this.view(roomId, taskId);
    if (!view) return [];
    const kind: Partial<Record<TaskView['phase'], Intent['kind'][]>> = {
      running: ['owner', 'tool'], waitingAssistance: ['assistance'], coordinating: ['facilitator'], checking: ['check'],
    };
    return view.context.intents.filter(i => i.status === 'pending' && (i.kind === 'cancel' || kind[view.phase]?.includes(i.kind)));
  }
  claim(roomId: string, taskId: string, intentId: string): Intent | null {
    const view = this.view(roomId, taskId);
    const item = view?.context.intents.find(i => i.id === intentId);
    if (!item) return null;
    const result = this.send(roomId, taskId, { id: `claim:${intentId}:${item.attempt + 1}`, type: 'CLAIM', intentId, at: this.clock() });
    if (!result.ok) return null;
    return this.view(roomId, taskId)!.context.intents.find(i => i.id === intentId)!;
  }
  flushResults(roomId: string, taskId: string): boolean {
    const result = this.view(roomId, taskId)?.context.results.find(r => !r.consumed);
    if (!result) return false;
    this.send(roomId, taskId, { type: 'HELP_RESULT', id: `consume:${result.resultId}`, at: this.clock(),
      requestId: result.requestId, resultId: result.resultId, status: result.status, answer: result.answer,
      fence: { epoch: result.epoch, goalVersion: result.goalVersion } });
    return true;
  }
  recover(roomId: string): void {
    const room = this.store.read(roomId);
    for (const [id, value] of Object.entries(room.tasks)) {
      const snapshot = decode(value);
      if (taskPhase(snapshot) === 'ended') continue;
      this.send(roomId, id, { type: 'RECOVER', id: `recover:${this.instanceId}:${id}`, at: this.clock(), config: this.config });
      while (this.flushResults(roomId, id)) { /* Each durable result is consumed at most once. */ }
    }
    this.tick(roomId);
  }
  tick(roomId: string): void {
    const view = this.view(roomId);
    if (!view) return;
    const c = view.context; const at = this.clock();
    for (const op of c.intents.filter(i => ['pending', 'inflight'].includes(i.status) && i.kind !== 'cancel' && i.deadline !== null && i.deadline <= at)) {
      if (op.kind === 'assistance') {
        this.send(roomId, c.taskId, { id: `timeout:${op.id}`, type: 'HELP_RESULT', requestId: String(op.payload.requestId), resultId: `timeout:${op.id}`, status: 'timeout', answer: '协助已超时', at, fence: { epoch: op.epoch, goalVersion: op.goalVersion } });
      } else {
        this.send(roomId, c.taskId, { id: `timeout:${op.id}`, type: 'WORK_FAILED', intentId: op.id, reason: 'Tool or model deadline exceeded', transient: false, resultUncertain: op.replay === 'unsafe', at, fence: { epoch: op.epoch, goalVersion: op.goalVersion } });
      }
    }
    const latest = this.view(roomId, c.taskId)!;
    if (latest.phase === 'running' && latest.context.nextCheckAt <= at) this.send(roomId, c.taskId, { type: 'TICK', id: `progress:${c.taskId}:${latest.context.epoch}:${latest.context.nextCheckAt}`, at });
  }
  nextWake(roomId: string): number | null {
    const view = this.view(roomId);
    if (!view || ['waitingHuman', 'ended'].includes(view.phase)) return null;
    if (view.context.results.some(r => !r.consumed)) return this.clock();
    const work = view.context.intents.filter(i => ['pending', 'inflight'].includes(i.status) && i.deadline !== null).map(i => i.deadline!);
    if (view.phase === 'running') work.push(view.context.nextCheckAt);
    return work.length ? Math.min(...work) : null;
  }
}
