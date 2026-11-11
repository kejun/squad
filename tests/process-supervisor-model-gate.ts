import assert from 'node:assert/strict';
import { initialSupervisor, stepSupervisor } from '../src/process-supervisor.machine.js';

export function verifySupervisorModel() {
  const policy = { startupMs: 100, graceMs: 10, retryMs: 5, failureLimit: 2 };
  const initial = initialSupervisor(0, policy);
  assert.equal(initial.context.intent, 'spawn');
  const healthy = stepSupervisor(initial, { type: 'HEALTH_OK', at: 1, generation: 1 });
  assert.equal(healthy.value, 'healthy');
  assert.equal(stepSupervisor(healthy, { type: 'EXIT', at: 2, generation: 0 }).value, 'healthy');
  const exited = stepSupervisor(healthy, { type: 'EXIT', at: 2, generation: 1 });
  assert.equal(exited.value, 'restarting');
  assert.equal(stepSupervisor(exited, { type: 'TICK', at: 6 }).value, 'restarting');
  const restarted = stepSupervisor(exited, { type: 'TICK', at: 7 });
  assert.equal(restarted.value, 'starting'); assert.equal(restarted.context.generation, 2);
  assert.equal(stepSupervisor(restarted, { type: 'HEALTH_OK', at: 8, generation: 1 }).value, 'starting');
  const once = stepSupervisor(healthy, { type: 'HEALTH_FAILED', at: 10, generation: 1 });
  assert.equal(once.value, 'healthy');
  const hung = stepSupervisor(once, { type: 'HEALTH_FAILED', at: 11, generation: 1 });
  assert.equal(hung.value, 'terminating'); assert.equal(hung.context.intent, 'terminate');
  assert.equal(stepSupervisor(hung, { type: 'TICK', at: 21 }).context.intent, 'kill');
  const startupHung = stepSupervisor(initial, { type: 'TICK', at: 100 });
  assert.equal(startupHung.value, 'terminating');
  const stopped = stepSupervisor(healthy, { type: 'STOP', at: 5 });
  const killed = stepSupervisor(stopped, { type: 'TICK', at: 15 });
  assert.equal(killed.value, 'stopped'); assert.equal(killed.context.intent, 'kill');
  assert.equal(stepSupervisor(killed, { type: 'TICK', at: 1_000_000 }).value, 'stopped');
  assert.equal(stepSupervisor(exited, { type: 'STOP', at: 3 }).value, 'stopped');
  return { cases: 15, scope: 'real XState supervisor; generation fencing, startup/hang/exit, backoff, bounded stop; no I/O' };
}
console.log(JSON.stringify(verifySupervisorModel()));
