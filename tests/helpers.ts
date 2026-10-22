import { TeamEngine, MemoryStore, type TaskEvent, type TeamConfig, type Store, type WorkKind } from '../src/index.js';
import { config as baseline } from '../team.config.js';

export type EventBody = TaskEvent extends infer E ? E extends TaskEvent ? Omit<E, 'id' | 'at'> & { id?: string; at?: number } : never : never;
export const configuration = (change?: Partial<TeamConfig['limits']>): TeamConfig => ({ ...structuredClone(baseline), limits: { ...baseline.limits, ...change } });
export class Harness {
  now = 0; seq = 0; room = 'room1'; task = 'task:M1'; engine: TeamEngine;
  constructor(readonly config = configuration(), readonly store: Store = new MemoryStore()) {
    this.engine = new TeamEngine(store, config, () => this.now);
    this.engine.submit(this.room, { id: 'M1', text: 'Write a plan', goal: { text: 'Write a plan', constraints: ['cite sources'], criteria: ['Complete plan'], requiredArtifacts: 0 } });
  }
  event(input: EventBody) { return this.engine.send(this.room, this.task, { ...input, id: input.id ?? `test:${++this.seq}`, at: input.at ?? this.now } as TaskEvent); }
  view() { return this.engine.view(this.room, this.task)!; }
  context() { return this.view().context; }
  claim(kind?: WorkKind) {
    const item = this.engine.pending(this.room, this.task).find(i => !kind || i.kind === kind);
    if (!item) throw new Error(`No pending ${kind}: ${this.view().phase}`);
    return this.engine.claim(this.room, this.task, item.id)!;
  }
  help(id = 'H1') { return this.event({ type: 'HELP', requestId: id, caller: 'A', target: 'B', question: 'Check recovery', expected: 'Sources and limitations' }); }
  result(id = 'R1', requestId = 'H1') { return this.event({ type: 'HELP_RESULT', requestId, resultId: id, status: 'success', answer: 'Source confirms limitations' }); }
  reopen() { this.engine = new TeamEngine(this.store, this.config, () => this.now); this.engine.recover(this.room); }
}
