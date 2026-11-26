import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { identityAlive, processIdentity, runProcess, type ProcessIdentity } from '../src/local-cli.js';
import { serviceRecoveryAcceptance } from './local-tools-acceptance.js';

it.skipIf(process.platform !== 'linux').each([
  { event: 'deadline', code: 'succeeded', exitCode: 0, effectsKnown: true },
  { event: 'abort', code: 'succeeded', exitCode: 0, effectsKnown: true },
  { event: 'settlement deadline', code: 'cancelled', exitCode: null, effectsKnown: false },
] as const)(
  'keeps the exit receipt when $event follows close during the identity write',
  async ({ event, code, exitCode, effectsKnown }) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'squad-cli-settlement-'));
    const release = join(directory, 'release');
    const signal = new AbortController();
    const timeoutMs = 1_000;
    let markExited!: () => void;
    const exited = new Promise<void>(resolve => { markExited = resolve; });
    const allowExit = () => fs.writeFile(release, '');
    const beforeClose = {
      deadline: allowExit,
      abort: allowExit,
      'settlement deadline': () => signal.abort(),
    }[event];
    const lateEvent = {
      deadline: () => vi.advanceTimersByTime(timeoutMs),
      abort: () => signal.abort(),
      'settlement deadline': () => vi.advanceTimersByTime(1_800),
    }[event];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const receipt = await runProcess({
        executable: process.execPath, cwd: directory, workspace: directory, env: {}, timeoutMs, sessionId: 'closed-during-journal',
        logPath: join(directory, 'process.log'),
        args: ['-e', `const { existsSync } = require('node:fs');
          const limit = setTimeout(() => process.exit(2), 3000);
          const wait = setInterval(() => {
            if (!existsSync(${JSON.stringify(release)})) return;
            clearInterval(wait);
            clearTimeout(limit);
          }, 5);`],
        observeProcess: phase => {
          if (phase !== 'local.processFinished') return;
          lateEvent();
          markExited();
        },
      }, signal.signal, async () => {
        await beforeClose();
        await exited;
      });
      expect(receipt).toMatchObject({
        settled: true, effectsKnown,
        result: { ok: code === 'succeeded', code, data: { exitCode, processRecorded: true } },
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')('cleans up a same-group descendant at close while the identity write is pending', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'squad-cli-descendant-'));
  const release = join(directory, 'release');
  const descendantPid = join(directory, 'descendant.pid');
  const signal = new AbortController();
  let leader: ProcessIdentity | undefined;
  let closed = false;
  let finishIdentity!: () => void;
  const identityWrite = new Promise<void>(resolve => { finishIdentity = resolve; });
  const execution = runProcess({
    executable: process.execPath, cwd: directory, workspace: directory, env: {}, timeoutMs: 2_500, sessionId: 'close-with-descendant',
    logPath: join(directory, 'process.log'),
    args: ['-e', `const { spawn } = require('node:child_process');
      const { existsSync, writeFileSync } = require('node:fs');
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
      descendant.unref();
      writeFileSync(${JSON.stringify(descendantPid)}, String(descendant.pid));
      const limit = setTimeout(() => process.exit(2), 3000);
      const wait = setInterval(() => {
        if (!existsSync(${JSON.stringify(release)})) return;
        clearInterval(wait);
        clearTimeout(limit);
      }, 5);`],
    observeProcess: phase => { if (phase === 'local.processFinished') closed = true; },
  }, signal.signal, async identity => {
    leader = identity;
    await identityWrite;
  });
  void execution.catch(() => {});
  try {
    const descendant = await vi.waitFor(async () => {
      expect(leader).toBeDefined();
      return processIdentity(Number(await fs.readFile(descendantPid, 'utf8')));
    });
    const stat = await fs.readFile(`/proc/${descendant.procPid}/stat`, 'utf8');
    expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]).toBe(leader!.procPid);
    expect(await identityAlive(descendant)).toBe(true);

    await fs.writeFile(release, '');
    await vi.waitFor(() => expect(closed).toBe(true));
    await vi.waitFor(async () => expect(await identityAlive(descendant)).toBe(false), { timeout: 350, interval: 10 });

    finishIdentity();
    expect(await execution).toMatchObject({
      settled: true, effectsKnown: true,
      result: { ok: true, code: 'succeeded', data: { exitCode: 0, processRecorded: true } },
    });
  } finally {
    signal.abort();
    finishIdentity();
    await execution.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Other local-tool acceptance paths run directly through features/24_local_skills_cli.feature.
// These startup reconciliation paths have additional WebService wiring not exercised there.
describe('local operation boundary and recovery integration', () => {
  it('[BT_L06] [BT_L11] startup reconciles a durable receipt before scheduling', () => serviceRecoveryAcceptance(false));
  it('[BT_L06] startup retains a possibly launched command without guessing', () => serviceRecoveryAcceptance(true));
});

it.skipIf(process.platform !== 'linux').each([0, 1])('keeps the real exit receipt when /proc returns ESRCH (exit %i)', async exitCode => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'squad-cli-exit-'));
  const release = join(directory, 'release');
  let markExited!: () => void;
  const exited = new Promise<void>(resolve => { markExited = resolve; });
  const readFile = fs.readFile;
  let interruptedReads = 0;
  const procRead = vi.spyOn(fs, 'readFile').mockImplementation(async (path, options) => {
    if (typeof path !== 'string' || !/^\/proc\/\d+\/stat$/.test(path)) return readFile(path, options);
    interruptedReads++;
    await fs.writeFile(release, '');
    await exited;
    throw Object.assign(new Error('Process exited during identity sampling'), { code: 'ESRCH' });
  });
  syncBuiltinESMExports();
  try {
    const receipt = await runProcess({
      executable: process.execPath, cwd: directory, workspace: directory, env: {}, timeoutMs: 2_000, sessionId: 'short-command',
      logPath: join(directory, 'process.log'),
      args: ['-e', `const { existsSync } = require('node:fs');
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          console.log('completed');
          process.exitCode = ${exitCode};
        }, 5);`],
      observeProcess: phase => { if (phase === 'local.processFinished') markExited(); },
    }, new AbortController().signal, async () => { throw new Error('Disappeared process cannot be recorded as running'); });
    expect(interruptedReads).toBe(1);
    expect(receipt).toMatchObject({
      settled: true, effectsKnown: true,
      result: { ok: exitCode === 0, code: exitCode === 0 ? 'succeeded' : 'failed',
        data: { exitCode, stdout: 'completed\n', processRecorded: false } },
    });
  } finally {
    procRead.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
