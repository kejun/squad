# 技能资料读取的交付证据（BT_F22）

真实网页订单对账复现：A/B 已通过 loadSkill/readSkillResource 读取合成源数据，但交付检查收到的 evidence 为空，以“没有读取回执”拒绝。根因为 src/task/evidence.ts 仅收集 runCli。

按场景→状态图→模型测试→纯证据投影→接线验证顺序修复。不增加调度或状态；当前目标已结算技能资源读取加入交付证据，保存来源、成员、版本和页内容摘要。失败、缺失正文和分页不能作为完整来源，旧目标排除，固定后正文变化拒绝检查。

验证：新增五项真实 XState 测试，修复前四项因来源缺失失败；修复后相关模型层 42 项通过。真实 SkillRegistry 文件读取与 WorkRunner 接线测试通过，相关集成/适配器共16项通过。BT_F22 单独执行1场景35步骤通过。生产与测试 TypeScript 检查通过。

完整 npm run check：Vitest 60文件761项通过；Gherkin 706场景中700通过6失败，其中原生沙箱两项明确为 Required OS namespaces are unavailable，其余四项既有 CLI 步骤超过5000ms。未放宽超时或断言，不声称整库检查通过。完整输出位于 /workspace/squad-ui-acceptance/evidence/check.log。

真实网页复验已看到检查接收 readSkillResource 回执，缺失证据问题消失；该复杂业务任务仍因 B 未完成实际核查而 partial，不算真实任务成功。合成对账产物错误与模型只回复进度的问题继续单独诊断。此提交不声称解决模型推理质量或完成3次复杂任务。

## UI follow-up: interpretation protocol leakage (BT_I22)
The procurement revision in real UI copied the shared `replacesArtifactId` execution instruction into user constraints. The subsequent checker could not verify the internal metadata, producing a partial result despite corrected content. The adapter now excludes artifact execution instructions from interpretation work and explicitly limits extraction to direct user requirements; owner instructions remain intact. No new state or scheduling path.
Before implementation: `env -u MODEL_API_KEY npx vitest run tests/input-intent.test.ts --maxWorkers=1` passed 27 existing model/engine paths. Targeted BT_I22 first failed on the leaked field, then passed 1 scenario / 33 steps. Input-intent and delivery-check adapter regressions passed 36 tests. These scripted regressions are not real-task successes. Previously persisted interpretations are retained, not silently rewritten.
