import { DatabaseSync } from 'node:sqlite';
import { coveredDuration, type ExecutionObservation, type MeasurementRecord } from '../src/measurement.js';

const [taskId, database = process.env.WEB_DATABASE ?? 'team.sqlite'] = process.argv.slice(2);
if (!taskId) throw new Error('Usage: node --import tsx scripts/execution-measurement.ts <task-id> [database]');

type Phase = ExecutionObservation['phase'];
type Interval = readonly [number, number];
const db = new DatabaseSync(database, { readOnly: true });
try {
  const rows = db.prepare("SELECT detail FROM web_events WHERE taskId = ? AND kind = 'measurement' ORDER BY id").all(taskId);
  const records = rows.map(row => JSON.parse(String(row.detail)) as MeasurementRecord);
  const byRun = new Map<string, MeasurementRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.roomId, record.run.runId]);
    const entries = byRun.get(key);
    if (entries) entries.push(record); else byRun.set(key, [record]);
  }
  const runs = [...byRun.values()].map(entries => {
    const count = (phase: Phase) => entries.filter(entry => entry.observation.phase === phase).length;
    const requestKey = (entry: MeasurementRecord) => 'requestId' in entry.observation
      ? JSON.stringify([entry.workId, entry.attempt, entry.observation.requestId]) : undefined;
    const localSession = (entry: MeasurementRecord) => 'sessionId' in entry.observation ? entry.observation.sessionId : undefined;
    const cliOperation = (entry: MeasurementRecord) => 'operationId' in entry.observation && entry.observation.action === 'runCli'
      ? entry.observation.operationId : undefined;
    const approvalKey = (entry: MeasurementRecord) => 'approvalId' in entry.observation ? entry.observation.approvalId : undefined;
    const observedIntervals: Interval[] = [];
    const duration = (start: Phase, ends: Phase[], key: (entry: MeasurementRecord) => string | undefined) => {
      const starts = new Map<string, number>();
      const intervals: Interval[] = [];
      let missingStart = 0;
      for (const entry of entries) {
        if (entry.observation.phase !== start && !ends.includes(entry.observation.phase)) continue;
        const id = key(entry);
        if (id === undefined) continue;
        if (entry.observation.phase === start) {
          starts.set(id, entry.monotonicMs);
        } else if (starts.has(id)) {
          intervals.push([starts.get(id)!, entry.monotonicMs]);
          starts.delete(id);
        } else missingStart++;
      }
      observedIntervals.push(...intervals);
      return { coveredMs: intervals.length ? coveredDuration(intervals) : null, complete: intervals.length, missingStart, missingEnd: starts.size };
    };
    const usageEntries = entries.filter(entry => entry.observation.phase === 'model.usage');
    const knownUsage = (field: 'input' | 'output' | 'total') => {
      const values = usageEntries.flatMap(({ observation }) => observation.phase === 'model.usage' && observation.usage[field] !== null
        ? [observation.usage[field]] : []);
      return { knownTokens: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
        knownResponses: values.length, unknownResponses: Math.max(0, count('model.response') - values.length) };
    };
    const durations = {
      modelTransport: duration('model.transport', ['model.responseBody', 'model.transportFailed', 'model.interrupted'], requestKey),
      cliPreparation: duration('local.prepareStarted', ['local.prepareFinished'], localSession),
      cliExecution: duration('local.processStarted', ['local.processFinished'], localSession),
      humanDecision: duration('local.approvalRequired', ['local.approvalDecision'], entry =>
        entry.observation.phase === 'local.approvalRequired' && entry.observation.sessionApproved ? undefined : approvalKey(entry)),
      createdToProcessStart: duration('local.saved', ['local.processStarted'], cliOperation),
    };
    const observations = entries.map(entry => entry.observation);
    return {
      roomId: entries[0]!.roomId,
      identity: entries[0]!.run,
      counts: {
        modelBudget: observations.filter(event => event.phase === 'budget.authorized' && event.category === 'model').length,
        otherBudget: observations.filter(event => event.phase === 'budget.authorized' && event.category !== 'model').length,
        transportStarted: count('model.transport'), responses: count('model.response'),
        interrupted: count('model.interrupted'), transportFailed: count('model.transportFailed'),
        protocolValid: observations.filter(event => event.phase === 'model.protocol' && event.valid).length,
        protocolInvalid: observations.filter(event => event.phase === 'model.protocol' && !event.valid).length,
        modelResultsAccepted: observations.filter(event => event.phase === 'work.result' && event.requestId !== null && event.accepted).length,
        modelResultsRejected: observations.filter(event => event.phase === 'work.result' && event.requestId !== null && !event.accepted).length,
        cliProcesses: count('local.processStarted'), savedReceiptReads: count('local.receiptRead'),
      },
      usage: { input: knownUsage('input'), output: knownUsage('output'), total: knownUsage('total') },
      durations, observedIntervalUnionMs: observedIntervals.length ? coveredDuration(observedIntervals) : null,
    };
  });
  console.log(JSON.stringify({ taskId, runs, records }, null, 2));
} finally { db.close(); }
