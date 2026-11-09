import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Reply { id: string; error?: string; result?: { evidence?: string; browser?: string; source?: string } }
/** The existing verification helper owns the browser, production app and provider fixture. */
export class BrowserContract {
  private sequence = 0;
  private pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private output = '';
  private evidence = '';
  private constructor(private readonly child: ChildProcess, private readonly scenario: string) {
    child.stdout!.on('data', chunk => { this.output += chunk; });
    child.stderr!.on('data', chunk => { this.output += chunk; });
    child.on('message', value => {
      const reply = value as Reply;
      const waiter = this.pending.get(reply.id);
      if (!waiter) return;
      this.pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error));
      else waiter.resolve(reply);
    });
    child.once('exit', code => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`Browser driver exited ${code}: ${this.output}`));
      this.pending.clear();
    });
  }
  private wait(id: string) {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command ${id} exceeded 120s: ${this.output}`)); }, 120_000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  static async start(scenario: string) {
    const child = spawn(process.execPath, ['.agents/skills/verify-squad/scripts/verify.mjs', '--bdd', scenario], {
      cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const driver = new BrowserContract(child, scenario);
    try {
      const ready = await driver.wait('ready');
      assert(ready.result?.evidence && ready.result.browser && ready.result.source, 'The real Chromium run must record evidence and source');
      driver.evidence = ready.result.evidence;
      return driver;
    } catch (error) { child.kill('SIGTERM'); throw error; }
  }
  async step(command: string) {
    const id = String(++this.sequence);
    const reply = this.wait(id);
    this.child.send({ id, command });
    await reply;
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) assert.fail(`Browser driver ended before cleanup: ${this.output}`);
    const exited = once(this.child, 'exit');
    this.child.send({ command: 'close' });
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 12_000);
    let code: unknown;
    try { [code] = await exited; } finally { clearTimeout(timer); }
    const run = JSON.parse(readFileSync(join(this.evidence, 'run.json'), 'utf8'));
    assert.equal(code, 0, this.output);
    assert.equal(run.status, 'verified', JSON.stringify(run));
    assert.deepEqual(run.completed, [this.scenario], 'The original browser contract must complete');
    assert(Object.values(run.cleanup).every(value => value === true), 'Browser, app and isolated state must be cleaned');
  }
}
