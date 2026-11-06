import assert from 'node:assert/strict';
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
