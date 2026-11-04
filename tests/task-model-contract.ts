import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialTask, stepTask, persistTask, restoreTask, taskMachine, type TaskSnapshot } from '../src/task.machine.js';
import { inspectInitialTask, inspectTask, type DebugEvidence } from '../src/task-inspection.js';
import { taskGraph, type MachineGraph } from '../src/task-structure.js';
import type { Phase, TaskContext, TaskEvent, TaskInput } from '../src/types.js';

interface Frame { digest: string; phase: Phase; usage: TaskContext['usage']; reply: TaskContext['reply']; evidence: DebugEvidence }
interface Trace { name: string; input: TaskInput; events: TaskEvent[]; frames: Frame[] }
interface LegacyContract { schema: 1; sourceSha: string; xstate: string; graph: MachineGraph; seeds: Record<Phase, unknown>; savedResult: unknown; traces: Trace[] }
export const legacyTaskContract = JSON.parse(readFileSync(new URL('./fixtures/task-model-v1.json', import.meta.url), 'utf8')) as LegacyContract;
assert.equal(legacyTaskContract.sourceSha, 'dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9');

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
  const value = businessSnapshot(snapshot);
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function restoreLegacyTask(phase: Phase): TaskSnapshot {
  const saved = structuredClone(legacyTaskContract.seeds[phase]);
  assert(saved, phase);
  const snapshot = restoreTask(saved);
  assert.deepEqual(businessSnapshot(snapshot), saved);
  assert.equal(snapshot.value, phase);
  return snapshot;
}
function assertFrame(snapshot: TaskSnapshot, expected: Frame, label: string) {
  assert.equal(snapshot.value, expected.phase, label);
  assert.deepEqual(snapshot.context.usage, expected.usage, label);
  assert.deepEqual(snapshot.context.reply, expected.reply, label);
  assert.equal(snapshotDigest(snapshot), expected.digest, `${label}: full persisted snapshot differs`);
}
export function replayLegacyTrace(name: string, diagnostics = false): TaskSnapshot {
  const trace = legacyTaskContract.traces.find(trace => trace.name === name);
  assert(trace, name);
  const input = structuredClone(trace.input);
  let snapshot = initialTask(input);
  assertFrame(snapshot, trace.frames[0]!, `${name}:init`);
  if (diagnostics) {
    const initial = inspectInitialTask(input);
    assert.equal(snapshotDigest(initial.snapshot), snapshotDigest(snapshot));
    assert.deepEqual(initial.evidence, trace.frames[0]!.evidence, `${name}:initial diagnostics`);
  }
  for (const [index, event] of trace.events.entries()) {
    const before = snapshot;
    snapshot = stepTask(before, structuredClone(event));
    const frame: Frame = trace.frames[index + 1]!;
    assertFrame(snapshot, frame, `${name}:${index}:${event.type}`);
    if (diagnostics) {
      const inspected = inspectTask(before, structuredClone(event));
      assert.equal(snapshotDigest(inspected.snapshot), snapshotDigest(snapshot));
      assert.deepEqual(inspected.evidence, frame.evidence, `${name}:${index}:diagnostics`);
    }
    snapshot = restoreTask(structuredClone(persistTask(snapshot)));
    assertFrame(snapshot, frame, `${name}:${index}:persist/restore`);
  }
  assert.deepEqual(input, trace.input, 'Model must not mutate its input');
  return snapshot;
}
export function verifyLegacyDiagnostics() {
  assert.deepEqual(taskGraph(), legacyTaskContract.graph);
  for (const trace of legacyTaskContract.traces) replayLegacyTrace(trace.name, true);
}
