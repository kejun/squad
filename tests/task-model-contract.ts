import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialTask, stepTask, persistTask, restoreTask, taskMachine, type TaskSnapshot } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from '../src/task-inspection.js';
import { taskGraph, type MachineGraph } from '../src/task-structure.js';
import type { Intent, Phase, TaskContext, TaskEvent, TaskInput } from '../src/types.js';

interface Frame { digest: string; phase: Phase; usage: TaskContext['usage']; reply: TaskContext['reply']; evidence: DebugEvidence }
interface Trace { name: string; input: TaskInput; events: TaskEvent[]; frames: Frame[] }
interface LegacyContract { schema: 1; sourceSha: string; xstate: string; graph: MachineGraph; seeds: Record<Phase, unknown>; savedResult: unknown; traces: Trace[] }
export const legacyTaskContract = JSON.parse(readFileSync(new URL('./fixtures/task-model-v1.json', import.meta.url), 'utf8')) as LegacyContract;
assert.equal(legacyTaskContract.sourceSha, 'dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9');
// BT_L23–L30 add six approval rules; BT_L32–L34 add two manual retry rules. BT_L37 adds session revocation. Frozen traces stay untouched.
// BT_M23–M29 add one explanation action to the existing current-coordination rejection.
const extendedDefinition = '676b3aa7';
const coordinationRejectionId = 'coordinating:COORDINATE:6';
const sessionRules = [
  { id: '*:REVOKE_HOST_SESSION:0', order: 0, source: '*', event: 'REVOKE_HOST_SESSION', target: null, guards: ['valid'], actions: ['apply'] },
  { id: '*:REVOKE_HOST_SESSION:1', order: 1, source: '*', event: 'REVOKE_HOST_SESSION', target: null, guards: [], actions: ['reject'] },
];
const manualRetryRules = [
  { id: '*:REQUEST_HOST_RETRY:0', order: 0, source: '*', event: 'REQUEST_HOST_RETRY', target: 'running', guards: ['valid'], actions: ['apply'] },
  { id: '*:REQUEST_HOST_RETRY:1', order: 1, source: '*', event: 'REQUEST_HOST_RETRY', target: null, guards: [], actions: ['reject'] },
];
const approvalRules = ['LOCAL_APPROVAL_REQUIRED', 'LOCAL_APPROVAL_DECISION', 'LOCAL_APPROVAL_EXPIRED'].flatMap(event => [
  { id: `*:${event}:0`, order: 0, source: '*', event, target: null, guards: ['valid'], actions: ['apply'] },
  { id: `*:${event}:1`, order: 1, source: '*', event, target: null, guards: [], actions: ['reject'] },
]);
function assertLegacyEvidence(actual: DebugEvidence, expected: DebugEvidence, label: string) {
  assert.equal(actual.definition, extendedDefinition);
  assert.deepEqual(actual, { ...expected, definition: extendedDefinition }, label);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]));
  return value;
}
// The actor refactor adds the explicitly specified execution tree. The frozen *business*
// snapshot remains unchanged; validate the added native structure before excluding it from that comparison.
export function businessSnapshot(snapshot: TaskSnapshot): unknown {
  const value = JSON.parse(JSON.stringify(persistTask(snapshot)));
  for (const [id, raw] of Object.entries(value.children)) {
    const child = raw as { src: string; snapshot: { context: { intentId: string; attempt: number }; value: string } };
    assert.equal(child.src, 'execution');
    const work = snapshot.context.intents.find(work => work.id === child.snapshot.context.intentId);
    assert(work, id); assert(child.snapshot.context.attempt <= work.attempt);
    assert.equal(id, `execution:${work.id}:${child.snapshot.context.attempt}`);
    assert(['authorized', 'running', 'cancelling', 'uncertain', 'settled', 'cancelled', 'interrupted'].includes(child.snapshot.value));
  }
  return { ...value, children: {} };
}
export function snapshotDigest(snapshot: TaskSnapshot): string {
  // Persisted JSON omits undefined properties; property insertion order is not part of its contract.
  return digest(businessSnapshot(snapshot));
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function restoreLegacyTask(phase: Phase): TaskSnapshot {
  const saved = structuredClone(legacyTaskContract.seeds[phase]);
  assert(saved, phase);
  const snapshot = restoreTask(saved);
  assert.deepEqual(businessSnapshot(snapshot), saved);
  assert.equal(snapshot.value, phase);
  return snapshot;
}
type FacilitatorOwners = Map<string, string>;
function recordCreatedFacilitators(snapshot: TaskSnapshot, owners: FacilitatorOwners) {
  for (const work of snapshot.context.intents) {
    if (work.kind === 'facilitator' && !owners.has(work.id)) owners.set(work.id, snapshot.context.owner);
  }
}
function assertFrame(snapshot: TaskSnapshot, expected: Frame, label: string, owners: FacilitatorOwners) {
  assert.equal(snapshot.value, expected.phase, label);
  assert.deepEqual(snapshot.context.usage, expected.usage, label);
  assert.deepEqual(snapshot.context.reply, expected.reply, label);
  const value = businessSnapshot(snapshot) as { context: TaskContext };
  // The only approved snapshot addition is the owner pinned when each facilitator was created.
  // Validate it before projecting it out; every other payload and persisted field stays frozen.
  for (const [id, owner] of owners) {
    const work = value.context.intents.find(item => item.id === id);
    assert(work?.kind === 'facilitator', `${label}: missing facilitator ${id}`);
    assert.equal(work.payload.owner, owner, `${label}: facilitator ${id} must retain its creation owner`);
    delete work.payload.owner;
  }
  assert.equal(digest(value), expected.digest, `${label}: full persisted snapshot differs`);
}
export function replayLegacyTrace(name: string, diagnostics = false): TaskSnapshot {
  const trace = legacyTaskContract.traces.find(trace => trace.name === name);
  assert(trace, name);
  const input = structuredClone(trace.input);
  let snapshot = initialTask(input);
  const owners: FacilitatorOwners = new Map();
  recordCreatedFacilitators(snapshot, owners);
  assertFrame(snapshot, trace.frames[0]!, `${name}:init`, owners);
  if (diagnostics) {
    const initial = inspectInitialTask(input);
    assert.equal(snapshotDigest(initial.snapshot), snapshotDigest(snapshot));
    assertLegacyEvidence(initial.evidence, trace.frames[0]!.evidence, `${name}:initial diagnostics`);
  }
  for (const [index, event] of trace.events.entries()) {
    const before = snapshot;
    snapshot = stepTask(before, structuredClone(event));
    recordCreatedFacilitators(snapshot, owners);
    const frame: Frame = trace.frames[index + 1]!;
    assertFrame(snapshot, frame, `${name}:${index}:${event.type}`, owners);
    if (diagnostics) {
      const inspected = inspectTask(before, structuredClone(event));
      assert.equal(snapshotDigest(inspected.snapshot), snapshotDigest(snapshot));
      assertLegacyEvidence(inspected.evidence, frame.evidence, `${name}:${index}:diagnostics`);
    }
    snapshot = restoreTask(structuredClone(persistTask(snapshot)));
    assertFrame(snapshot, frame, `${name}:${index}:persist/restore`, owners);
  }
  assert.deepEqual(input, trace.input, 'Model must not mutate its input');
  return snapshot;
}
function verifyCoordinationExtensionFaultDetection() {
  const trace = legacyTaskContract.traces.find(item => item.name === '成员评审');
  assert(trace);
  const snapshot = initialTask(structuredClone(trace.input)), owners: FacilitatorOwners = new Map();
  recordCreatedFacilitators(snapshot, owners);
  const mustReject = (mutate: (work: Intent) => void) => {
    const saved = structuredClone(persistTask(snapshot)) as { context: TaskContext };
    const work = saved.context.intents.find(item => item.kind === 'facilitator');
    assert(work); mutate(work);
    assert.throws(() => assertFrame(restoreTask(saved), trace.frames[0]!, 'coordination extension fault injection', owners), assert.AssertionError);
  };
  mustReject(work => { delete work.payload.owner; });
  mustReject(work => { work.payload.owner = 'wrong-owner'; });
  mustReject(work => { work.payload.unexpectedMetadata = true; });
}
export function verifyLegacyDiagnostics() {
  const graph = legacyTaskContract.graph, insertion = graph.transitions.findIndex(t => t.event === 'LOCAL_RESULT');
  assert.deepEqual(graph.transitions.find(rule => rule.id === coordinationRejectionId), {
    id: coordinationRejectionId, order: 6, source: 'coordinating', event: 'COORDINATE', target: 'waitingHuman', guards: ['isCurrent'], actions: ['reject'],
  });
  const transitions = [...sessionRules, ...manualRetryRules, ...graph.transitions.slice(0, insertion), ...approvalRules, ...graph.transitions.slice(insertion)]
    .map(rule => rule.id === coordinationRejectionId ? { ...rule, actions: ['reject', 'explainCoordinationRejection'] } : rule);
  assert.deepEqual(taskGraph(), { ...graph, definition: extendedDefinition, transitions });
  for (const trace of legacyTaskContract.traces) replayLegacyTrace(trace.name, true);
  verifyCoordinationExtensionFaultDetection();
}
