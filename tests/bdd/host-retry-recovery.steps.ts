import assert from 'node:assert/strict';
import { After, Given, Then, When } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { hostUntil } from '../host-approval-fixture.js';
import { HostRetryFixture } from '../host-retry-fixture.js';
import { retryOp, retryWithQueuedSuccessor, settleRetry, startFirstRetry } from '../host-retry-model-fixture.js';
import { localModelInput, type LocalModel } from '../local-model-fixture.js';
import type { WebHostApproval } from '../../src/web/contracts.js';

interface QueuedRetry {
  fixture: HostRetryFixture;
  first: WebHostApproval;
  candidateRevision: string;
  trigger?: 'RECOVER' | 'HOST_RETRY_RECONCILE';
}
const queued = new WeakMap<SpecWorld, QueuedRetry>();
const uncertain = new WeakMap<SpecWorld, LocalModel>();
After(async function (this: SpecWorld) { await queued.get(this)?.fixture.close(); });

async function queueSuccessor(world: SpecWorld) {
  const fixture = new HostRetryFixture();
  try {
    const first = await fixture.pauseAfterFirstRetry();
    queued.set(world, { fixture, first, candidateRevision: fixture.context().candidate!.revision! });
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

Given('首条宿主续办已有确定回执且另一条续办正在排队', async function (this: SpecWorld) { await queueSuccessor(this); });
When('首条续办的负责人提交{string}', function (this: SpecWorld, output: string) {
  queued.get(this)!.fixture.resumeSynthesis(output === '无效协助' ? 'invalidHelp' : 'delivery');
});
Then('输出应得到{string}且首条命令的回执应保留', async function (this: SpecWorld, disposition: string) {
  const { fixture, first, candidateRevision } = queued.get(this)!;
  await hostUntil(() => fixture.context().trace, trace => trace.some(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED'));
  const c = fixture.context();
  if (disposition === '拒绝') {
    assert(c.trace.some(entry => entry.event === 'REJECTED' && entry.detail.endsWith(':SELF_DEPENDENCY')));
    assert.equal(c.candidate?.revision, candidateRevision);
  } else {
    assert.equal(c.candidate?.workId, first.workId);
    assert.notEqual(c.candidate?.revision, candidateRevision);
  }
  const operation = c.intents.find(work => work.id === first.workId)?.localOperations?.find(op => op.id === first.operationId);
  assert.equal(operation?.result?.ok, true);
  assert.equal(await fixture.runs(), 'once\n');
});
Then('第二条续办应进入自己的授权流程', async function (this: SpecWorld) {
  const { fixture, first } = queued.get(this)!;
  const approval = await fixture.approval();
  assert.equal(approval.args.at(-1), 'command-2');
  assert.notEqual(approval.approvalId, first.approvalId);
  assert.equal(await fixture.runs(), 'once\n');
});

Given('已保存的任务中旧批次已结束且新续办仍在排队', async function (this: SpecWorld) { await queueSuccessor(this); });
When('系统通过{string}检查该任务', async function (this: SpecWorld, entry: string) {
  const state = queued.get(this)!, f = state.fixture, saved = f.legacyRetiredBatch();
  if (entry === '服务恢复') {
    state.trigger = 'RECOVER';
    await f.restart(JSON.stringify(saved), () => f.resumeSynthesis());
  } else {
    state.trigger = 'HOST_RETRY_RECONCILE';
    f.service.engine.store.transact(f.room.id, tx => { tx.room.tasks[f.taskId] = saved.tasks[f.taskId]; });
  }
});
Then('应留下旧批次解除阻塞的记录并保留原候选', async function (this: SpecWorld) {
  const { fixture, first, trigger, candidateRevision } = queued.get(this)!;
  await fixture.approval();
  const c = fixture.context();
  const retired = c.trace.filter(entry => entry.event === 'HOST_RETRY_BATCH_RETIRED').map(entry => JSON.parse(entry.detail));
  assert.deepEqual(retired.map(entry => [entry.batchId, entry.trigger]), [[first.workId, trigger]]);
  assert.equal(c.candidate?.revision, candidateRevision);
  assert.equal(c.outcome, null);
});
Then('新续办应只安排一次并按原授权规则执行', async function (this: SpecWorld) {
  const { fixture, first } = queued.get(this)!;
  const approval = await fixture.approval();
  fixture.service.engine.tick(fixture.room.id);
  const c = fixture.context();
  const source = c.hostRetryRequests?.[1]?.sourceOperationId;
  assert.equal(approval.args.at(-1), 'command-2');
  assert.notEqual(approval.approvalId, first.approvalId);
  assert.equal(c.intents.flatMap(work => work.localOperations ?? []).filter(op => op.hostRetryOf === source).length, 1);
  assert.equal(await fixture.runs(), 'once\n');
  fixture.resumeSynthesis();
  assert.equal((await fixture.request(fixture.decisionData(approval, 'approve'))).status, 200);
});
Then('新回执交给负责人后的候选通过检查才可交付', async function (this: SpecWorld) {
  const { fixture, candidateRevision } = queued.get(this)!;
  await fixture.complete();
  const c = fixture.context();
  assert.equal(c.outcome, 'complete');
  assert.notEqual(c.publishedDelivery?.revision, candidateRevision);
  assert.equal(c.publishedDelivery?.revision, c.candidate?.revision);
  assert(c.intents.some(work => work.kind === 'check' && work.status === 'done' && work.requestCount === 1));
  assert.equal(await fixture.runs(), 'once\nonce\n');
});

Given('首条宿主续办的执行效果未确认且另一条续办正在排队', function (this: SpecWorld) {
  const m = retryWithQueuedSuccessor();
  startFirstRetry(m);
  assert(settleRetry(m, { uncertain: true }).ok);
  uncertain.set(this, m);
});
When('服务从已保存的未确认执行状态恢复', function (this: SpecWorld) {
  assert(uncertain.get(this)!.send({ type: 'RECOVER', config: localModelInput().config }).ok);
});
Then('应继续等待核对首条命令且第二条命令不得启动', function (this: SpecWorld) {
  const m = uncertain.get(this)!;
  assert.equal(m.snapshot.value, 'waitingHuman');
  assert.equal(retryOp(m).status, 'uncertain');
  assert.deepEqual(m.c.hostRetryRequests?.map(request => request.status), ['uncertain', 'pending']);
  assert(!m.c.intents.some(work => work.localOperations?.some(op => op.hostRetryOf === 'op2')));
});
