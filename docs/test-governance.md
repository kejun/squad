# 测试治理记录（2026-10-30）

后续对全部现有测试及夹具的规范审查见[全量测试审查](test-case-audit.md)，包含尚未符合规则的项目。以下保留首轮去重与分层的实跑记录。

本次只修改测试、测试运行入口和说明，不改变产品行为，适用 `AGENTS.md` 的测试表达豁免；不新增 Gherkin 场景或业务状态。

## 基线与取舍

治理前在当前工作区实跑：43 个 Vitest 文件、558 个用例全部通过；591 个 Gherkin 展开用例全部通过。原始结果和源码快照保存在 `reports/test-governance/before/`，不以 Git HEAD 代替本次治理前的工作区基线。

按行为契约决定保留或删除，不以减少用例数、行数或覆盖率为目标：

- 删除参数没有参与行为的重复样本、断言未被调用对象没有变化的无效检查，以及已由默认 Gherkin 执行完全相同验收函数和输入的 Vitest 包装。
- 改写仍有价值的单元测试：拆开独立行为，用具名参数化样本定位失败，消除测试主体中的循环、条件判断、私有对象身份断言和无关数据。
- 纯单元测试使用 `.unit.test.ts` 后缀，提供独立运行入口。真实 SQLite、HTTP、文件系统、进程和 DOM 接线测试保留在完整验证中；有界路径枚举和旧快照兼容性回放单独说明，不把它们算作毫秒级单元测试。
- 不删除 `.feature`、验收函数、旧快照或验收缺口，不增加跳过标签。状态机层模型验证仍独立可运行，具体接线由集成测试与 Gherkin 验证。

## 删除项的行为承接

| Vitest 重复项 | 保留的执行与边界 |
| --- | --- |
| `native-local-tools.test.ts`，4 个包装用例 | `tests/bdd/native-local-tools.steps.ts` 直接执行同一验收函数，覆盖 BT_L19–L22。 |
| `local-tools-durability.test.ts`，45 个包装用例 | `tests/bdd/local-tools.steps.ts` 直接执行相同验收函数和对应样本，覆盖 BT_L01、L03–L06、L08–L12、L14–L15、L17–L18；保留仅由 Vitest 验证的两个服务启动核对分支。 |
| `local-tools.test.ts`，7 个角色流程包装 | BT_L02 的七行 Gherkin 样本使用同一 `LocalFixture.flow` 和 `assertFlow`；其他独有的文件内容、安全边界断言保留。 |
| `task-actor-integration.test.ts`，6 个包装用例 | `tests/bdd/task-actors.steps.ts` 使用同一夹具完成 Memory/SQLite 的许可回滚、执行器、旧尝试取消验证，覆盖 BT_N11、N12、N15。 |
| `task-model-recovery.test.ts`，2 个包装用例 | BT_N05 的两个存储样本直接执行同一恢复夹具及全部结果断言。 |
| `room-archive-ui.test.ts`，1 个包装用例 | BT_G21 执行同一网页夹具的失败、重试、查看与恢复流程；同时移除该包装对总请求次数恰为四次的额外实现约束。 |
| `background-discussion-web.test.ts`，3 个包装用例 | BT_T12 直接执行默认 discussion-first 路径，BT_T16、T17 分别执行同一隔离与拒绝领取函数；保留额外的 owner-first 和停止时序。 |
| `task-debug-experience.test.ts`，6 个重复验收入口 | BT_V19–V23、V26 的直接 Gherkin 绑定保留同一准备、操作与断言；其余纯模型行为单独保留。 |

重构前的整机快照契约、实际 actor 的版本隔离、停止和恢复、预算与已保存结果的原子交接仍保留。断言诊断 API 输出的守卫、规则与自动微步属于该调试产品的公开行为，不按“内部实现”删除。

以上合计删除 **74 个重复包装用例**。另外清除或改写：Inspector 模型中未被使用的“加载前/后”参数；技能来源字符串没有参与来源解析的重复模型样本；归档模型中从未传入归档操作的 task 对象及其不变断言；快照的 `.machine` 引用身份断言；与冻结旧模型诊断轨迹重复的批量回放；Markdown 代码块的 CSS 类名断言。真实来源解析、归档期间任务继续、全轨迹兼容性和 Markdown 安全行为仍分别由适配器、实际引擎、冻结契约及渲染测试验证。

## 当前单元测试入口

下表保留治理前后的入口对应，便于从历史验证文档找到当前命令。数量是 Vitest 展开后的用例数；治理前的文件含混合验收流程，不把这些旧用例全部统计为单元测试。

