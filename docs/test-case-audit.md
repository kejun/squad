# 现有测试用例规范审查（2026-10-30）

本页为历史审查。2026-11-06 按 BDD 唯一行为验收契约重新审计的完整清单、处置与验证见 [KEJ-100 测试审计](testing/kej-100/README.md)，当前规则以根目录 `AGENTS.md` 为准。

**结论：现有测试尚未全部符合 `AGENTS.md`。** 上一轮完成去重与分层；本轮以全部现有用例为检查范围，发现并修复实际验证缺口，同时保留尚待整改的结构问题。执行通过与规范符合分别记录。

## 检查范围与方法

- 扫描 `tests/` 下全部 **98 个 TypeScript 源文件**：40 个 Vitest 入口、31 个夹具/辅助/崩溃探针文件、27 个 BDD 文件。
- 对照运行报告，把全部 **378 个 Vitest 定义映射到 529 个展开用例**，每个用例均保留文件、行号、完整名称、执行结果和结构检查信号；没有仅筛选 `.unit.test.ts`。
- 编译全部 23 个 `.feature`：**314 个定义 / 617 个展开用例**。逐项对照 591 个已执行用例的步骤与绑定位置；26 个原有待验收用例继续列为待验收。
- 检查 FIRST、公共行为、单一行为、AAA/GWT、命名、依赖与清理、断言有效性、数据与夹具复杂度；结合异常信号复核调用到的辅助方法和执行路径。未将“入口没有直接 expect”视为没有断言，也未将“没有 if/for”视为合规证明。
- 真实 SQLite/HTTP/文件系统/进程边界、有界异步等待和有限模型轨迹按其验证目的审查；单元测试的隔离要求按实际依赖判断，不能用文件后缀或“集成”名称豁免。
- 当前源码不能证明历史上的 Timely/TDD 顺序，因此该项保留“无法由本轮审查确认”，不作事后认证。

逐用例索引：`reports/test-case-audit/case-inventory.json`。其中 `cases` 覆盖全部 Vitest 用例，`gherkin` 覆盖全部 Gherkin 展开用例，`definitions` 和 `bindings` 保留可定位的检查信号。索引中的结构信号是复核候选，不是自动判定违规。

## 已确认并修复的验证缺口

| 编号 | 原问题与依据 | 本轮处理与验证 |
| --- | --- | --- |
| A01 | 默认 `check` 只检查 BDD 类型，没有检查 Vitest 源文件。首次全量检查发现 8 处错误，采用仓库完整严格选项后另发现 2 处可选字段契约错误。涉及不完整的 WorkScope、测试回调返回快照、错误对象伪装与未知 payload 类型。 | 新增 `tests/tsconfig.json`，默认 `check` 检查所有测试及夹具；修复全部 10 处类型错误。替身遇到非预期网页操作会显式失败，错误断言直接验证 Promise 拒绝。 |
| A02 | BT_L06 的 Then 接收恢复策略却只检查 `verified`。临时副本把“保存前”的策略改成“错误恢复策略”，原绑定仍使 5/5 用例通过。 | 从真实恢复后的持久化状态读取策略，再与场景参数比较。原场景 5/5 通过；同一错误预期负对照变为 **1 失败 / 4 通过**，错误定位在策略断言。原 `.feature` 未修改。 |
| A03 | BT_L13 的安全断言放在 `if (!backend.available)` 内，宿主具备沙箱时不会执行“不降级到宿主”检查。BDD 共用检查也存在同样问题。 | 在外部依赖边界注入明确的缺失依赖，始终断言不可用、无 spawn、可信结算；另保留真实原生沙箱验收。 |
| A04 | “停止会中止活动适配器”只断言任务最终停止，既没有等待适配器启动，也没有断言 AbortSignal 实际到达。该名称承诺的中止行为可能未执行。 | 使用受控 Promise 等待适配器进入活动状态，监听并断言真实 abort 回调，再验证任务结算。 |
| A05 | 环境配置测试调用两次生产函数，并把敏感信息断言放在第二次调用的 catch 内；断言是否执行依赖第二次调用继续抛错。 | 改为一次调用的抛错与错误消息匹配，敏感信息检查不再依赖条件 catch；样本名称注明具体无效条件。 |
| A06 | CLI 失败夹具通过 `Object.defineProperty` 改写已构造宿主的只读 backend 字段，绕开已有依赖注入边界。 | 通过 `LocalRuntime.create` 已有的公开 backend 注入能力构造失败前提，不再改写宿主字段。 |
| A07 | Inspector 的协议断言失败时，只恢复原型 spy，未保证关闭观察器。 | 在 finally 内同时关闭观察器与恢复 spy，保证失败路径清理。 |

