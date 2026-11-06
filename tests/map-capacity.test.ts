import { afterEach, describe, expect, it } from 'vitest';
import { MapCapacityFixture, verifyCapacitySnapshot, verifyCapacityDispatchFallback, verifyLegacyCapacityDispatch } from './map-capacity-fixture.js';

const fixtures: MapCapacityFixture[] = [];
const setup = (max?: 0 | 1) => { const fixture = new MapCapacityFixture(max); fixtures.push(fixture); return fixture; };
afterEach(async () => { for (const fixture of fixtures.splice(0)) { fixture.releaseMaps(); await fixture.parallel; fixture.close(); } });

describe('capacity-aware map planning across production HTTP boundaries', () => {
  it('[BT_Q07] reads all eight controlled Markdown responses through four parallel maps and one reduction', async () => {
    const fixture = setup(); await fixture.recognize(); fixture.assertPlan();
    expect(fixture.requests.filter(request => request.kind === 'interpretation')).toHaveLength(1);
    await fixture.beginParallel(); await fixture.finish();
  });
  it.each([0, 1] as const)('[BT_Q09] preserves all eight source requirements for the owner at capacity %i', async capacity => {
    const fixture = setup(capacity); await fixture.recognize(); fixture.assertOwnerFallback();
    expect(fixture.requests[0]?.context.maxPartitions).toBe(capacity);
  });
  it('[BT_Q10] repairs an eight-map plan into four complete groups without truncating source coverage', async () => {
    const fixture = setup(); fixture.firstOverCapacity = true; await fixture.recognize(); fixture.assertPlan();
    expect(fixture.requests.filter(request => request.kind === 'interpretation')).toHaveLength(2);
    expect(fixture.context().usage.retries).toBe(1); expect(fixture.context().usage.ordinary).toBe(2);
    expect(fixture.context().discussion?.mapReduce?.partitions).toHaveLength(4);
    await fixture.beginParallel(); await fixture.finish();
  });
  it('[BT_Q10] rejects a model-written capacity field before accepting a complete corrected plan', async () => {
    const fixture = setup(); fixture.firstCapacityOverride = true; await fixture.recognize(); fixture.assertPlan();
    expect(fixture.requests.filter(request => request.kind === 'interpretation')).toHaveLength(2);
    expect(fixture.context().inputAnalyses?.[0]?.spec).not.toHaveProperty('maxPartitions');
    expect(fixture.work.payload.maxPartitions).toBe(4);
  });
  it('[BT_Q10] [BT_Q11] preserves the complete plan when repair spends the last available map unit', async () => {
    const fixture = setup(); fixture.config.limits.ordinary = 7; fixture.firstOverCapacity = true;
    await fixture.recognize();
    fixture.assertOwnerFallback();
    expect(fixture.requests.filter(request => request.kind === 'interpretation')).toHaveLength(2);
    expect(fixture.context().usage.ordinary).toBe(2); expect(fixture.context().usage.retries).toBe(1);
    expect(fixture.work.payload.maxPartitions).toBe(4);
    expect(fixture.context().inputAnalyses?.[0]?.spec?.decomposition?.partitions).toHaveLength(4);
    expect(fixture.context().messages.some(message => message.text.includes('普通额度不足'))).toBe(true);
  });
  it.each([
    ['四名可用成员', 4], ['仅三名空闲成员', 3], ['剩余两次协助', 2], ['普通额度只够三片及归并续办', 3],
    ['本次理解后只够一片', 1], ['本次理解后不足一片', 0], ['资源充足仍受协议上限约束', 8],
  ] as const)('[BT_Q08] supplies charged capacity for %s', verifyCapacitySnapshot);
  it.each(['成员忙碌', '协助余额降低', '普通余额降低'])('[BT_Q11] falls back with the complete plan after %s', verifyCapacityDispatchFallback);
  it.each([false, true])('[BT_Q12] restores legacy capacity snapshots with limited resources %s', verifyLegacyCapacityDispatch);
});
