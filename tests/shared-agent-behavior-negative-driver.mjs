/** One real HTTP/SQLite fixture per process; independent cleanup observations survive assertion failure. */
import { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [role, mode, output, runtimeRoot] = process.argv.slice(2);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const source = resolve('src/model-adapter.ts'), before = hash(source);
const observed = new Set(), originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) { observed.add(this); return Reflect.apply(originalListen, this, args); };
let failure, result;
try {
  const { sharedRoleAcceptance } = await import('./shared-agent-behavior-acceptance.ts');
  result = await sharedRoleAcceptance(role, mode);
} catch (error) { failure = error; }
finally { Server.prototype.listen = originalListen; }
const connections = await Promise.all([...observed].map(server => new Promise(resolve => server.getConnections((error, count) => resolve({ error: error?.code ?? null, count: count ?? null })))));
const leftovers = readdirSync(runtimeRoot).filter(name => name.startsWith('squad-shared-behavior-'));
const cleanup = { realHttpServerObserved: observed.size > 0, allServersClosed: [...observed].every(server => !server.listening),
  allConnectionsClosed: connections.every(item => item.error === null && item.count === 0), fixtureDirectoriesRemoved: leftovers.length === 0,
  instrumentationRestored: Server.prototype.listen === originalListen, sourceUnchangedWithinChild: before === hash(source) };
const report = { status: failure ? 'failed' : 'verified', role, mode, loadedSourceSha256: before, result,
  error: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null,
  observedServerCount: observed.size, connections, leftoverFixtureDirectories: leftovers, cleanup };
writeFileSync(output, JSON.stringify(report, null, 2));
if (!Object.values(cleanup).every(Boolean)) {
  console.error('SHARED_BEHAVIOR_CLEANUP_FAILED', JSON.stringify(cleanup)); process.exitCode = 2;
} else if (failure) {
  console.error(failure.stack); process.exitCode = failure.name === 'AssertionError' ? 1 : 2;
} else console.log(JSON.stringify({ status: 'verified', role, mode, requests: result.requests.length, cleanup }));