| 原文件（`tests/` 下） | 当前文件 | 用例数变化 |
| --- | --- | --- |
| `inspector-bridge.test.ts` | `inspector-bridge.unit.test.ts` | 3 → 3 |
| `inspector-model.test.ts` | `inspector-model.unit.test.ts` | 8 → 18 |
| `local-operation-model.test.ts` | `local-operation-model.unit.test.ts` | 15 → 39 |
| `markdown.test.ts` | `markdown.unit.test.ts` | 6 → 6 |
| `panel-layout.test.ts` | `panel-layout.unit.test.ts` | 4 → 12 |
| `room-archive-model.test.ts` | `room-archive-model.unit.test.ts` | 6 → 6 |
| `skill-search-model.test.ts` | `skill-search-model.unit.test.ts` | 7 → 6 |
| `task-debug-experience.test.ts` | `task-debug-experience.unit.test.ts` | 11 → 5 |
| `task-inspection.test.ts` | `task-inspection.unit.test.ts` | 4 → 6 |

本地操作的八种拒绝、停止阶段、崩溃窗口、权限撤销和不兼容回执改为独立参数化用例；预期拒绝码显式给出，测试不再根据实际返回分支选择断言。Inspector 的可信来源、重复握手、关闭后事件、弹窗阻止和销毁后事件分别报告失败。面板原有的 **90 次连续拖拽转换**完整保留在 `panel-layout-simulation.ts` 驱动和 `panel-layout-simulation.test.ts` 中，未用少量边界样本替代整个矩阵。

## 执行结果

Node.js **v24.20.0**、Vitest **3.2.7**、`maxWorkers=1`。治理前后均在本机当前工作区实跑；耗时为单次观察，包含进程启动和模块收集，不作为稳定性能基准。

| 指标 | 治理前 | 治理后 | 变化 |
| --- | --- | --- | --- |
| Vitest 文件 | 43 | 40 | −3 |
| Vitest 展开用例（全部通过） | 558 | 528 | −30（约 5.4%） |
| Vitest 墙钟耗时 | 45.42 秒 | 24.76 秒 | 本次约减少 45.5% |
| 独立单元测试入口 | 无 | 9 文件 / 101 用例 | `npm run test:unit` |
| 上表 9 个入口源码中的循环节点 | 18 | 0 | 不包括独立仿真驱动和共享夹具 |
| 上表 9 个入口源码中的条件/分支节点 | 24 | 0 | TypeScript AST 统计 if、条件表达式和 switch |
| 直接执行的 Gherkin 用例 | 591 | 591 | 名称、标签、步骤文本及通过状态逐项一致 |
| 直接执行的 Gherkin 步骤 | 12,642 | 12,642 | 不变 |
| 已登记待验收用例 | 26 | 26 | 沿用原来的 18 个定义，未新增排除 |

74 个重复入口被删除，同时将批量分支展开为独立可定位的用例，所以用例总数净减少 30。回归关联到的 Gherkin 定义由 258 个变为 243 个；这是重复 Vitest 关联减少，全部 296 个可自动执行定义仍由 Gherkin 直接执行。这里统计的是实际场景执行范围，没有采集语句或分支代码覆盖率。

实跑命令及结果：

- `npm run test:unit -- --reporter=json --outputFile=reports/test-governance/after/unit.json`：**101/101 通过**；测试主体累计 211 毫秒，单例最长 **15.63 毫秒**，含启动与收集共 2.23 秒。
- `npm run test:unit -- --sequence.shuffle --sequence.seed=20261030 --reporter=json --outputFile=reports/test-governance/after/unit-shuffle.json`：**101/101 通过**；单例最长 28.19 毫秒。
- `node node_modules/typescript/bin/tsc --noEmit --module ESNext --moduleResolution Bundler --jsx react-jsx --esModuleInterop --skipLibCheck --strict --target ES2022 --lib ES2022,DOM,DOM.Iterable tests/*.unit.test.ts`：通过。
- `npm run check`：前端、后端和 BDD 类型检查通过；**528/528 Vitest、591/591 Gherkin、12,642/12,642 步骤通过**；覆盖门禁通过。
- `git diff --check`：通过。未新增 skip/todo 或手工执行白名单，默认完整入口仍发现全部测试。

原始 Vitest、Cucumber、前后测试源码快照、完整检查日志和统计在 `reports/test-governance/`，汇总为 `summary.json`。这些产物按仓库现有规则被 Git 忽略，本页保存可审阅的统计与删除依据。首次完整检查发现清理导入时误删了仍在使用的 `assertFlow`，已恢复该导入并重跑上述完整检查通过；没有删除失败用例。
