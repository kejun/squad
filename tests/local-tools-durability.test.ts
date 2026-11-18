import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../src/local-cli.js';
import { serviceRecoveryAcceptance } from './local-tools-acceptance.js';

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