以上变更限于测试、夹具和检查入口，不改变产品行为；适用规则中的测试表达豁免，无需新增业务场景或状态。

## 仍不符合或需要明确处置的项目

### R01：单个测试混合独立行为

这些是已确认的结构问题，仍待拆分：

- `tests/core.test.ts`：BT_R01/BT_R02 在一个测试中分别构造显式负责人和默认负责人；BT_O03 同时构造“等待人类”和“长工具执行”两个独立系统。
- `tests/control-and-delivery.test.ts`：BT_F02 同时验证协助额度和重规划额度；BT_F05 混合缺失值与无限值；BT_F10 同时构造部分交付与失败两个独立任务。
- `tests/artifact-ui.test.ts`：BT_A08 同时验证短消息没有详情和长消息可达，两个输入分支应独立报告。
- `tests/task-debug-experience.unit.test.ts` 及 `task-debug-behavior.ts`：BT_V16 一个入口覆盖初始化、停止、拒绝与讨论领取；BT_V17 同时验证重试短路与重复停止；BT_V24 同时检查等待文案与上下文差异按 ID 对齐；BT_V25 同时检查预演失效和预算拒绝。**这四个已标为单元测试的用例仍不满足单一行为原则**，不能以入口没有控制流为通过依据。

同一行为具有多个必要断言、一次原子事务需比较多个结果，不属于本项问题。例如 actor 许可回滚同时比较父任务、子 actor 和外部调用次数，是同一个原子性契约。

### R02：测试主体中隐藏多组样本或选择预期

全量发现 **42 个定义 / 78 个展开用例**的测试主体包含循环或条件表达式。该数字包括合法接线与驱动逻辑，需要按目的区分；下列独立样本应改为具名参数化用例：

- `artifact-ui.test.ts` BT_A09：三类不可用历史目标放在一个循环内。
- `conversation-review.test.ts` BT_G06：否定、引用、代码等多类授权拒绝输入放在一个循环内。
- `model-env.test.ts`：五个成员的配置选择使用循环，失败不能直接由用例名称定位成员。
- `model-adapter.test.ts`：四类无效配置使用循环；HTTP 重试与不重试通过条件分支选择断言。
- `input-intent.test.ts` BT_I06：五个 if 根据字符串修改不同无效字段，应在样本准备中显式给出无效输入。
- `local-tools.test.ts` BT_L09：最终检查和后台讨论两种角色在单个循环中验收。
- `web-tools.test.ts` BT_W02/BT_M11：四种不合规工具参数在单个循环中执行整个流程。

有限调度驱动、HTTP 请求体流读取、遍历所有对外请求检查敏感信息、90 次布局转换与 144 种合法完成顺序，不能仅因包含循环删除；应放在职责明确的驱动中，提供失败路径标签与执行边界。`model-adapter.test.ts` 的恢复驱动使用无显式次数上限的 while，仍应改为有界驱动。

### R03：Gherkin 捕获值没有进入前提或断言

修复 BT_L06 后，仍有 **100 个步骤绑定**包含未使用捕获参数，涉及 **62 个已执行场景定义**：`control.steps.ts` 19 个、`domain.steps.ts` 43 个、`recovery.steps.ts` 3 个、`steps.ts` 35 个。

这是待逐项处置的信号，不能把 100 个绑定直接等同于 100 个功能缺陷。部分参数是 T1/G1/E1 等符号别名，应明确映射；业务数值、版本、目标成员与预期状态则必须实际进入准备或断言。例如 `control.steps.ts` 的“各已使用 {int} 次”忽略次数并固定构造四次消耗，“尝试第 {int} 次”也未校验序号，仍须整改。

另有四个原生宿主 Given 是空函数。已追踪对应 When：真实准备、操作和断言都在 `native-local-acceptance.ts`，因此不属于完全没有验证，但 GWT 的职责分离仍应整理，避免步骤名称与实际准备脱节。

### R04：时间、共享数据与层次边界

