import { DatabaseSync } from 'node:sqlite';
import type { MeasurementRecord } from '../src/measurement.js';
import { summarizeMeasurements } from '../src/measurement-report.js';

const [taskId, database = process.env.WEB_DATABASE ?? 'team.sqlite'] = process.argv.slice(2);
if (!taskId) throw new Error('Usage: node --import tsx scripts/execution-measurement.ts <task-id> [database]');

const db = new DatabaseSync(database, { readOnly: true });
try {
  const rows = db.prepare("SELECT detail FROM web_events WHERE taskId = ? AND kind = 'measurement' ORDER BY id").all(taskId);
  const records = rows.map(row => JSON.parse(String(row.detail)) as MeasurementRecord);
  console.log(JSON.stringify({ taskId, runs: summarizeMeasurements(records), records }, null, 2));
} finally { db.close(); }
