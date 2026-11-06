/** Model gate reuses direct Gherkin drivers whose selected cases perform no product I/O. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tags = ['BT_L36', 'BT_L46', 'BT_L47', 'BT_L48', 'BT_L49', 'BT_L50', 'BT_L51', 'BT_L52', 'BT_L55', 'BT_L57'];
const output = process.argv[2] ?? 'reports/host-model-gate';
mkdirSync(output, { recursive: true });
const json = `${output}/cucumber.json`;
const run = spawnSync(process.execPath, ['--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js',
  'features/27_host_cli_approval.feature', 'features/30_host_capabilities.feature', '--import', 'tests/bdd/*.ts',
  '--tags', tags.map(tag => `@${tag}`).join(' or '), '--format', 'summary', '--format', `json:${json}`],
{ encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env, MODEL_BASE_URL: 'https://example.test/v1', MODEL_NAME: 'fixture', TSX_TSCONFIG_PATH: 'tests/bdd/tsconfig.json' } });
writeFileSync(`${output}/run.log`, `${run.stdout ?? ''}${run.stderr ?? ''}`);
assert.equal(run.error, undefined, `Host model gate subprocess failed: ${run.error?.message}`);
assert.notEqual(run.status, null, 'Host model gate did not exit normally');
assert.equal(run.status, 0, `Host model gate failed; inspect ${output}/run.log`);
const results = JSON.parse(readFileSync(json, 'utf8')) as { elements: { type: string; name: string; tags: { name: string }[]; steps: { name: string; result: { status: string } }[] }[] }[];
const traces = results.flatMap(feature => feature.elements.filter(item => item.type === 'scenario').map(item => {
  assert(item.steps.length && item.steps.every(step => step.result.status === 'passed'));
  return { name: item.name, btIds: item.tags.map(tag => tag.name).filter(tag => /^@BT_/.test(tag)), eventsAndAssertions: item.steps.map(step => step.name).filter(name => typeof name === 'string' && name.length > 0) };
}));
assert(traces.length > 0);
const sourceHashes = Object.fromEntries(['src/task.machine.ts', 'src/task/reducer.ts', 'src/local-operation.ts', 'src/host-session.ts', 'src/host-retry.ts', 'src/host-capabilities.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const report = { status: 'passed', sourceHashes, scenarios: traces.length, tags, boundary: 'Real taskMachine + persisted-snapshot round trips and controlled clocks; selected product operations do not open stores, HTTP servers, files, adapters or commands; the outer gate reads source hashes and writes reports. Cucumber imports register unselected integration steps without constructing their fixtures.', traces };
writeFileSync(`${output}/model.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, scenarios: traces.length, sourceHashes, evidence: output }, null, 2));