- `model-adapter.test.ts` 的两项受控传输截止测试仍使用真实 10/30 毫秒定时器和 1 秒兜底；`detail-actions-fixture.ts` 等待 1.1 秒检查下载清理。应评估可控时钟，不能因为整个文件还有 HTTP 或 DOM 用例就自动豁免所有时间依赖。真实 I/O 的有界状态等待仍有保留价值。
- `conversation-review.test.ts` 的 `sequence`、`detail-actions-fixture.ts` 的 `fixtureSequence` 是模块级可变标识计数器，应局部化到显式夹具。全量随机顺序复验通过，尚未观察到它们引起结果顺序依赖；这不等于共享可变数据已满足 FIRST。
- `helpers.ts` 静态导入 `team.config.ts`，后者在模块加载时读取 `.env`。这会把文件和环境依赖带入使用该辅助方法的快速领域测试，须将纯配置夹具与真实 dotenv 接线检查分开。真实环境加载测试本身应保留。
- `ui-style.test.ts` 与部分 SSR 检查依赖 CSS 选择器、类名或字符串结构；应分别确认它们属于有来源的设计契约还是可替换的实现细节，优先通过呈现语义或计算后的样式验证。冻结旧快照兼容性和公开诊断图规则则有明确持久化/诊断契约，不按内部细节一概删除。

## 全部 Vitest 入口逐文件记录

“控制流”统计直接测试主体，排除嵌套的受控适配器函数；0 不代表已经全面合规。所有文件均有逐用例索引。其余文件中的断言通过公共 API 或已追踪的模型驱动完成，本轮未发现与下列问题同等明确的额外验证漏洞。

