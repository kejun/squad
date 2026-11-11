import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const mode = process.env.SERVICE_COMPOSITION_MUTATION ?? 'observe';
const hash = source => createHash('sha256').update(source).digest('hex');
function change(source, from, to, edits, scope) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`Service fault anchor drift: ${mode}/${scope} expected 1, found ${count}`);
  edits.push({ kind: 'fault', scope, count, before: hash(from), after: hash(to) });
  return source.replace(from, to);
}
function within(source, from, to, update) {
  if (source.split(from).length !== 2 || source.split(to).length !== 2) throw new Error('Service method scope drift: ' + mode);
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  if (end < 0) throw new Error('Service method scope order drift: ' + mode);
  return source.slice(0, start) + update(source.slice(start, end)) + source.slice(end);
}
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context), path = new URL(url).pathname;
  if (!['/src/runner.ts', '/src/web/service.ts', '/src/engine.ts'].some(suffix => path.endsWith(suffix))) return loaded;
  const original = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  let source = original; const edits = [];
  if (path.endsWith('/src/runner.ts')) {
    const signature = /async runOne\([^)]*\)(?:\s*:\s*Promise<boolean>)?\s*\{/;
    if ([...source.matchAll(new RegExp(signature.source, 'g'))].length !== 1) throw new Error('Public runner observation anchor drift');
    source = source.replace(signature, `$&
      const composition = globalThis.__squadServiceComposition;
      composition?.entries.push({roomId,taskId,intentId});
      if(composition?.hostRoom===roomId && !composition.hostThrown){composition.hostThrown=true;throw new Error('ControlledNonStorageHostFault');}
      if(composition?.entryBarrier) await composition.entryBarrier;
    `);
    edits.push({ kind: 'observation', scope: 'WorkRunner.runOne', count: 1 });
  }
  if (path.endsWith('/src/web/service.ts')) {
    if (mode === 'drop-recovery-close') source = within(source,
      '  private async recoverLocal(): Promise<void> {', '  rooms(): WebRoom[] {', section => {
        // One policy now has two effective barriers around the awaited reconciliation.
        // Disable both only in startup recovery so the original second-call oracle can detect it.
        section = change(section, '          if (this.closing) return;\n          const reconciliation',
          '          const reconciliation', edits, 'WebService.recoverLocal.beforeReconcile');
        return change(section, '          const reconciliation = await this.localRuntime!.reconcile(op);\n          if (this.closing) return;',
          '          const reconciliation = await this.localRuntime!.reconcile(op);', edits, 'WebService.recoverLocal.afterReconcile');
      });
    if (['drop-execution-close', 'drop-pump-dedupe', 'drop-room-failstop'].includes(mode)) source = within(source,
      '  private kick(roomId: string) {', '  close(): Promise<void> {', section => {
        if (mode === 'drop-execution-close') return change(section,
          'this.closing ? false : this.runner(roomId).runOne(roomId, taskId, work.id)',
          'this.runner(roomId).runOne(roomId, taskId, work.id)', edits, 'WebService.kick.executionClose');
        if (mode === 'drop-pump-dedupe') return change(section, 'if (this.running.has(key)) continue;',
          'if (false) continue;', edits, 'WebService.kick.pumpDedupe');
        return change(section, 'this.failedRooms.has(roomId) || ', '', edits, 'WebService.kick.roomFailStop');
      });
  }
  if (path.endsWith('/src/engine.ts') && mode === 'drop-instance-failstop') source = within(source,
    '  private transact<T>(roomId: string, fn: (tx: Transaction) => T, proof?: DeletionSettlementProof): T {',
    '  roomDeletion(roomId: string)', section => change(section,
      "if (this.storageFault) throw new Error('Storage fault: reopen engine before dispatching more work');",
      'if (false) throw new Error("disabled storage fail-stop");', edits, 'TeamEngine.transact.instanceFailStop'));
  if (source !== original && process.env.SERVICE_COMPOSITION_APPLIED) appendFileSync(process.env.SERVICE_COMPOSITION_APPLIED, JSON.stringify({ mode, path,
    original: hash(original), changed: hash(source), edits }) + '\n');
  return { ...loaded, source };
} });
