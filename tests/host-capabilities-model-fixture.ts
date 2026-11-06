import assert from 'node:assert/strict';
import { discoverHostCapabilities, type HostCapabilitySource } from '../src/host-capabilities.js';
import { LocalModel } from './local-model-fixture.js';

const source = (locate: HostCapabilitySource['locate']): HostCapabilitySource => ({
  platform: 'linux', arch: 'arm64', runtimeVersion: 'v24.22.1', sandbox: { available: false, reason: 'No namespaces' },
  skills: { catalogVersion: 'catalog', skills: [], nextCursor: '20', diagnostics: [], complete: false }, locate,
});
export async function capabilityMetadata(observation: string) {
  const probes: { command: string; mode: string }[] = [];
  const report = await discoverHostCapabilities(source(async (command, mode) => { probes.push({ command, mode }); return mode === 'host' || observation !== '沙箱与宿主分别发现'; }), observation === '技能目录尚未完整' ? [] : observation === '重复查询同一命令' ? ['node', 'node'] : ['tool'], new AbortController().signal);
  const m = saveCapabilityMetadata(report);
  return { report, probes, m };
}
export function assertCapabilityMetadata(observation: string, result: Awaited<ReturnType<typeof capabilityMetadata>>) {
  const { report, probes } = result;
  assert.deepEqual(report.cli.sandbox, { available: false, reason: 'No namespaces' }); assert.equal(report.cli.hostApprovalRequired, true);
  assert.equal(report.cli.presenceIsNotExecution, true); assert.equal(report.cli.queriedOnly, true); assert.equal(report.mcp.status, 'not_connected'); assert.equal(report.mcp.scope, 'this_service');
  if (observation === '沙箱与宿主分别发现') assert.deepEqual(report.cli.commands, [{ command: 'tool', sandbox: 'not_found', host: 'found' }]);
  else if (observation === '技能目录尚未完整') { assert.equal(report.skills.complete, false); assert.equal(report.skills.nextCursor, '20'); assert.deepEqual(report.cli.commands, []); }
  else { assert.deepEqual(report.cli.commands, [{ command: 'node', sandbox: 'found', host: 'found' }]); assert.deepEqual(probes.filter(p => p.mode === 'host'), [{ command: 'node', mode: 'host' }]); assert.deepEqual(probes.filter(p => p.mode === 'sandbox'), [{ command: 'node', mode: 'sandbox' }]); }
}
export function capabilityRequest(m: LocalModel, action: unknown = { type: 'discoverHost', commands: ['node', 'missing-tool'] }) {
  return m.send({ type: 'LOCAL_REQUEST', intentId: m.work.id, operationId: 'op1', namespace: 'c'.repeat(64), requestHash: 'a'.repeat(64), action,
    parentAttempt: m.work.attempt, messages: [{ role: 'assistant', content: JSON.stringify(action) }], fence: m.work });
}
function saveCapabilityMetadata(report: Awaited<ReturnType<typeof discoverHostCapabilities>>) {
  const m = new LocalModel(i => { i.config.limits.ordinary = 1; });
  assert(capabilityRequest(m).ok); assert.equal(m.op?.status, 'queued'); assert(m.claim(false).ok); assert.equal(m.op?.status, 'claimed');
  assert(m.result({ result: { ok: true, code: 'discoverHost', data: report } }).ok);
  return m;
}
export async function minimalCapabilityRequest() {
  const report = await discoverHostCapabilities(source(async () => true), ['node'], new AbortController().signal);
  const m = saveCapabilityMetadata(report);
  return { m, report };
}
export async function cancelCapabilityRequest(constraint: string) {
  if (constraint === '停止后迟到的发现回执') {
    const m = new LocalModel(); assert(capabilityRequest(m).ok); assert(m.claim().ok); assert(m.send({ type: 'STOP' }).ok); assert.equal(m.op?.status, 'cancelling');
    assert(m.result({ result: { ok: false, code: 'cancelled', data: {} } }).ok); assert.equal(m.op?.status, 'cancelled'); assert.equal(m.c.candidate, null); assert.equal(capabilityRequest(m).code, 'STOPPED');
    return 'STOPPED';
  }
  const controller = new AbortController(), probes: string[] = [];
  if (constraint === '查询前取消') controller.abort();
  await assert.rejects(discoverHostCapabilities(source(async (_command, mode) => { probes.push(mode); controller.abort(); return true; }), ['node'], controller.signal));
  assert.deepEqual(probes, constraint === '查询前取消' ? [] : ['sandbox']);
  return 'CANCELLED';
}
