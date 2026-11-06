# 技能资料读取的交付证据（BT_F22）

真实网页订单对账复现：A/B 已通过 loadSkill/readSkillResource 读取合成源数据，但交付检查收到的 evidence 为空，以“没有读取回执”拒绝。根因为 src/task/evidence.ts 仅收集 runCli。

按场景→状态图→模型测试→纯证据投影→接线验证顺序修复。不增加调度或状态；当前目标已结算技能资源读取加入交付证据，保存来源、成员、版本和页内容摘要。失败、缺失正文和分页不能作为完整来源，旧目标排除，固定后正文变化拒绝检查。

验证：新增五项真实 XState 测试，修复前四项因来源缺失失败；修复后相关模型层 42 项通过。真实 SkillRegistry 文件读取与 WorkRunner 接线测试通过，相关集成/适配器共16项通过。BT_F22 单独执行1场景35步骤通过。生产与测试 TypeScript 检查通过。

完整 npm run check：Vitest 60文件761项通过；Gherkin 706场景中700通过6失败，其中原生沙箱两项明确为 Required OS namespaces are unavailable，其余四项既有 CLI 步骤超过5000ms。未放宽超时或断言，不声称整库检查通过。完整输出位于 /workspace/squad-ui-acceptance/evidence/check.log。

真实网页复验已看到检查接收 readSkillResource 回执，缺失证据问题消失；该复杂业务任务仍因 B 未完成实际核查而 partial，不算真实任务成功。合成对账产物错误与模型只回复进度的问题继续单独诊断。此提交不声称解决模型推理质量或完成3次复杂任务。

## UI follow-up: interpretation protocol leakage (BT_I22)
The procurement revision in real UI copied the shared `replacesArtifactId` execution instruction into user constraints. The subsequent checker could not verify the internal metadata, producing a partial result despite corrected content. The adapter now excludes artifact execution instructions from interpretation work and explicitly limits extraction to direct user requirements; owner instructions remain intact. No new state or scheduling path.
Before implementation: `env -u MODEL_API_KEY npx vitest run tests/input-intent.test.ts --maxWorkers=1` passed 27 existing model/engine paths. Targeted BT_I22 first failed on the leaked field, then passed 1 scenario / 33 steps. Input-intent and delivery-check adapter regressions passed 36 tests. These scripted regressions are not real-task successes. Previously persisted interpretations are retained, not silently rewritten.

## Migration onto PR #36 main

The combined source patch includes a982ecf, e9cdced and their working-tree follow-ups. Its SHA-256 is 9337a9702756ecdae8e8ce30c59cc4719e234ee2aedc6d850e16a1374a17bd0f. All 26 reconstructed source files matched the source manifest before integration onto d06af677a676b7c102763e44b0d7f7f423685481. Both sides of the README and state-diagram additions were preserved; the adapter merged with PR #36's discovery and parallel-work instructions.

The source environment subsequently reported three consecutive successful real-model tasks. Those runs are historical source evidence and were not repeated during migration. The earlier partial-task notes above describe earlier development stages, not the final source test streak.

Integration exposed two regressions and added focused red/green coverage:

- BT_F22: importing Node crypto into the shared state model broke the browser build. Complete resource evidence now uses the SHA-256 already verified by SkillRegistry and separately freezes exact content and receipt metadata. Any change, including equal-length body edits, invalidates the reference. Paged reads do not mislabel a whole-file hash as a page hash. Legacy skill references without the frozen snapshot fail closed; CLI references retain their existing contract.
- BT_M31: diagnostic feedback coerced an object-valued status and could throw before bounded format repair. The diagnostic now checks its type without coercion; a synthetic assistance response proves exactly one repair and no rejected-value echo.

The clean main baseline passed build and 808 Vitest tests. Its BDD run passed 722 of 724 scenarios; the two native-sandbox cases were blocked by unavailable OS namespaces. The first integrated run passed 821 Vitest tests and 731 of 733 BDD scenarios with the same two environment failures. These counts precede the final integration fixes and are not a claim that the final aggregate gate passed.
