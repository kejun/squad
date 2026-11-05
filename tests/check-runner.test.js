import { describe, expect, it } from 'vitest';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runNode } from '../scripts/check-runner.mjs';

const options = { idleTimeout: 1000, killGrace: 100, output: () => {} };

describe('check runner process integration', () => {
  it('allows a progressing process to outlast the inactivity deadline', async () => {
    const source = `let n = 0; const timer = setInterval(() => {
      console.log('progress'); if (++n === 8) clearInterval(timer);
    }, 200);`;
    const result = await runNode(['-e', source], options);
    expect(result).toEqual({ status: 0, timedOut: false });
  });

  it('enforces the hard deadline even while a process keeps logging', async () => {
    const source = `const timer = setInterval(() => console.log('still running'), 100);
      setTimeout(() => clearInterval(timer), 2000);`;
    const result = await runNode(['-e', source], { ...options, maxDuration: 600 });
    expect(result).toEqual({ status: 1, timedOut: true });
  });

  it.skipIf(process.platform === 'win32')('cleans owned descendants after normal completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'check-runner-'));
    const marker = join(directory, 'orphan-ran');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 500);`;
    const source = `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
      child.unref();`;
    try {
      const result = await runNode(['-e', source], options);
      await delay(800);
      expect(result).toEqual({ status: 0, timedOut: false });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a failing process exit status', async () => {
    const result = await runNode(['-e', 'process.exit(7)'], options);
    expect(result).toEqual({ status: 7, timedOut: false });
  });

  it('terminates an unresponsive process even if it ignores SIGTERM', async () => {
    const source = `process.on('SIGTERM', () => {}); setInterval(() => {}, 100); setTimeout(() => process.exit(9), 3000);`;
    const result = await runNode(['-e', source], options);
    expect(result).toEqual({ status: 1, timedOut: true });
  });

  it('terminates descendants holding output pipes after their parent exits', async () => {
    const source = `const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100); setTimeout(() => process.exit(9), 3000)"], { stdio: 'inherit' });
      setTimeout(() => process.exit(0), 100);`;
    const result = await runNode(['-e', source], options);
    expect(result).toEqual({ status: 1, timedOut: true });
  });
});
