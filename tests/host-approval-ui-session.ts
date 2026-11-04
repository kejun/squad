import { fork, type ChildProcess } from 'node:child_process';

/** Isolate browser dependency initialization; every BDD operation still exercises the real React/HTTP flow. */
export class HostApprovalUISession {
  private child?: ChildProcess;
  posts: { approvalId: string; decision: string }[] = [];
  private command(command: string) {
    const child = this.child!;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exited); };
      const exited = () => { cleanup(); reject(new Error('UI fixture exited before completing ' + command)); };
      const message = (value: { ok: boolean; error?: string; stack?: string; posts: { approvalId: string; decision: string }[] }) => {
        cleanup(); this.posts = value.posts;
        if (value.ok) resolve(); else reject(new Error(value.stack ?? value.error));
      };
      const timer = setTimeout(() => { cleanup(); child.kill('SIGKILL'); reject(new Error('UI fixture timed out: ' + command)); }, 5000);
      child.once('message', message); child.once('exit', exited); child.send(command);
    });
  }
  async open() {
    this.child = fork('tests/fixtures/host-approval-ui.ts', [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await this.command('open');
  }
  async interact() { await this.command('interact'); }
  async close() { if (this.child?.connected) await this.command('close'); }
}
