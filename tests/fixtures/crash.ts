import { SqliteStore, TeamEngine } from '../../src/index.js';
import { createTeamConfig } from '../../team.config.js';
// The crash fixture must use the same isolated configuration as the parent test.
const config = createTeamConfig({});
const [file, point] = process.argv.slice(2);
if (!file) throw new Error('Database path required');
const store = new SqliteStore(file); const e = new TeamEngine(store, config, () => 0);
e.submit('r', { id: 'M1', text: 'plan' });
e.send('r', 'task:M1', { id: 'H1', at: 0, type: 'HELP', caller: 'A', requestId: 'H1', target: 'B', question: 'check', expected: 'evidence' });
if (point !== 'afterHelp') {
  const work = e.claim('r', 'task:M1', e.pending('r', 'task:M1')[0]!.id)!;
  if (point === 'afterResult') e.send('r', 'task:M1', { id: 'record:R1', at: 0, type: 'RECORD_RESULT', requestId: 'H1', resultId: 'R1', status: 'success', answer: 'source', workId: work.id, fence: { epoch: 1, goalVersion: 1 } });
}
// Deliberately terminate without closing storage, simulating process loss after commit.
process.exit(23);
