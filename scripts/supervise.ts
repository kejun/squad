import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { initialSupervisor, stepSupervisor, type SupervisorPolicy } from '../src/process-supervisor.machine.js';

export interface SupervisedHostOptions {
  command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv;
  healthUrl?: string; probeMs?: number; probeTimeoutMs?: number; policy?: Partial<SupervisorPolicy>;
  stdio?: 'inherit' | 'ignore'; onSpawn?: (pid: number, generation: number) => void;
}
/** A separate process owns detection; a blocked host cannot block this timer or fetch timeout. */
export function runSupervisedHost(options: SupervisedHostOptions = {}) {
  let state = initialSupervisor(Date.now(), options.policy);
  let child: ChildProcess | undefined;
  let probing = false;
  let stopped = false;
  let hostId = '';
  let lastIntent = '';
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const signal = (kind: NodeJS.Signals) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('Squad supervisor: child signal failed'); }
  };
  const apply = () => {
    const token = `${state.value}:${state.context.generation}:${state.context.deadline}:${state.context.intent}`;
    if (token !== lastIntent) {
      lastIntent = token;
      if (state.context.intent === 'terminate') signal('SIGTERM');
      if (state.context.intent === 'kill') signal('SIGKILL');
      if (state.context.intent === 'spawn') {
        const generation = state.context.generation;
        hostId = randomUUID();
        child = spawn(options.command ?? process.execPath, options.args ?? ['--import', 'tsx', 'scripts/web.ts'], {
          cwd: options.cwd ?? process.cwd(), env: { ...process.env, ...options.env, SQUAD_SUPERVISION_ID: hostId },
          detached: process.platform !== 'win32', stdio: options.stdio ?? 'inherit',
        });
        child.once('spawn', () => { if (child?.pid) options.onSpawn?.(child.pid, generation); });
        const exited = () => {
          if (stopped) return;
          state = stepSupervisor(state, { type: 'EXIT', at: Date.now(), generation }); apply();
        };
        child.once('exit', exited); child.once('error', exited);
      }
    }
    if (state.value === 'stopped' && !stopped) {
      stopped = true; clearInterval(timer); finish();
    }
  };
  const probe = async () => {
    if (probing || stopped || !['starting', 'healthy'].includes(String(state.value))) return;
    probing = true;
    const generation = state.context.generation;
    const expectedId = hostId;
    try {
      const response = await fetch(options.healthUrl ?? `http://127.0.0.1:${options.env?.WEB_PORT ?? process.env.WEB_PORT ?? 4318}/api/health`, {
        signal: AbortSignal.timeout(options.probeTimeoutMs ?? 2000),
      });
      const payload = await response.json() as { healthy?: boolean; hostId?: string };
      if (!response.ok || payload.healthy !== true || payload.hostId !== expectedId) throw new Error('unhealthy');
      if (!stopped) state = stepSupervisor(state, { type: 'HEALTH_OK', at: Date.now(), generation });
    } catch {
      if (!stopped) state = stepSupervisor(state, { type: 'HEALTH_FAILED', at: Date.now(), generation });
    } finally { probing = false; if (!stopped) apply(); }
  };
  const timer = setInterval(() => {
    state = stepSupervisor(state, { type: 'TICK', at: Date.now() }); apply(); void probe();
  }, options.probeMs ?? 2000);
  apply();
  return { done, stop() { if (!stopped) { state = stepSupervisor(state, { type: 'STOP', at: Date.now() }); apply(); } },
    status() { return { phase: state.value, generation: state.context.generation, restarts: state.context.restarts }; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = runSupervisedHost();
  process.once('SIGINT', () => host.stop()); process.once('SIGTERM', () => host.stop());
  await host.done;
}
