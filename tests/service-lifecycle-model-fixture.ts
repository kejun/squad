import assert from 'node:assert/strict';
import { initialTransition, transition, type EventFrom } from 'xstate';
import { serviceLifecycleMachine as machine } from '../src/web/service-lifecycle.js';

function trace(events: EventFrom<typeof machine>['type'][]) {
  let snapshot = initialTransition(machine)[0];
  const phases = [snapshot.value];
  for (const type of events) { snapshot = transition(machine, snapshot, { type })[0]; phases.push(snapshot.value); }
  return phases;
}

/** Shared pure model gate for BT_K03/K08/K09; no I/O or duplicate unit suite. */
export function verifyServiceLifecycleModel() {
  assert.deepEqual(trace(['CLOSE', 'RECOVERED', 'CLOSE', 'CLOSED', 'RECOVERED']),
    ['recovering', 'closing', 'closing', 'closing', 'closed', 'closed']);
  assert.deepEqual(trace(['RECOVERY_FAILED', 'CLOSE', 'RECOVERY_FAILED', 'CLOSED']),
    ['recovering', 'startupFailed', 'closing', 'closing', 'closed']);
  assert.deepEqual(trace(['RECOVERED', 'CLOSE', 'CLOSE', 'CLOSED', 'CLOSE']),
    ['recovering', 'ready', 'closing', 'closing', 'closed', 'closed']);
}
