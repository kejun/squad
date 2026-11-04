import { describe, it } from 'vitest';
import { ActorModel, workNames, concurrentActors, stopActor, recoverActor, deniedActor, staleAttemptMessage, oldExecutionCleanup } from './task-actor-model-fixture.js';

describe('native transaction-local task and execution actors', () => {
  it.each(workNames)('[BT_N06] owns a one-use execution lifecycle for %s', name => { const m = new ActorModel(name); m.claim(); m.assertCreated(); });
  it('[BT_N07] preserves simultaneously live owner and discussion actors, global budget and one handoff', concurrentActors);
  it.each(['领取后尚未启动', '已提交启动许可', '外部效果未知'])('[BT_N08] stops safely at %s', stopActor);
  it.each(['未启动的执行', '安全请求执行中', '非幂等请求执行中', '没有子 actor 的旧快照'])('[BT_N09] deep-restores %s without reviving the old attempt', kind => { recoverActor(kind); });
  it.each(['重复启动', '旧尝试', '旧目标版本', '已停止', '尚未领取', '任务已结束', '恢复不兼容'])('[BT_N10] refuses %s without another budget charge', deniedActor);
});

it.each(["DELIVER", "WORK_FAILED", "CONSUME", "SETTLE", "REGENERATE_MODEL_OUTPUT", "INTERPRETATION_RESULT", "COORDINATE", "RECORD_RESULT", "CHECK_RESULT", "DISCUSSION_RESULT"])("[BT_N14] isolates old-attempt %s messages from the new execution", staleAttemptMessage);

it("[BT_N15] keeps the new execution cancellable after an old attempt ends", oldExecutionCleanup);
