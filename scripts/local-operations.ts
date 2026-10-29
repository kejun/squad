import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../team.config.js';
import { TeamEngine } from '../src/engine.js';
import { SqliteStore } from '../src/store.js';
import { LocalRuntime } from '../src/local-runtime.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, room: { type: 'string' }, task: { type: 'string' },
  operation: { type: 'string' }, confirm: { type: 'string' }, 'data-root': { type: 'string' } } });
const database = resolve(values.database ?? process.env.WEB_DATABASE ?? 'team.sqlite');
await stat(database); // A typo must not create and then "verify" a new empty database.
const runtime = await LocalRuntime.create({ dataRoot: values['data-root'] ?? process.env.SQUAD_LOCAL_DATA_DIR ?? join(dirname(database), '.squad-local'),
  skillRoots: [], ...(process.env.SQUAD_WORKSPACE_ROOT ? { workspaceRoot: process.env.SQUAD_WORKSPACE_ROOT } : {}),
  backend: { available: false, execute: async () => { throw new Error('Inspection cannot execute a command'); } } });
const store = new SqliteStore(database);
try {
  const engine = new TeamEngine(store, config);
  if (values.confirm && (!values.room || !values.task || !values.operation)) throw new Error('--confirm requires exact --room, --task and --operation identities');
  if (values.confirm) engine.recover(values.room!);
  const db = new DatabaseSync(database); let rooms: string[];
  try { rooms = (db.prepare('SELECT id FROM rooms').all() as { id: string }[]).map(r => r.id); } finally { db.close(); }
  let found = false;
  for (const room of rooms.filter(id => !values.room || id === values.room)) {
    for (const task of Object.keys(store.read(room).tasks).filter(id => !values.task || id === values.task)) {
      const context = engine.view(room, task)!.context;
      for (const work of context.intents) for (const op of work.localOperations ?? []) {
        if (values.operation ? op.id !== values.operation : !['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) continue;
        found = true;
        if (values.confirm) {
          if (op.status !== 'uncertain') throw new Error('Only an uncertain operation may be acknowledged');
          const receipt = await runtime.acknowledgeOperation(work, op, values.confirm);
          const reply = engine.send(room, task, { type: 'LOCAL_RECONCILE', id: `operator:${randomUUID()}`, at: Date.now(), intentId: work.id,
            operationId: op.id, sessionId: op.sessionId!, ...receipt });
          if (!reply.ok) throw new Error(reply.code);
          console.log(JSON.stringify({ room, task, operationId: op.id, code: reply.code, detail: receipt.detail }));
        } else {
          const review = op.action.type === 'runCli' && op.sessionId ? await runtime.reviewOperation(work, op).catch(() => null) : null;
          console.log(JSON.stringify({ room, task, workId: work.id, status: op.status, review }, null, 2));
        }
      }
    }
  }
  if (values.operation && !found) throw new Error('LOCAL_OPERATION_NOT_FOUND');
} finally { store.close(); await runtime.close(); }
