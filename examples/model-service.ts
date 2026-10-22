import { randomUUID } from 'node:crypto';
import { OpenAICompatibleAdapter, SqliteStore, TeamEngine, WorkRunner } from '../src/index.js';
import { config } from '../team.config.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: npm run model:run -- "task for the configured default bot"');
  process.exit(2);
}
const store = new SqliteStore('team.sqlite');
const engine = new TeamEngine(store, config);
const roomId = `model-demo:${randomUUID()}`;
const started = engine.submit(roomId, { id: randomUUID(), text });
const taskId = started.taskId!;
const runner = new WorkRunner(engine, new OpenAICompatibleAdapter(config));
let cancellation: Promise<boolean> | undefined;
const stop = () => {
  engine.send(roomId, taskId, { type: 'STOP', id: randomUUID(), at: Date.now() });
  cancellation = runner.runOne(roomId, taskId);
};
process.once('SIGINT', stop);
try {
  while (await runner.runOne(roomId, taskId)) { /* Request and retry counts are bounded by the persisted task budgets. */ }
  if (cancellation) await cancellation;
  const view = engine.view(roomId, taskId)!;
  for (const message of engine.timeline(roomId)) console.log(`[${message.author}] ${message.text}`);
  console.log(JSON.stringify({ roomId, taskId, state: view.phase, outcome: view.context.outcome, reason: view.context.reason, usage: view.context.usage }, null, 2));
  if (view.context.outcome !== 'complete') process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  store.close();
}
