import { describe, expect, it } from 'vitest';
import { MapReduceFixture } from './map-reduce-fixture.js';
import { LocalFixture } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';
import { WorkRunner } from '../src/runner.js';
import type { IntentRequest } from './input-intent-fixture.js';
import type { LocalToolResult } from '../src/local-operation.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function receipt(request: IntentRequest): (LocalToolResult & { operationId?: string }) | undefined {
  return request.messages.filter(message => message.role === 'user').map(message => JSON.parse(message.content) as LocalToolResult & { type?: string })
    .find(value => value.type === 'local_tool_result');
}
const commands = { alpha: 'node', beta: 'squad-map-beta-command-not-installed' } as const;

/** Only provider replies and scheduling delays are controlled; capability bytes come from LocalRuntime. */
class CombinedFixture {
  readonly maps = new MapReduceFixture(undefined, true);
  readonly entered = deferred();
  readonly gates = new Map<string, ReturnType<typeof deferred>>();
  readonly calls = new Map<string, Promise<boolean>>();
  runner!: WorkRunner;
  private closing = false;
  private original!: LocalFixture['runtime']['execute'];
  private constructor(readonly local: LocalFixture) {}
  static async create() {
    const result = new CombinedFixture(await LocalFixture.create());
    result.runner = new WorkRunner(result.maps.engine, result.maps.adapter, () => result.maps.now, globalThis.fetch, undefined, result.local.runtime);
    const originalReply = result.maps.response!;
    result.maps.response = request => {
      if (request.kind !== 'assistance') return originalReply(request);
      const part = (request.context.partition as { id: keyof typeof commands }).id;
      return modelResponse(receipt(request)
        ? { type: 'answer', text: `${part}: 已收到本分片的能力回执`, status: 'success' }
        : { type: 'discoverHost', commands: [commands[part]] });
    };
    result.original = result.local.runtime.execute;
    result.local.runtime.execute = async (...args) => {
      const [work, op] = args;
      if (op.action.type === 'discoverHost') {
        const gate = deferred(); result.gates.set(work.id, gate);
        if (result.gates.size === 2) result.entered.resolve();
        if (!result.closing) await gate.promise;
      }
      return result.original.apply(result.local.runtime, args);
    };
    return result;
  }
  async start() {
    await this.maps.recognize();
    const works = this.maps.pending('assistance');
    expect(works).toHaveLength(2);
    for (const work of works) this.calls.set(work.id, this.runner.runOne(this.maps.room, this.maps.task, work.id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.entered.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Both persisted discovery operations must enter before either returns')), 2000);
      })]);
    } finally { clearTimeout(timer); }
    return works;
  }
  release(workId: string) { this.gates.get(workId)!.resolve(); return this.calls.get(workId)!; }
  async close() {
    this.closing = true;
    for (const gate of this.gates.values()) gate.resolve();
    await Promise.allSettled(this.calls.values());
    this.local.runtime.execute = this.original;
    await this.local.close(); this.maps.close();
  }
}

describe('parallel map partitions retain independent host discovery receipts', () => {
  it('[BT_Q01] [BT_L56] [BT_L58] routes reversed discovery completions to their original work and model context', async () => {
    const f = await CombinedFixture.create();
    try {
      const [alpha, beta] = await f.start();
      const inflight = f.maps.context().intents.filter(work => work.kind === 'assistance');
      expect(inflight.map(work => work.localOperations?.[0]?.status)).toEqual(['claimed', 'claimed']);
      expect(inflight[0]!.localOperations![0]!.id).not.toBe(inflight[1]!.localOperations![0]!.id);
      expect(inflight[0]!.localOperations![0]!.sessionId).not.toBe(inflight[1]!.localOperations![0]!.sessionId);
      expect(f.maps.pending('discussionSummary')).toEqual([]);

      await f.release(beta!.id);
      expect(f.maps.context().intents.find(work => work.id === alpha!.id)!.localOperations![0]!.status).toBe('claimed');
      expect(f.maps.context().intents.find(work => work.id === beta!.id)!.localOperations![0]!.status).toBe('succeeded');
      expect(f.maps.pending('discussionSummary')).toEqual([]);
      await f.release(alpha!.id);

      const alphaResult = f.maps.context().intents.find(work => work.id === alpha!.id)!.localOperations![0]!.result!;
      const betaResult = f.maps.context().intents.find(work => work.id === beta!.id)!.localOperations![0]!.result!;
      expect(alphaResult.data.cli).toMatchObject({ commands: [{ command: 'node', sandbox: 'found', host: 'found' }] });
      expect(betaResult.data.cli).toMatchObject({ commands: [{ command: commands.beta, sandbox: 'not_found', host: 'not_found' }] });
      const continuations = f.maps.requests.filter(request => request.kind === 'assistance' && receipt(request));
      expect(continuations).toHaveLength(2);
      expect(JSON.parse(continuations[0]!.messages[1]!.content).workId).toBe(beta!.id);
      expect(receipt(continuations[0]!)!.data.cli).toEqual(betaResult.data.cli);
      expect(receipt(continuations[0]!)!.operationId).toBe(f.maps.context().intents.find(work => work.id === beta!.id)!.localOperations![0]!.id);
      expect(JSON.parse(continuations[1]!.messages[1]!.content).workId).toBe(alpha!.id);
      expect(receipt(continuations[1]!)!.data.cli).toEqual(alphaResult.data.cli);
      expect(receipt(continuations[1]!)!.operationId).toBe(f.maps.context().intents.find(work => work.id === alpha!.id)!.localOperations![0]!.id);
      expect(f.maps.context().discussion!.results.map(result => result.answer)).toEqual(['beta: 已收到本分片的能力回执', 'alpha: 已收到本分片的能力回执']);
      expect(f.maps.pending('discussionSummary')).toHaveLength(1);
      expect(f.local.backend.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it('[BT_Q04] [BT_L57] cancels both claimed discoveries without late model continuations or reduce work', async () => {
    const f = await CombinedFixture.create();
    try {
      const [alpha, beta] = await f.start();
      expect(f.maps.event({ type: 'STOP' }).ok).toBe(true);
      const cancellations = f.maps.pending('cancel');
      expect(cancellations).toHaveLength(2);
      await Promise.all(cancellations.map(work => f.runner.runOne(f.maps.room, f.maps.task, work.id)));
      await f.release(beta!.id);
      await f.release(alpha!.id);

      const stopped = f.maps.context();
      const alphaOp = stopped.intents.find(work => work.id === alpha!.id)!.localOperations![0]!;
      const betaOp = stopped.intents.find(work => work.id === beta!.id)!.localOperations![0]!;
      expect(alphaOp).toMatchObject({ status: 'cancelled', result: { ok: false, code: 'cancelled' } });
      expect(betaOp).toMatchObject({ status: 'cancelled', result: { ok: false, code: 'cancelled' } });
      expect(alphaOp.id).not.toBe(betaOp.id);
      expect(stopped.discussion?.results).toEqual([]);
      expect(stopped.discussion?.status).toBe('cancelled');
      expect(stopped.candidate).toBeNull();
      expect(f.maps.pending('discussionSummary')).toEqual([]);
      expect(f.maps.requests.filter(request => request.kind === 'assistance')).toHaveLength(2);
      expect(f.local.backend.calls).toEqual([]);
    } finally { await f.close(); }
  });
});
