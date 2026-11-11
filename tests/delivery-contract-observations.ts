import assert from 'node:assert/strict';
import type { TaskContext } from '../src/types.js';

/** A stopped source-revision with no saved business output may publish only its exact host status report. */
export function assertStoppedHostReportOnly(context: TaskContext): void {
  const frozen = context.resilience!.frozen!;
  assert.equal(context.stopped, true); assert.equal(context.outcome, 'stopped');
  assert.equal(context.candidate, null); assert.equal(context.publishedDelivery, undefined);
  assert.equal(frozen.outcome, 'stopped'); assert.equal(frozen.verification, 'incomplete');
  assert.deepEqual(frozen.items, []); assert.deepEqual(frozen.sourceReceiptIds, []);
  assert.deepEqual(frozen.artifactIds, [frozen.reportArtifactId]);
  assert.deepEqual(context.artifacts, [{ id: frozen.reportArtifactId, name: 'task-report.md', content: frozen.text, goalVersion: context.goalVersion }]);
  assert(frozen.text.includes('没有可用的业务成果')); assert(frozen.text.includes('stopped'));
  assert.deepEqual(context.messages.at(-1)!.artifactIds, [frozen.reportArtifactId]);
  assert.equal(context.messages.at(-1)!.detailText, frozen.text);
  assert(context.messages.at(-1)!.text.includes('stopped'));
  assert(!context.intents.some(work => ['owner', 'check'].includes(work.kind) && work.status === 'pending'));
}
/** Match only the named provenance fields while retaining native Node equality. */
export function hasFields(actual: unknown, expected: unknown): boolean {
  try {
    assert(actual && typeof actual === 'object');
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      assert(key in actual);
      assert.deepEqual((actual as Record<string, unknown>)[key], value);
    }
    return true;
  } catch { return false; }
}
/** Observe request arguments while running the supplied transport or authorization. */
export function observeCalls<T extends (...args: any[]) => any = (...args: any[]) => any>(operation?: T): T & { calls: Parameters<T>[] } {
  const calls: Parameters<T>[] = [];
  const observed = ((...args: Parameters<T>) => { calls.push(args); return operation?.(...args); }) as T & { calls: Parameters<T>[] };
  observed.calls = calls;
  return observed;
}
