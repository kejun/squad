import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { executionId } from '../src/task.machine.js';
import type { ExecutionTicket } from '../src/task/execution.machine.js';
import type { Intent, TaskContext } from '../src/types.js';

interface SavedExecution {
  snapshot?: { value: string; status: string; context: Partial<ExecutionTicket> };
}

interface SavedTask {
  room: string;
  task: string;
  stage: string;
  work: Pick<Intent, 'id' | 'attempt'>;
  record: {
    version: number;
    snapshot: { context: TaskContext; children: Record<string, SavedExecution> };
  };
}

// X6-02 / BT_N09. These rows were produced by the pre-migration TeamEngine and
// exported from SQLite. Recreate only the storage around the exact old rows.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-checkpoints-xstate-v5.json', import.meta.url), 'utf8')) as {
  rows: [SavedTask, SavedTask, SavedTask];
};
const [authorized, uncertain, published] = fixture.rows;

function withReopenedTask(sample: SavedTask, check: (store: SqliteStore, engine: TeamEngine) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'squad-xstate-persistence-'));
  const path = join(directory, 'task.sqlite');
  try {
    const writer = new SqliteStore(path);
    try {
      writer.transact(sample.room, tx => {
        tx.room.tasks[sample.task] = sample.record;
        tx.room.activeTaskId = sample.task;
      });
    } finally {
      writer.close();
    }
    const store = new SqliteStore(path);
    try {
      check(store, new TeamEngine(store, sample.record.snapshot.context.config, () => 30));
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(fixture.rows)('[X6-02][BT_N09] reads the v5 $stage snapshot without rewriting SQLite', sample => {
  withReopenedTask(sample, (store, engine) => {
    expect(engine.executionPhase(sample.room, sample.task, sample.work)).toBe(sample.stage);
    expect(engine.view(sample.room, sample.task)?.context).toEqual(sample.record.snapshot.context);
    expect(store.read(sample.room).tasks[sample.task]).toEqual(sample.record);
  });
});

it('[X6-02][BT_N09] recovers an old unstarted permit into one new execution attempt', () => {
  withReopenedTask(authorized, (_store, engine) => {
    const { room, task, work } = authorized;
    const oldAttempt = authorized.record.snapshot.context.intents[0]!;

    engine.recover(room);
    expect(engine.executionPhase(room, task, work)).toBe('interrupted');
    expect(engine.beginExecution(room, task, oldAttempt)).toBe(false);

    const next = engine.claim(room, task, work.id)!;
    expect(next.attempt).toBe(work.attempt + 1);
    expect(engine.beginExecution(room, task, next)).toBe(true);
    expect(engine.beginExecution(room, task, next)).toBe(false);
    expect(engine.executionPhase(room, task, next)).toBe('running');
  });
});

it('[X6-02][BT_N09] reads an older checkpoint without children but cannot start its old attempt', () => {
  const old = structuredClone(authorized);
  const { room, task, work } = old;
  old.record.snapshot.children = {};
  withReopenedTask(old, (store, engine) => {
    const oldAttempt = old.record.snapshot.context.intents[0]!;

    expect(engine.view(room, task)?.context).toEqual(old.record.snapshot.context);
    expect(engine.beginExecution(room, task, oldAttempt)).toBe(false);
    expect(store.read(room).tasks[task]).toEqual(old.record);

    engine.recover(room);
    expect(engine.claim(room, task, work.id)?.attempt).toBe(work.attempt + 1);
  });
});

it('[X6-02][BT_N09] keeps an old unknown local effect in reconciliation after recovery', () => {
  withReopenedTask(uncertain, (_store, engine) => {
    const { room, task, work } = uncertain;

    engine.recover(room);

    expect(engine.executionPhase(room, task, work)).toBe('uncertain');
    expect(engine.view(room, task)?.context.intents[0]?.localOperations?.[0]?.status).toBe('uncertain');
    expect(engine.pending(room, task)).toEqual([]);
    expect(engine.beginExecution(room, task, uncertain.record.snapshot.context.intents[0]!)).toBe(false);
  });
});

it('[X6-02][BT_N09] preserves an already published file and its settled execution after recovery', () => {
  withReopenedTask(published, (_store, engine) => {
    const { room, task, work } = published;

    engine.recover(room);

    const view = engine.view(room, task);
    expect(view?.context.outcome).toBe('complete');
    expect(view?.context.artifacts).toContainEqual(expect.objectContaining({ name: 'legacy.md', content: '旧附件内容' }));
    expect(view?.context.messages.find(message => message.kind === 'final')?.artifactIds)
      .toEqual(published.record.snapshot.context.publishedDelivery?.artifactIds);
    expect(engine.executionPhase(room, task, work)).toBe('settled');
  });
});

it.each([
  { damage: 'missing snapshot', corrupt: (child: SavedExecution) => { delete child.snapshot; } },
  { damage: 'unknown phase', corrupt: (child: SavedExecution) => { child.snapshot!.value = 'unknown'; } },
  { damage: 'completed status on an authorized phase', corrupt: (child: SavedExecution) => { child.snapshot!.status = 'done'; } },
  ...(['taskId', 'intentId', 'attempt', 'epoch', 'goalVersion', 'target', 'kind'] as const).map(field => ({
    damage: `missing ticket ${field}`,
    corrupt: (child: SavedExecution) => { delete child.snapshot!.context[field]; },
  })),
])('[X6-02][BT_N11] $damage cannot create an execution permit', ({ corrupt }) => {
  const malformed = structuredClone(authorized);
  const { room, task, work } = malformed;
  corrupt(malformed.record.snapshot.children[executionId(work.id, work.attempt)]!);
  withReopenedTask(malformed, (store, engine) => {
    const oldAttempt = malformed.record.snapshot.context.intents[0]!;

    expect(() => engine.beginExecution(room, task, oldAttempt)).toThrow('Incompatible task execution snapshot');
    expect(store.read(room).tasks[task]).toEqual(malformed.record);
  });
});

it.each([
  { target: 'B' }, { kind: 'interpretation' as const }, { epoch: 2 }, { goalVersion: 2 },
])('[X6-02][BT_N11] reads a stale ticket %o but refuses to start it', patch => {
  const stale = structuredClone(authorized);
  const { room, task, work } = stale;
  Object.assign(stale.record.snapshot.children[executionId(work.id, work.attempt)]!.snapshot!.context, patch);
  withReopenedTask(stale, (store, engine) => {
    const oldAttempt = stale.record.snapshot.context.intents[0]!;

    expect(engine.executionPhase(room, task, work)).toBe('authorized');
    expect(engine.beginExecution(room, task, oldAttempt)).toBe(false);
    expect(store.read(room).tasks[task]).toEqual(stale.record);
  });
});

it('[X6-02][BT_N11] a valid ticket saved under a different actor ID is rejected', () => {
  const malformed = structuredClone(authorized);
  const { room, task, work } = malformed;
  const children = malformed.record.snapshot.children;
  const actorId = executionId(work.id, work.attempt);
  children[executionId(work.id, work.attempt + 1)] = children[actorId]!;
  delete children[actorId];
  withReopenedTask(malformed, (store, engine) => {
    const oldAttempt = malformed.record.snapshot.context.intents[0]!;

    expect(() => engine.beginExecution(room, task, oldAttempt)).toThrow('Incompatible task execution snapshot');
    expect(store.read(room).tasks[task]).toEqual(malformed.record);
  });
});
