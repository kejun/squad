import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const scenario = value('--bdd', value('--case', 'BT_K03')), variant = value('--variant', '');
assert(['BT_K03', 'BT_K04', 'BT_K05', 'BT_K06', 'BT_K07'].includes(scenario));
const evidence = resolve(value('--evidence', join('reports/service-composition', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid)));
assert(!existsSync(evidence)); mkdirSync(evidence, { recursive: true });
process.env.SERVICE_COMPOSITION_APPLIED = join(evidence, 'module-boundaries.jsonl');
delete process.env.MODEL_API_KEY;
process.env.MODEL_BASE_URL = 'http://127.0.0.1:1/v1'; process.env.MODEL_NAME = 'service-composition-no-provider'; process.env.MODEL_NO_AUTH = 'true';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const paths = ['src/web/service.ts', 'src/runner.ts', 'src/engine.ts', 'src/local-runtime.ts', 'src/task.machine.ts', 'src/task/lifecycle.ts', 'src/task/execution.machine.ts', 'src/inspector.machine.ts'];
const before = paths.map(file => ({ file, sha256: hash(file) }));
const run = { status: 'running', scenario, variant, evidence, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), inputs: before, node: process.version,
  mutation: process.env.SERVICE_COMPOSITION_MUTATION ?? 'observe', steps: [], completed: [], cleanup: {} };
const { ServiceCompositionFixture } = await import('./service-composition-fixture.ts');
const fixture = new ServiceCompositionFixture(scenario, variant);
const commands = ['prepare', 'act', 'scope', ...(['BT_K06', 'BT_K07'].includes(scenario) ? ['reopen'] : [])];
let failure;
async function execute(command) {
  const step = command.startsWith('order:') ? 'act' : command;
  if (command.startsWith('order:')) run.variant = command.slice(6);
  assert.equal(step, commands[run.steps.length]);
  if (step === 'prepare') await fixture.prepare();
  else if (step === 'act') await fixture.act(command.startsWith('order:') ? command.slice(6) : variant);
  else if (step === 'scope') fixture.assertScope();
  else await fixture.reopen();
  run.steps.push(step);
}
try {
  if (args.includes('--bdd')) {
    assert(process.send); process.send({ id: 'ready', result: { evidence } });
    await new Promise(done => {
      let busy = false;
      process.on('message', async message => {
        if (message.command === 'close') { done(); return; }
        if (busy) { process.send({ id: message.id, error: 'Previous service step is still running' }); return; }
        busy = true;
        try { await execute(message.command); process.send({ id: message.id, result: { evidence } }); }
        catch (error) { failure = error; process.send({ id: message.id, error: error.stack }); }
        finally { busy = false; }
      });
      process.once('disconnect', done);
    });
  } else for (const command of commands) await execute(command);
  if (failure) throw failure;
  assert.deepEqual(run.steps, commands);
  assert(existsSync(process.env.SERVICE_COMPOSITION_APPLIED), 'Public runner boundary must be observed by the diagnostic loader');
  run.boundaries = readFileSync(process.env.SERVICE_COMPOSITION_APPLIED, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(run.boundaries.some(boundary => boundary.path.endsWith('/src/runner.ts')), 'Public runner observation cannot be skipped');
  run.proof = fixture.result(); run.completed.push(scenario); run.status = 'verified';
} catch (error) { run.status = 'failed'; run.error = error.stack; process.exitCode = 1; }
finally {
  try { await fixture.close(); run.cleanup.fixtureClosed = true; } catch (error) { run.status = 'failed'; run.cleanupError = error.stack; process.exitCode = 1; }
  run.cleanup.sourceUnchanged = before.every(({ file, sha256 }) => hash(file) === sha256);
  if (!run.cleanup.sourceUnchanged) { run.status = 'failed'; process.exitCode = 1; }
  writeFileSync(join(evidence, 'run.json'), JSON.stringify(run, null, 2));
  console.log(JSON.stringify({ status: run.status, evidence, error: run.error, cleanupError: run.cleanupError }));
}
if (process.connected) process.disconnect();
