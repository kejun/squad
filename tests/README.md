# 测试分层与运行

| 层次 | 范围 | 命令 |
| --- | --- | --- |
| 补充单元验证 | 仅限通过根目录 `AGENTS.md`「准入与评审记录」的验证形态；公开 API、纯函数或隔离渲染本身不构成准入理由。 | `npm run test:unit` |
| 扩展模型验证 | `task-actors.test.ts`、`task-model-refactor.test.ts`、`discussion-debug.test.ts`、`discussion-simulation.test.ts`、`panel-layout-simulation.test.ts`：原生 actor 与旧快照契约、有限轨迹回放或枚举；旧契约读取固定 JSON 夹具，仿真不调用真实适配器。 | `node node_modules/vitest/vitest.mjs run tests/task-actors.test.ts tests/task-model-refactor.test.ts tests/discussion-debug.test.ts tests/discussion-simulation.test.ts tests/panel-layout-simulation.test.ts --maxWorkers=1` |
| 集成、组件接线与专门检查 | 其余 `*.test.ts`：Engine/Store/Runner 协作、受控模型适配器、SQLite、真实 HTTP/文件系统/进程、DOM 接线、样式和验收门禁。不得仅因为较慢而删除。 | 包含在 `npm test` 中 |
| Gherkin 验收 | 所有未登记验收缺口的 `.feature` 展开用例，自动发现并执行；部分真实接线流程只保留此处的入口，避免在完整验证中重复执行同一验收函数和输入。 | `npm run test:bdd` |
| 完整检查 | 类型检查、全部 Vitest、全部可执行 Gherkin 和覆盖报告；单元测试筛选不会影响此入口。 | `npm run check` |

产品行为以直接执行的中文 Gherkin 为唯一验收契约。单测准入、禁止事项及评审记录以根目录 `AGENTS.md` 为准；新增或扩充单测前先核对场景、大纲、步骤和夹具。

共享夹具和相同编号均不能单独证明重复或独立价值。逐项核对前提、操作、断言和时序；删除前先让承接场景直接执行并检出原保护的回归。真实接线和有限轨迹枚举按其验证边界保留。XState 实现前门槛可独立运行场景的纯模型驱动，具体入口见 [KEJ-100 审计与模型命令](../docs/testing/kej-100/README.md)。

单元测试数据通过显式工厂创建；参数化测试为每个样本独立创建状态。有界矩阵枚举放在具名仿真驱动中，例如 `panel-layout-simulation.ts` 的 90 次拖拽转换。不得使用批量循环在单个单元测试中隐藏独立失败分支。

`test:unit` 允许准入筛选后没有单测文件；存在文件时仍完整运行并传播断言失败。完整 `check` 的 Vitest、Gherkin、类型与覆盖门禁不受此空集合处理影响。

随机顺序复验：`npm run test:unit -- --sequence.shuffle --sequence.seed=20261030`。随机种子用于复现执行顺序，业务时间和返回数据仍受控，不以真实耗时断言保证 FIRST。

当前清理的基线、逐用例处置及前后覆盖见 [KEJ-100 测试审计](../docs/testing/kej-100/README.md)。2026-10-30 的历史结果保留在 [测试治理记录](../docs/test-governance.md)。

全部现有用例的规范审查见 [全量测试审查](../docs/test-case-audit.md)。文件后缀只是运行入口，不能作为符合 FIRST、AAA 或单一行为原则的证明。默认 `check` 通过 `tests/tsconfig.json` 检查所有 Vitest、BDD 和夹具的类型。

## 检查进程时限

完整检查直接串联各阶段，不再对嵌套的整套测试重复套用 60/90 秒总时限。Vitest 和 Gherkin 各自保留框架的单例/步骤时限，另有 60 秒无输出时限和独立的 5 分钟硬时限；持续输出也不能绕过硬时限。类型检查与覆盖报告仍保留 90 秒硬时限。

这不是测试成功条件的放宽：755 个既有 Vitest 用例的分层基线合计约 96 秒，已超过旧的 60 秒整套时限；约 705 个 Gherkin 场景也在持续执行时被截断。5 分钟给串行全套留下运行余量，无输出时限仍能更早报告卡住的阶段。失败状态与 JSON 报告原样保留，不跳过环境相关失败。

超时或中断后先发 SIGTERM，最多等待 1 秒再发 SIGKILL。在 POSIX 上以独立进程组清理子孙进程，避免只杀外层包装器；Windows 使用 Node 的直接子进程终止能力，不宣称提供 POSIX 进程组隔离。回归入口：`node node_modules/vitest/vitest.mjs run tests/check-runner.test.js --maxWorkers=1`（真实进程集成测试，不属于单元测试）。

依据：[Node 子进程的 detached/进程组语义](https://nodejs.org/api/child_process.html#optionsdetached)和 [spawnSync 超时限制](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)。同步超时仅发送终止信号，子进程若处理 SIGTERM 后不退出，调用仍可能一直等待；异步监督可以在宽限期后升级终止。
