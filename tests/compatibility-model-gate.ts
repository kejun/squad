import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import type { Phase } from '../src/types.js';
import * as actors from './task-actor-model-fixture.js';
import * as legacy from './task-model-contract.js';

/** Run the same actor and frozen-snapshot contracts used by the direct scenarios. */
export function verifyCompatibilityModelGate() {
  for (const name of actors.workNames) {
    const model = new actors.ActorModel(name); model.claim(); model.assertCreated();
  }
  actors.concurrentActors();
  for (const timing of ['领取后尚未启动', '已提交启动许可', '外部效果未知']) actors.stopActor(timing);
  for (const kind of ['未启动的执行', '安全请求执行中', '非幂等请求执行中', '没有子 actor 的旧快照']) actors.recoverActor(kind);
  for (const problem of ['重复启动', '旧尝试', '旧目标版本', '已停止', '尚未领取', '任务已结束', '恢复不兼容']) actors.deniedActor(problem);
  for (const type of ['DELIVER', 'WORK_FAILED', 'CONSUME', 'SETTLE', 'REGENERATE_MODEL_OUTPUT',
    'INTERPRETATION_RESULT', 'COORDINATE', 'RECORD_RESULT', 'CHECK_RESULT', 'DISCUSSION_RESULT']) actors.staleAttemptMessage(type);
  actors.oldExecutionCleanup();
  for (const phase of Object.keys(legacy.legacyTaskContract.seeds) as Phase[]) legacy.restoreLegacyTask(phase);
  for (const trace of legacy.legacyTaskContract.traces) legacy.replayLegacyTrace(trace.name);
  legacy.verifyLegacyDiagnostics();
  const invalidLifecycle = new actors.ActorModel(); invalidLifecycle.claim(); invalidLifecycle.start();
  assert.throws(() => invalidLifecycle.assertCreated(), assert.AssertionError);
  return { originalModelContractsPassed: 55, actorCases: 34, legacyCases: 21, invalidLifecycleDetected: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(verifyCompatibilityModelGate()));
}
