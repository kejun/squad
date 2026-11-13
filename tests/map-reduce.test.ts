import { afterEach, describe, expect, it } from 'vitest';
import { MapReduceFixture } from './map-reduce-fixture.js';
const fixtures: MapReduceFixture[] = [];
function setup(limit?: string, sqlite = false) { const f = new MapReduceFixture(limit, sqlite); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) { f.releaseMaps(); await f.parallel; f.close(); } });

describe('map-reduce engine, HTTP adapter and durable integration', () => {
  it('[BT_Q01] starts both model requests before either completes and hands every result to the owner', async () => {
    const f = setup(); await f.recognize(); await f.beginParallel(); f.assertParallel();
    await f.finishMaps(); f.assertHandoff(); await f.drain();
    expect(f.context().outcome).toBe('complete');
    expect(f.requests.filter(request => request.kind === 'owner')).toHaveLength(1);
    expect(f.requests.filter(request => request.kind === 'discussionSummary')).toHaveLength(1);
  });
  it.each(['失败', '部分完成'])('[BT_Q03] retains %s despite a misleading success summary', async failure => {
    const f = setup(); f.failure = failure; await f.recognize(); await f.drain();
    expect(f.context().outcome).toBe('complete');
    expect(f.context().discussion?.incomplete).toBeTruthy();
    expect(f.context().discussion?.results).toHaveLength(2);
  });
  it('[BT_Q05] reopens SQLite without rerunning the completed map or duplicating the reduce', async () => {
    const f = setup(undefined, true); await f.recognize();
    const work = f.engine.claim(f.room, f.task, f.pending('assistance')[0]!.id)!;
    expect(f.record(work).ok).toBe(true); f.reopen(); f.reopen();
    expect(f.engine.send(f.room, f.task, f.repeated!).duplicate).toBe(true);
    await f.drain();
    expect(f.context().outcome).toBe('complete');
    expect(f.requests.filter(request => request.kind === 'assistance')).toHaveLength(1);
    expect(f.requests.filter(request => request.kind === 'discussionSummary')).toHaveLength(1);
    expect(f.requests.filter(request => request.kind === 'owner')).toHaveLength(1);
  });
});