| 文件（`tests/` 下） | 展开用例 | 有直接控制流的定义 | 审查结论/待办 |
| --- | ---: | ---: | --- |
| artifact-output.test.ts | 18 | 3 | 报告保存、回滚与恢复契约保留；样本选择/批量断言按 R02 整理。 |
| artifact-ui.test.ts | 7 | 1 | 历史隔离和安全渲染有实际断言；R01、R02、R04。 |
| background-discussion-web.test.ts | 2 | 0 | 两种真实并发/停止时序，由有界驱动与 Promise 门验证，保留。 |
| background-discussion.test.ts | 31 | 6 | 并行边界、失败与预算有实际断言；分支准备和有界驱动按 R02 整理。 |
| control-and-delivery.test.ts | 38 | 3 | A04 已修复；R01、R02。 |
| conversation-review.test.ts | 24 | 5 | A01 已修复；R02、R04。 |
| core.test.ts | 41 | 2 | 路由/权限/模型结果是公开契约；R01、R02、R04 的夹具依赖。 |
| detail-actions.test.ts | 6 | 0 | 有实际复制、内容隔离、导出与清理结果；R04 的夹具时钟/标识。 |
| discussion-debug.test.ts | 8 | 0 | 已追踪模型驱动内断言，公开图和模板行为具有契约依据。 |
| discussion-simulation.test.ts | 1 | 0 | 有界真实模型仿真，明确校验 144 个完成顺序和失败轨迹，保留。 |
| durability.test.ts | 16 | 3 | Memory/SQLite 回滚与进程恢复均有实际断言；存储和恢复样本按 R02 整理。 |
| input-intent.test.ts | 27 | 1 | 解析权限、保存和取消有实际断言；R02。 |
| inspector-bridge.unit.test.ts | 3 | 0 | A07 已修复；原型 spy 验证“不得启动业务 actor”的副作用边界，具有必要性。 |
| inspector-model.unit.test.ts | 18 | 0 | 受控事件与显式预期，验证公开交付意图；本轮未发现明确违例。 |
| inspector-window.test.ts | 4 | 0 | 实际 DOM/标签页控制器接线，公开端口替身与 finally 清理可追踪。 |
| local-operation-model.unit.test.ts | 39 | 0 | 合成回执与受控事件，公开预算、会话和恢复契约；辅助断言有实际执行。 |
| local-tools-durability.test.ts | 2 | 0 | 两个独有的服务启动核对分支，追踪到 SQLite 与真实执行器断言，保留。 |
| local-tools.test.ts | 6 | 1 | A03 已修复；R02 的角色样本仍待拆分。 |
| markdown.unit.test.ts | 6 | 0 | 公开渲染输出与安全检查；格式组合样本可继续细化，非空断言。 |
| model-adapter.test.ts | 28 | 4 | A01 已修复；R02、R04。 |
| model-env.test.ts | 15 | 2 | A05 已修复；R02、R04。 |
| model-regeneration.test.ts | 10 | 1 | 重试、停止、额度与拒绝有具体结果断言；不同能力的分支准备按 R02 整理。 |
| panel-layout-simulation.test.ts | 1 | 0 | 保留原 90 次有界矩阵，驱动逐步断言并注明输入。 |
| panel-layout.unit.test.ts | 12 | 0 | 显式边界样本与独立数据，公开布局结果；本轮未发现明确违例。 |
| panels.test.ts | 6 | 0 | DOM 拖拽、取消、焦点与保存的实际接线；保留。 |
| room-archive-model.unit.test.ts | 6 | 0 | 独立状态、版本与拒绝结果；部分组合路径可继续细化。 |
| room-archive.test.ts | 10 | 1 | SQLite/HTTP 隔离、继续执行与回滚有具体断言；拒绝样本按 R02 整理。 |
| skill-search-model.unit.test.ts | 6 | 0 | 受控额度、停止、版本、恢复与结果路径，纯输入夹具；本轮未发现明确违例。 |
| skill-search-web.test.ts | 1 | 1 | 真 HTTP/SQLite 的有界状态等待有必要性，fetch 替身在 finally 恢复。 |
| skills.test.ts | 11 | 1 | 搜索错误、额度和权限拒绝有结果断言；组合格式/执行流程可继续拆分。 |
| spec-coverage.test.ts | 5 | 0 | 通过实际子进程观察验收门禁拒绝/报告，是专门集成检查，保留。 |
| task-actor-inspector.test.ts | 1 | 0 | 追踪实际协议输出及不得启动/发送业务工作的边界断言，保留。 |
| task-actors.test.ts | 34 | 0 | A01 已修复；参数化原生 actor 模型验证有实际断言，旧快照为显式兼容性夹具。 |
| task-debug-experience.unit.test.ts | 5 | 0 | R01：四个单元用例的被调辅助方法仍混合独立行为。 |
| task-debug.test.ts | 19 | 1 | A01 已修复；HTTP/SQLite/DOM 与模型行为混合，日志等独立职责仍可拆分。 |
| task-inspection.unit.test.ts | 6 | 0 | 比较公开诊断结果与同次模型结果，独立路径清晰；本轮未发现明确违例。 |
| task-model-refactor.test.ts | 21 | 0 | A01 已修复；冻结持久化与诊断 API 契约有需求依据，保留。 |
| ui-style.test.ts | 7 | 3 | 专门设计检查；R02、R04。 |
| web-tools.test.ts | 21 | 2 | A01 已修复；R02 的四种不合规参数仍在一个循环中。 |
| web.test.ts | 7 | 1 | A01 已修复；真实 HTTP 完整流程与有界等待可保留，组合流程可继续按行为拆分。 |

## 实跑结果与复验

- `npm run check`：全仓库及全部测试/夹具类型检查通过；**529/529 Vitest、591/591 Gherkin 通过**；覆盖门禁通过。
- `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --sequence.shuffle --sequence.seed=20261030 --reporter=json --outputFile=reports/test-case-audit/shuffled.json`：**529/529 通过**。这是一次随机顺序观察，不证明所有顺序都正确。
- BT_L06 正例与错误预期负对照分别保存在 `reports/test-case-audit/mutations/positive.json` 和 `after.json`；治理前的错误预期通过记录为 `before.json`。
- `node reports/test-case-audit/inventory.mjs`：重新生成全部用例索引；每个 Vitest 用例必须唯一匹配源码定义，每个已执行 Gherkin 样本的步骤与运行报告必须相同，否则生成失败。
- 数量口径补充：Cucumber JSON 的 **12,642** 项包含 hooks；其中实际 Gherkin 文本步骤为 **2,595**。上一轮报告的“步骤”数量应按“步骤与 hooks 合计”理解。

原始源码快照、类型检查错误、运行报告、索引脚本和负对照保存在 `reports/test-case-audit/`，沿用仓库的报告忽略规则。本页保存全量审查范围、确认缺口、修复证据和仍待治理的项目，不以减少测试数量作为本轮目标。
