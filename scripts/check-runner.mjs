import { spawn } from 'node:child_process';

// Bound stalls, not the sum of every test's runtime. Test frameworks retain
// their per-test deadlines. Each leaf command owns one process group.
export function runNode(args, {
  idleTimeout = 60000,
  killGrace = 1000,
  maxDuration = 300000,
  env = process.env,
  output = (chunk, stream) => process[stream].write(chunk),
} = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      stdio: ['inherit', 'pipe', 'pipe'], env,
      detached: process.platform !== 'win32',
    });
    let idleTimer, killTimer, hardTimer;
    let timedOut = false;
    let interrupted = false;
    const signal = name => {
      try {
        if (process.platform === 'win32') child.kill(name);
        else process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const stop = () => {
      clearTimeout(idleTimer);
      signal('SIGTERM');
      killTimer ??= setTimeout(() => signal('SIGKILL'), killGrace);
    };
    const timeout = reason => {
      timedOut = true;
      output(`${reason}: node ${args.join(' ')}\n`, 'stderr');
      stop();
    };
    const interrupt = () => { interrupted = true; stop(); };
    const resetDeadline = () => {
      if (timedOut || interrupted) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeout(`No output for ${idleTimeout}ms`);
      }, idleTimeout);
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => { output(chunk, stream); resetDeadline(); });
    }
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    child.on('error', error => output(`${error.message}\n`, 'stderr'));
    child.on('close', status => {
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      // Descendants with closed/ignored pipes can outlive a successful parent.
      signal('SIGKILL');
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
      resolve({ status: timedOut || interrupted ? 1 : (status ?? 1), timedOut });
    });
    hardTimer = setTimeout(() => timeout(`Exceeded ${maxDuration}ms hard deadline`), maxDuration);
    resetDeadline();
  });
}
