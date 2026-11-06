import assert from 'node:assert/strict';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { legacyTaskContract, replayLegacyTrace, restoreLegacyTask, verifyLegacyDiagnostics, businessSnapshot } from '../task-model-contract.js';
import { SavedTaskRecovery } from '../task-model-recovery-fixture.js';
import { persistTask, type TaskSnapshot } from '../../src/task.machine.js';
import type { Phase } from '../../src/types.js';
import type { SpecWorld } from './steps.js';

interface Case { phase?: Phase; trace?: string; snapshot?: TaskSnapshot; diagnostics?: ReturnType<typeof verifyLegacyDiagnostics>; recovery?: SavedTaskRecovery }
const cases = new WeakMap<SpecWorld, Case>();
const state = (world: SpecWorld) => { const value = cases.get(world); assert(value); return value; };
After(function (this: SpecWorld) { cases.get(this)?.recovery?.close(); });
Given('持有重构前保存的{string}任务快照', function (this: SpecWorld, phase: Phase) { assert(legacyTaskContract.seeds[phase]); cases.set(this, { phase }); });
When('使用当前任务模型恢复该快照', function (this: SpecWorld) { const s = state(this); s.snapshot = restoreLegacyTask(s.phase!); });
Then('任务身份、历史、阶段、预算和操作意图应完整保留', function (this: SpecWorld) { const s = state(this); assert(s.snapshot && s.phase); assert.deepEqual(businessSnapshot(s.snapshot), legacyTaskContract.seeds[s.phase]); });
Then('仅恢复快照不应调用模型或工具', function (this: SpecWorld) { const snapshot = state(this).snapshot!; const saved = persistTask(snapshot) as { children: Record<string, { src: string }> }; for (const child of Object.values(saved.children)) assert.equal(child.src, 'execution'); });
Given('重构前已记录{string}的受控执行轨迹', function (this: SpecWorld, trace: string) { assert(legacyTaskContract.traces.some(item => item.name === trace)); cases.set(this, { trace }); });
When('使用当前任务模型重放该轨迹', function (this: SpecWorld) { const s = state(this); s.snapshot = replayLegacyTrace(s.trace!); });
Then('每一步的阶段、结果、额度、回执和后继工作应与原契约一致', function (this: SpecWorld) { const s = state(this), trace = legacyTaskContract.traces.find(item => item.name === s.trace)!; assert(s.snapshot); const frame = trace.frames.at(-1)!; assert.equal(s.snapshot.value, frame.phase); assert.equal(s.snapshot.context.taskId, trace.input.taskId); assert.deepEqual(s.snapshot.context.usage, frame.usage); assert.deepEqual(s.snapshot.context.reply, frame.reply); });
Then('纯模型重放不应调用模型或工具', function (this: SpecWorld) { const saved = persistTask(state(this).snapshot!) as { children: Record<string, { src: string }> }; for (const child of Object.values(saved.children)) assert.equal(child.src, 'execution'); }); // The saved actors are native execution-state trackers; no provider/tool actor is registered.
Given('重构前已记录真实任务的转移规则与诊断轨迹', function (this: SpecWorld) { cases.set(this, {}); });
When('当前模型执行这些轨迹并采集诊断', function (this: SpecWorld) { state(this).diagnostics = verifyLegacyDiagnostics(); });
Then('未变更规则的身份、守卫顺序与自动微步应保持一致', function (this: SpecWorld) { const result = state(this).diagnostics!; assert.deepEqual(result.graph, result.expectedGraph); assert(result.comparisons.some(item => item.evidence.microsteps.length > 0)); });
Then('诊断快照应与同次纯转换结果一致', function (this: SpecWorld) { const comparisons = state(this).diagnostics!.comparisons; assert(comparisons.length > 12); for (const pair of comparisons) assert.equal(pair.inspectedDigest, pair.pureDigest); });
Given('{string}中保存了当前协议下尚未消费的核查结果', function (this: SpecWorld, storage: string) { cases.set(this, { recovery: new SavedTaskRecovery(storage) }); });
When('当前引擎恢复并由真实执行器继续处理', async function (this: SpecWorld) { await state(this).recovery!.resume(); });
Then('应保留原结果和预算且只安排一次负责人续办', function (this: SpecWorld) { state(this).recovery!.assertHandoff(); });
Then('重复恢复不应重复发言或越过领取调用外部适配器', async function (this: SpecWorld) { await state(this).recovery!.repeatAndComplete(); });
