import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const mode = process.env.SERVICE_COMPOSITION_MUTATION ?? 'observe';
function change(source, from, to) {
  if (!source.includes(from)) throw new Error('Service fault anchor drift: ' + mode);
  return source.replace(from, to);
}
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context), path = new URL(url).pathname;
  if (!['/src/runner.ts', '/src/web/service.ts', '/src/engine.ts'].some(suffix => path.endsWith(suffix))) return loaded;
  const original = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
  let source = original;
  if (path.endsWith('/src/runner.ts')) {
    const signature = /async runOne\([^)]*\)(?:\s*:\s*Promise<boolean>)?\s*\{/;
    if (!signature.test(source)) throw new Error('Public runner observation anchor drift');
    source = source.replace(signature, `$&
      const composition = globalThis.__squadServiceComposition;
      composition?.entries.push({roomId,taskId,intentId});
      if(composition?.hostRoom===roomId && !composition.hostThrown){composition.hostThrown=true;throw new Error('ControlledNonStorageHostFault');}
      if(composition?.entryBarrier) await composition.entryBarrier;
    `);
  }
  if (path.endsWith('/src/web/service.ts')) {
    if (mode === 'drop-recovery-close') source = change(source, '          if (this.closing) return;\n          const reconciliation', '          const reconciliation');
    if (mode === 'drop-execution-close') source = change(source, 'this.closing ? false : this.runner(roomId).runOne(roomId, taskId, work.id)', 'this.runner(roomId).runOne(roomId, taskId, work.id)');
    if (mode === 'drop-pump-dedupe') source = change(source, 'if (this.running.has(key)) continue;', 'if (false) continue;');
    if (mode === 'drop-room-failstop') source = change(source, 'this.failedRooms.has(roomId)', 'false');
  }
  if (path.endsWith('/src/engine.ts') && mode === 'drop-instance-failstop') source = change(source,
    "if (this.storageFault) throw new Error('Storage fault: reopen engine before dispatching more work');", 'if (false) throw new Error("disabled storage fail-stop");');
  if (source !== original && process.env.SERVICE_COMPOSITION_APPLIED) appendFileSync(process.env.SERVICE_COMPOSITION_APPLIED, JSON.stringify({ mode, path,
    original: createHash('sha256').update(original).digest('hex'), changed: createHash('sha256').update(source).digest('hex') }) + '\n');
  return { ...loaded, source };
} });
