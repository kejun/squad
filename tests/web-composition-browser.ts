import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Reply { id: string; result?: { evidence: string; browser?: string }; error?: string }
/** Cucumber owns an isolated composition driver and verifies its cleanup over IPC. */
export class CompositionProcess {
  private sequence = 0;
  private readonly pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private output = '';
  evidence = '';
  private constructor(private readonly child: ChildProcess, private readonly scenario: string) {
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => { this.output += chunk; });
    child.on('message', value => {
      const reply = value as Reply, waiter = this.pending.get(reply.id);
      if (!waiter) return; this.pending.delete(reply.id);
      if (reply.error) waiter.reject(new Error(reply.error)); else waiter.resolve(reply);
    });
    child.once('exit', code => { for (const waiter of this.pending.values()) waiter.reject(new Error(`Composition driver exited ${code}: ${this.output}`)); this.pending.clear(); });
  }
  private wait(id: string) {
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Composition command timed out: ' + this.output)); }, 120_000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }
  static async start(scenario: string, variant: string, script = '.agents/skills/verify-squad/scripts/composition.mjs', imports: string[] = []) {
    const child = spawn(process.execPath, [...imports.flatMap(path => ['--import', path]), script, '--bdd', scenario, '--variant', variant], {
      cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const driver = new CompositionProcess(child, scenario);
    try {
      const ready = await driver.wait('ready'); assert(ready.result?.evidence);
      if (script.endsWith('/composition.mjs')) assert(ready.result.browser, 'Browser driver must report actual Chromium');
      driver.evidence = ready.result.evidence; return driver;
    } catch (error) { child.kill('SIGTERM'); throw error; }
  }
  async step(command: string) { const id = String(++this.sequence), reply = this.wait(id); this.child.send({ id, command }); await reply; }
  async close() {
    if (this.child.exitCode !== null) assert.fail('Composition driver ended before Cucumber cleanup: ' + this.output);
    const exited = once(this.child, 'exit'); this.child.send({ command: 'close' });
    const timeout = setTimeout(() => this.child.kill('SIGTERM'), 12_000);
    try {
      const [code] = await exited;
      const report = JSON.parse(readFileSync(join(this.evidence, 'run.json'), 'utf8'));
      assert.equal(code, 0, this.output); assert.equal(report.status, 'verified', JSON.stringify(report));
      assert.deepEqual(report.completed, [this.scenario]); assert(Object.values(report.cleanup).every(Boolean));
    } finally { clearTimeout(timeout); }
  }
}
export { CompositionProcess as WebCompositionBrowser };
