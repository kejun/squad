import { DatabaseSync } from 'node:sqlite';
import type { MeasurementRecord } from '../src/measurement.js';
import { restoreTask } from '../src/task.machine.js';
import { readingMatchReport } from '../src/task/execution-memory.js';
import type { RoomData } from '../src/store.js';
import { summarizeMeasurements } from '../src/measurement-report.js';

const [taskId, database = process.env.WEB_DATABASE ?? 'team.sqlite'] = process.argv.slice(2);
if (!taskId) throw new Error('Usage: node --import tsx scripts/execution-measurement.ts <task-id> [database]');

const db = new DatabaseSync(database, { readOnly: true });
try {
  const rows = db.prepare("SELECT detail FROM web_events WHERE taskId = ? AND kind = 'measurement' ORDER BY id").all(taskId);
  const records = rows.map(row => JSON.parse(String(row.detail)) as MeasurementRecord);
  const room = db.prepare("SELECT data FROM rooms WHERE EXISTS (SELECT 1 FROM json_each(rooms.data, '$.tasks') WHERE key = ?) LIMIT 1").get(taskId);
  const saved = room ? JSON.parse(String(room.data)) as RoomData : undefined;
  const task = saved?.tasks[taskId] as { snapshot?: unknown } | undefined;
  const readingMatches = task?.snapshot ? readingMatchReport(restoreTask(task.snapshot).context) : undefined;
  const collection = saved?.executionMemory?.collections?.[taskId];
  console.log(JSON.stringify({ taskId, runs: summarizeMeasurements(records), readingMatches, collection, records }, null, 2));
} finally { db.close(); }
