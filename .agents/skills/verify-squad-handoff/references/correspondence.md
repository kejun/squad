# 实现对应、投影和边界

KEJ-100 依赖审查：`c1f380da1527b8c22a8aaaaf7aef10cd2695146e`，仅空单测集合的 CLI 处理变化；无产品转移、守卫、事务或模型变更。当前审查及完整复跑证据见 [drift-review-kej-100.json](drift-review-kej-100.json)。以下保留 PR40 的产品源码审查。

## 为什么选择这个目标和工具

用户需要 B 的核查结果交回 A 继续完善方案。已有网页验收能确认一条成功路径；这里检查保存结果以后，消费、重复送达、停止、换目标、提交失败与重建宿主的顺序。该问题是有限协议交错，采用可用 Java CLI 运行的 TLA+/TLC；不引入 Lean 的无限域证明，也不声称有直接证明任意 TypeScript 的工具。

## 可达起点

`compare.mjs:setup` 从空存储调用 `TeamEngine.submit`，领取 A 意图，携带真实 workId/fence 发 HELP，领取 B 意图，再携带 B 的 workId/fence 发 RECORD_RESULT。此时 H1=answered，R1.consumed=false，B 工作已结算，没有其他在途工作。没有向 SQLite 或状态机内部注入预期状态。

## 状态投影

| 模型变量 | 真实观察 |
| --- | --- |
| marker | `context.results[R1].consumed`，包括已交接或被归档 |
| consumed | `context.consumedResults.includes('R1')`，只表示逻辑交接 |
| resumes | 全部 owner 意图中 `payload.resultId==='R1'` 的数量，包含后来取消的历史意图 |
| live | 上述意图中是否仍有 pending/inflight |
| answers | H1 对应的 B answer 消息数量 |
| helpLive | H1 是否仍 pending/running/answered |
| stopped/epoch/goalVersion | 对应 context 字段；保存结果原 fence 固定为 1/1 |
| online | 测试调度器是否保有可调用的 TeamEngine |
| crashed/rolledBack | 本轮故障预算的测试调度器记账，不冒充产品字段 |

`marker=true` 不等于成功交接：停止或过期结果可能被归档，但 consumed=false。模型明确区分，未为了通过而放宽原子交接。

## 动作与事务边界

| 模型动作 | 真实入口与对应实现 |
| --- | --- |
| Init | 上述正常前缀；`TeamEngine.submit/claim/send`、`startHelp`、`reduce:RECORD_RESULT` |
| Flush | `TeamEngine.flushResults` 内的一个 transact；`HELP_RESULT` → `acceptHelpResult` → `owner` |
| Direct | `TeamEngine.send(HELP_RESULT)` 的一个事务；与直接事件/超时回传共用校验，但本次 status 固定 success |
| RetrySaved | `TeamEngine.submit(intent='retry')`；`assistanceRetryProblem`、`savedHelpResult`、`acceptHelpResult` |
| DuplicateRecord | 同一 R1、相同 workId/fence、不同事件身份的 `send(RECORD_RESULT)`，必须保持投影 |
| Stop | `send(STOP)`；`reduce:STOP`、`cancelWork`、stopping 的自动结算 |
| Continue | `submit(intent='continue')`；`reduce:CONTINUE`，epoch 增加，原 H1 失效 |
| ChangeGoal | `send(USER_INPUT)` 携带新 goal；goalVersion 增加、旧协助取消、BOUNDARY 可安排非 R1 的工作 |
| Crash | 丢弃引擎引用，保留已提交存储；是进程丢失的抽象，非故障注入到 SQLite 中间写入 |
| Rollback | `failNextCommit=true` 后执行真实 flush；必须抛出注入错误且整个持久 room JSON 与之前相同；引擎进入 storageFault |
| Reopen | SQLite 关闭/重开连接，重建 TeamEngine，再单独 `send(RECOVER)`；不偷偷合并 flush |

`TeamEngine.recover` 本身包含多个事务以及 flush 循环，模型将它们拆开。`SqliteStore.transact` 的 BEGIN IMMEDIATE、snapshot/outbox 写入、COMMIT/ROLLBACK 是原子性的代码依据；MemoryStore 只提交克隆后的结果。投影不覆盖 receipt 明细、时间戳、摘要和其他用户消息，但需要审查它们变化是否会影响本次协议。

## 覆盖源码

- `src/task.machine.ts` 及 `src/task/*.ts`：组合入口，facts/policy 的版本与权限校验，assistance 的原子消费与重试，operations 的 owner/cancelWork，reducer 的结果/停止/继续/目标/恢复分支，以及 guards/lifecycle 的 XState 守卫与自动边界。
- `src/engine.ts`：transact、receipt、send、submit 的保存结果重试、claim、flushResults、recover 的事务拆分。
- `src/store.ts`：两种存储的 transact/read；SQLite 注入故障点和回滚。
- `src/runner.ts`：runOne 最前面的 flushResults 调度入口；本次不运行模型/工具适配器。
- 关联契约/确定配置：`src/types.ts`、`src/model-config.ts`、`src/assistance-retry.ts`、`src/presentation.ts`、`src/conversation.ts`、`src/model-env.ts`、`src/index.ts`、`team.config.ts`，以及 package.json/lock 的依赖漂移门禁。

规格参考：BT_D04–BT_D06、BT_C02、BT_H11/BT_H12/BT_H15；以实际 `features/06_durability.feature`、`05_human_control.feature`、`13_assistance_retry.feature` 为准。持久化原规格仍明确要求 Pi Durable，不能拿本 SQLite 模型宣称 Pi Durable 接入或原 Cucumber 场景全量通过。状态图参考 `docs/state-diagrams.md`「协助重试与结果交接」。

## 对应检查能说明什么

TLC 导出有限图；BFS 为每个源状态选一条最短前缀，再重放该状态的每条有标签出边。每步比较所有投影变量，并检查真实行为不变量；MemoryStore 和 SQLite 分开执行。默认模型146个状态、424条有标签迁移，对应两种存储共848条边回放。原始 TLC 报告还包含425次状态生成，计数不要混淆。

这是有限迁移的执行对应检查，不是自动 refinement/等价证明：同一抽象状态的其他具体历史未逐一回放，未证明投影是充分统计量。代码映射、sync commit、源码哈希是人工审查的记录与门禁，不能替代审查。真实源码负对照不改基线模型或图，仍必须被行为断言检测；因此模型继续通过不能掩盖这些变体，但也不能宣称能检测所有实现错误。

## 活性、见证和负对照

Progress 在有限故障预算、恢复及 Flush 弱公平假设下检查。模型的任意 stuttering 与重复投递也参与无限行为检查；不是只看最后一张成功状态。六个可达性见证必须分别得到明确的不变量反例。RunnerProgress 实际验证 `runOne` 先处理有效 R1：正常一次推进；跳过该入口的副本连续五次空转且保持同一静止状态。这个具体探针仍不是任意 TypeScript 执行的活性证明。

四个负对照分别在 MemoryStore 和 SQLite 独立执行，检查持久标记、重复续办、停止取消、工作器遗漏消费。删标记会使普通 flush 拒绝提交；先记录该入口的前后状态，再通过显式重试保存结果的入口观察真实半成功。这两条入口的不同提交守卫必须保留，不能把一个入口的失败理由错误地套到另一个上。模型的 drop-marker 分支也保留 flush 的拒绝提交守卫。

## 未覆盖

不覆盖结果到达之前的外部调用、从失败状态重新执行 B、多个结果/任务/成员评审队列、已领取 A 的执行与模型交付、预算耗尽、权限撤销、错误配置恢复、真实模型/工具、Pi Durable、操作系统进程竞争或无限崩溃。没有用 state constraint 截断可达图；边界来自建模域和故障预算。Deadlock 检查关闭，因为调度停顿/终止在此切片合法；Progress 独立检查所需的进度。

SQLite close/reopen 是本轮的进程丢失替身：未强制终止 OS 进程，也未测试磁盘断电。TLC 只检查提交前/后状态，依赖底层事务原子性；回滚探针不构成数据库或文件系统的形式化证明。

## 2026-10-30 职责拆分对应审查

审查起点为 `06be10113d80a8e884d93b9e3c6d5877143bf2c7`，目标为当前工作区（HEAD `b3502f`）。本次之前积累的输入解析、后台讨论、本地工具、观察器与群聊归档也纳入漂移审查；不能把冻结的重构基线误作该旧提交的等价证明。

| 变化 | 对有限交接切片的影响与核对依据 |
| --- | --- |
| `task.machine` 拆分 | 58 个领域声明与改动前 `dd5ec71b…` 的 AST 源文本逐个一致（仅新增 export）；配置中的八个阶段、守卫/动作名字和顺序不变。冻结的八种快照、十二条真实事件轨迹与诊断全部通过；这是有限回归，不是任意输入的等价证明。 |
| 模型消费与续办 | `acceptHelpResult`、`savedHelpResult`、`assistanceRetryProblem` 和 `fresh` 相对旧同步提交保持函数体一致。迁移至 assistance/facts；`owner` 新增输入、讨论和本地执行等待条件，形式化前缀没有这些未决状态。 |
| 模型停止、继续、换目标与恢复 | 新增讨论取消、输入分析及本地操作处理；本切片无讨论/本地子操作，空模型配置令输入由规则直接解析为 resolved。停止仍取消 pending owner，继续仍递增 epoch；换目标仍递增 goalVersion 并取消协助；RECOVER 与 flush 分属事务。相关分支按旧同步提交逐项比较。 |
| 引擎 | 观察器只在配置后采集，回调在提交后发送；形式化引擎无观察器。归档是独立命令、共用 receipt 事务但不改变任务；新增本地租约与讨论领取分支不在本切片触发。send/submit/claim/flush/recover 的持久化与失败原子边界保留。 |
| 存储 | 新增 archive 可选字段及 workspace_leases；snapshot 与 receipt 仍在相同 SQLite BEGIN/COMMIT/ROLLBACK 内；MemoryStore 仍先复制、成功后提交。回滚故障位置保持在提交前。 |
| 执行器 | runOne 仍先 flushResults，之后才领取并执行；选择具体意图、解释/讨论/本地工具分支均不影响本切片不领取续办的探针。starve-flush 负对照保留。 |
| 类型、配置与命令识别 | 新增字段及输入/讨论种类；createTeamConfig({}) 无 models，既有 A/B、额度及版本保持；新增自然语言控制不改变明确 retry/continue 提交的含义。conversation 新识别讨论，形式化普通文本无评审目标。 |
| 依赖与导出 | XState 仍为 5.33.3；新增 sandbox-runtime、inspect、yaml、zod 等依赖及 index 导出不改变有限协议。新增纯模型依赖、诊断/房间模块和执行器读取边界一并加入源码哈希门禁。 |
| 负对照 | 删除消费标记与重复续办改为定位 `src/task/assistance.ts`，停止漏取消定位 `src/task/operations.ts`；替换内容、性质、有限域与四类行为失败要求不变。 |

对应位置：`task/reducer.ts` 保留 RECORD_RESULT、STOP、CONTINUE、USER_INPUT、RECOVER 的单次复制与事件更新；`task/assistance.ts` 拥有结果消费和评审规则；`task/operations.ts` 生成 owner/cancel 意图；`task/policy.ts`、`task/guards.ts` 和 `task/lifecycle.ts` 组合原校验及转移。领域模块不是新的事务或 actor 所有者。完整 TLC、两种真实存储回放及四类负对照的结果见本轮证据；没有扩大原有形式化结论范围。

## 2026-10-30 多 actor 对应审查

本轮以职责拆分完成时的 coverage 文件 SHA 为比较基线（保存在 `reports/task-actors/baseline/formal-coverage.json`）。新增 `src/task/execution.machine.ts`，父任务保留预算与结果交接所有权。先通过 62 项模型检查，再接引擎、执行器和观察器。

- 父任务的 `task/lifecycle.ts`、原业务 guards、reducer、assistance、operations、budget、facts 函数体未在本轮改变。policy 新增可选 attempt 校验，reject 动作不得释放其他尝试；无 attempt 的旧可信事件仍走原校验路径。新增包装只声明 spawnChild/sendTo，工作子 actor 的 PARENT_FACTS/终态通知均为内部消息，不更新业务 context。原有八阶段和业务规则身份仍按冻结轨迹逐步核对。
- 子 actor 只在 CLAIM 成功后创建，绑定意图和 attempt，保存于同一 task snapshot 的原生 children 字段。其 authorized/running/cancelling/uncertain/terminal 状态不参与本抽象 marker/consumed/resumes 等投影；这些状态也不写消费标记、不安排 owner，因此没有增加半提交结果的写入口。
- `stepTask` 使用隔离原生 actor 系统同步处理命令和内部消息；父子深度快照先收集再关闭临时宿主，持久化值仍在原存储事务中提交。恢复构造 dormant actor 引用，不重跑外部调用。旧快照没有 children 时保持既有恢复规则。
- `TeamEngine.beginExecution` 新增独立启动许可事务，提交成功后才交给执行器；公共 send 和沙箱拒绝 EXECUTION_* 协议。这是领取之后、适配器调用之前的新边界。原 send/submit/flushResults/recover 的事务没有拆分；消费及 owner 续办依然同一事务写入。
- `WorkRunner.runOne` 仍以 flushResults 为第一步；有限模型与 RunnerProgress 探针不领取 R1 的 owner 续办，所以新许可分支不进入原切片。新的启动协议由 BT_N06–BT_N12 的模型、Memory/SQLite 故障与实际执行器测试覆盖，**不冒充原 TLA+ 模型已经穷举启动许可或外部 I/O**。
- 诊断改为读取同次原生 actor 微步，公共图过滤执行传输协议、保留原业务规则身份；Inspector 只构建未启动的观察元数据并注册真实父子关系。观察器不在此交接模型的写路径。
- 旧四类源码负对照仍定位原 assistance/operations/runner 语句，原有限域、性质、回放与可达性要求不变；覆盖门禁增加 execution.machine，共 35 文件。TLC/真实回放完整复跑后才记录本轮验证结果。

后续集成发现并补齐 BT_N14/BT_N15：新执行器消息和回执身份携带 attempt，取消通道按 room/task/intent/attempt 隔离，旧结果既不能结算、收费到新尝试，也不能删除其取消通道。68 项模型门槛再次通过后才接入这些字段；原交接模型事件不携带 attempt，因此原有限切片的消费、停止与恢复关系保持，新增尝试竞态另由真实执行器受控返回测试验证。

最终尝试隔离审查还覆盖解析与协调的拒绝回退：currentInterpretation/isCurrent 以及解析失败副作用必须匹配 attempt，防止旧结果虽然被拒绝却改变当前阶段或输入状态。BT_N14 扩展到十类实际工作消息，73 项模型门槛通过；旧无 attempt 轨迹的原规则身份、守卫顺序和微步依旧逐步相等。

启动许可最终还核对业务 ended 与不兼容恢复：父任务撤销未启动的普通工作，已启动工作进入取消等待；cancel actor 保留清理权限。BT_N10 显式覆盖这两种拒绝，最终 75 项模型检查通过。原有限切片不请求启动许可，其业务投影继续由全部原边回放及负对照核对。

## 2026-11-06 实现漂移审查

该次审查时目标源码为 PR #37 草稿 head `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f`，不是已合并 main（`d06af677a676b7c102763e44b0d7f7f423685481`）。本维护只改验证，不修改产品契约，也不扩大既有有限域。随后 PR37 已 squash 合入 main `d7b80a4b0e032d300a7201e2532238709eb601cf`，完整树与上述 head 相同；PR38 已同步 main，历史审查记录和覆盖哈希保持原样。

初始原样运行因 21 个覆盖文件哈希漂移而 blocked，见 `reports/verify-squad-handoff/20261106T012340Z-2`。旧记录的名义 sync commit 是 b3502f19，但已经明确包含未提交的职责拆分/多 actor 代码；直接拿该提交 diff 会误把拆分重复当作新变化。逐文件在 Git 历史定位与旧 SHA-256 完全一致的 blob 后审查差异：除 package.json 外，旧 35 个哈希全部与 `3695dc6673b4a10f321f395f156eef3a9b13d966` 的树一致，package.json 对应 `47a36cd50f27b2ce73da0ba910b35177a9bdba02`。名义基点后的全部提交消息及 21 文件逐项分类、旧/新哈希和匹配提交保存在 [drift-review-2026-11-06.json](drift-review-2026-11-06.json)。14 个未漂移文件仍逐项核对哈希，包括真正消费结果的 assistance.ts、两种事务存储与 execution actor。

主要新增边界：

- 协议已变为 team-v3/tools-v3，存储记录支持版本 1/2/3。send 与 flush 先查协议兼容，CONTINUE 携带当前配置。这个切片始终用同一 current 配置新建与恢复，不验证旧协议迁移。消费、续办及 snapshot/receipt 保存仍在一个存储事务内。
- owner 现在选择当前交付报告，intent 可绑定保存证据；停止、换目标、恢复、继续还清理宿主审批、重试和 deliveryCycle。切片无候选、发布、宿主请求、局部操作、评审队列或分片，新增状态不触发这些写入路径。原 RECORD_RESULT/acceptHelpResult、owner 续办及 cancelWork 的原子边界未改变。
- lifecycle 新增 host retry 自动边界与检查耗尽恢复，reducer 的 BOUNDARY 可调用 startMapReduce。hostRetryBoundary 必须有请求，startMapReduce 必须有 decomposition，recoveryCheckExhausted 必须有 bounded check。这些不是“假定永远不影响”的隐含条件：compare.mjs 每次观察都断言相关状态缺席、配置版本一致且 deliveryCycle.requests 为零。未来代码若使回放进入这些边界会失败，不能静默继续解释为原抽象。
- 原拒绝动作增加 DUPLICATE_RESULT/CHECK_RESULT 的释放限制；本切片 DuplicateRecord 的 B 工作已结算，HELP_RESULT 的旧结果归档规则保留。所有重复、停止、换目标、恢复顺序仍以原图逐边回放，未删除或改写性质。
- 普通预算增加 hostRetryReservation；无批次时为零。新检查预算/重试只作用于 bounded check，本切片 A/B 普通领取与零请求检查状态仍受真实执行断言约束。预算耗尽不在旧有限模型内。
- WorkRunner 仍以 flushResults 为第一步；证据、宿主授权和计量发生在其后。真实进度探针必须消费 R1，适配器如被调用会抛错。导入改为直接加载 engine/store/runner，不通过 index 间接加载不相关 CLI/runtime/model-adapter。此改动不替换任何生产行为。

coverage 增补 11 个新语义依赖：delivery/protocol/evidence/verification/map-reduce、host-retry/host-session、delivery-acceptance、evidence-reader、measurement、local-skills。前七者可参与纯初始状态/守卫/恢复决策；其余为上述模块或 runner 的静态依赖，不声明其 I/O 已被验证。覆盖门禁是人工对应审查的保守文件集合，不是运行时导入闭包或 TypeScript 等价证明。

本轮没有更改 TLA+ 模型、性质、故障预算、可达性见证或负对照语义。真实代码对应加强为显式切片条件检查；证明边界仍是每条抽象边的一条代表最短前缀。新增领域的任意状态交错需要 KEJ-93–97 的独立模型，不能由本轮通过推出。

结果为 **updated**，不是产品 bug。同步前完整运行 `20261106T012603Z-2` 通过；推进记录后按技能再运行 `20261106T012656Z-2`，退出 0，耗时 37.766 秒。两次均为原 146 状态、424 条有标签边，MemoryStore/SQLite 各回放 424 边，三类真实入口探针各执行一次；六项可达性见证成立，四种真实代码负对照在两种存储上分别因目标行为失败。移除隔离变体后模型和真实代码均再次通过，覆盖文件哈希不变，临时副本已清理。原始 TLC 日志、反例和执行证据位于上述 reports 目录，`--verify-evidence` 可独立核验。此记录是工作区验证，不冒充尚未产生的交付提交的验证。


## PR40：KEJ-98／99 对应审查

已审源码21ee46039f594d9b93d400bf703e14d42fab2b0e；旧同步cd987f2f4a7e29ad3efae1af36a0f432ce813c8f。旧清单46个blob均与旧同步提交精确一致，14个变更与32个未变逐项核对；新增artifact-request、source-artifact、map-reduce-capacity三个传递依赖纳入漂移门禁。逐文件分类及理由见[drift-review-pr40.json](drift-review-pr40.json)。

新增来源入口与Markdown交付不在原单任务、已保存R1切片内；普通初始化文本不触发来源匹配，明确retry/continue仍走原控制。容量计算仅在模型理解或有decomposition时使用，本切片配置没有models。compare.observe新增sourceArtifact缺席、无interpretation工作、rule输入的显式断言，保留已有无candidate/check/discussion/host的条件，防止未来新增分支静默漏出投影。

消费标记、owner续办、取消及两种存储提交边界没有改变；其关键模块assistance/store/execution等逐字哈希未变。TLA+原模型、146状态有限域、性质、六个可达性见证及四类真实代码负对照保持。新来源身份、固定正文、跨任务组合及动态容量完整性不能由此模型推出，仍由独立场景与集成验证；本次只维护现有交接保证，不扩大声明。

初始原样运行blocked，首轮审查后验证 `20261106T101946Z-27406` 完整退出0，41.231秒，独立读回100件证据成功。原146状态/424条标记边、Memory/SQLite逐边回放、六个可达性见证和四种双存储真实代码负对照全部完成，原实现恢复后再次通过且源文件未变。此后才将同步基线推进到21ee460，并按技能再次完整运行；最终证据见coverage.review。

更新同步后完整复跑 `20261106T102156Z-29383` 退出0，48.172秒；独立证据读回成功。原模型与双存储逐边回放、六个可达性见证、四类真实负对照及移除突变后的复验均保持，清理项全true。该轮保留完整checker-inputs（验证脚本、模型、cfg、coverage及逐文件审查），以免只留下摘要无法核对原验证输入。


## BT_F31 冻结输入引用的传递依赖审查

审查目标为 `756074087685bed3f52f0e6b6e06caf19c587a01`，产品代码对应 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`。旧覆盖清单49个文件逐一核对：47个未变，`src/delivery-acceptance.ts` 与 `src/task/delivery.ts` 两个传递依赖发生变化，见[逐文件审查](drift-review-raw-input-citation.json)。先前只复验另外三组形式化验证遗漏了此清单，首次原样运行已保留 blocked 证据。

新增逻辑把冻结 rawInputs 转为既有引用来源，checkDisposition 从保存的检查意图读取该字段；未引入新的交接写入口，也未拆分事务。handoff 回放每次 observe 都断言 candidate 为 null、没有 check intent、没有发布记录且 deliveryCycle.requests 为0，因此新检查引用路径不在这个受断言约束的切片内。assistance 消费标记、唯一 owner 续办、停止取消、runner flush 和两种存储提交边界未改动。模型、性质、边界与回放驱动保持不变，完整原图、可达性见证和四类真实代码负对照仍必须执行。该结论不扩大为引用语义或供应商质量证明；对应行为由 BT_F31 与独立交付验证提供证据。


## KEJ-106：旧讨论退休修复的无讨论切片对应审查

审查产品提交为 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`，旧同步为 `756074087685bed3f52f0e6b6e06caf19c587a01`。读取两者之间的全部提交消息及覆盖文件 diff 后，仅 `src/task/facts.ts` 和 `src/task/reducer.ts` 两项改变，另47项哈希未变；逐项旧新哈希、分类、原样 blocked 与完整运行记录见 [drift-review-kej-106.json](drift-review-kej-106.json)。

`canRetireDiscussionWork` 必须有 discussionId，且只允许安全、无物理未结算操作的旧轮 pending/inflight 工作。RECOVER 的恢复兼容检查和本地结果/核对后的退休都复用该谓词；单次事件的事务边界没有拆分。handoff 的公共前缀仅创建普通 A/B 协助，图动作没有启动讨论或分片的入口。`compare.mjs.observe` 在每次观察保留无 discussion/localOperations/decomposition 的检查，并新增所有 intent 无 discussionId 的显式断言。因此此切片中退休谓词恒为 false，新增 LOCAL_* 路径不可达，旧 RECOVER、消费标记、唯一 owner 续办、停止取消与 RunnerProgress 路径保持。

TLA+ 模型、配置、安全/活性性质、故障预算和界限均未改变。仍要求全部146状态与424条标记边的两存储回放、六项可达性见证、四类真实代码负对照及移除突变后的复验。对照失败必须来自原目标行为，不能是编译、依赖或哈希门禁。

本次 handoff 通过不扩张到旧讨论取消后再恢复、成员占用、unsafe/uncertain 或物理操作效果安全；coordination 新增的有界实现实例和 BT_Q19–Q23 是不同层次的独立证据，也不能据二者单独通过推导整个组合的穷举保证。初始环境阻塞（TLC本地监听权限、注入的不完整模型配置）保留原始日志，修正执行环境后才作结果判断；未修改用户 `.env` 或打印凭据，也未调用供应商服务。

候选完整检查37.841秒通过并独立读回108件证据后，才推进syncCommit；同步后再完整运行 `reports/verify-squad-handoff/kej-106-final`，38.996秒退出0，独立读回108件证据成功。原模型与恢复模型均为425个生成状态、146个不同状态、剩余队列0（424条标记边），Memory/SQLite各回放424边；六项可达性见证、四种双存储真实负对照与恢复复验全部完成，清理项全部true。实际执行HEAD `84a67c72b7db3f1f73b140cfa46dbf38bbc676c8` 与审查产品提交在src及配置/依赖文件上无差异。


## KEJ-106 最终 engine 恢复入口增量

最终审查产品提交为 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b`。相对已验证的 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`，覆盖源码仅 `engine.ts` 两行改变：导入 `canRetireDiscussionWork`，并仅对存在可退休旧讨论工作的 ended 任务允许进入原有RECOVER/flush循环。原样检查先因engine哈希漂移blocked，见 `reports/verify-squad-handoff/kej-106-engine-initial`。

handoff每次观察显式排除所有带discussionId的意图，该谓词在此切片恒false，因此普通ended任务仍保持原跳过行为；未拆分或合并send/flush事务。图中Reopen刻意直接发送RECOVER并单独建模flush，不调用engine.recover的任务选择循环：此处的同域无影响结论包含源码对应审查，不能把图回放说成动态覆盖新增ended讨论入口。新增入口由coordination公共恢复实例提供独立证据，原handoff模型、性质、范围和驱动未再改变。

旧 `kej-106-candidate-clean-env` 与 `kej-106-final` 仅验证b6ea产品，不能代替最终engine源码验证。最终新源完整检查 `reports/verify-squad-handoff/kej-106-final-engine` 36.308秒通过；原模型及恢复模型均425生成/146不同状态/0剩余队列，Memory/SQLite各回放424条边，六见证与四类真实代码双存储负对照全部完成，清理项全true。独立读回108件证据成功后才推进同步到3d81。该运行准确记录旧sync=b6ea、实际source=`0503c956a7c9af3d6ddaee7c7b54224e7f0f85ce`；后者与3d81在src/配置/依赖上无差异。推进后只复核pin匹配和证据读回，不冒称又运行一次完整检查。


## KEJ-102–105：验收接线与成功响应资源边界

受审产品及构建编排为 `32c26b376b46ae1a03718a6820683b59b802b413`；旧名义同步 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 在此 clone 不可用，先逐项证明可用 squash 基线 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 与旧覆盖清单所有源字节完全一致，再审阅其后提交消息和逐文件差异。旧新指纹、分类、原样 blocked 及完整检查状态见 [本轮对应审查](drift-review-kej-102-105.json)。

handoff 的 createTeamConfig({}) 无模型服务；RunnerProgress 在 adapter 调用前完成 R1 消费。types 的可选配置及 model-env 的新参数在此切片没有值，原消费标记、唯一续办、停止与恢复投影不变。 `package.json` 仅将 build 改为同样的两套 tsc 和 Vite 加构建证据记录，不改变依赖锁或本技能执行入口。没有新的领域写入口、事务拆分或投影字段；TLA/CFG、性质、公平性、界限及原真实代码负对照保持。

成功响应的实际解压字节上限、取消读取、UTF-8 边界与非瞬时失败由 BT_M46–M49 的真实 HTTP/SQLite/Runner 验收及撤销读取上限的负对照承接；本有限检查不证明供应方 I/O 读取、资源上界、真实进程终止、SQLite 底层抗断电或这几种领域的组合。KEJ-103/104 的真实 SIGKILL/SQLite 依赖验收是额外证据，不替换原模型的事务假设。审查后先更新已确认的覆盖指纹，保留旧 sync；只有完整正负/恢复检查与独立读回成功后才推进同步元数据。

完整检查与独立读回已通过：`reports/verify-squad-handoff/kej-102-105-controlled-env`，保留 108 项原始证据；具体原图/恢复图规模、真实源码负对照和清理结果见审查 JSON 的 verification。同步推进到受测产品 `32c26b376b46ae1a03718a6820683b59b802b413`，后续集成 HEAD 的全部覆盖源/依赖逐项保持相同字节；不把元数据推进说成第二次完整验证。

## KEJ-108 A2：重试组合

状态所有者仍是TaskContext中Assistance、HelpResult、Intent及receipt的组合；没有新增XState state/actor。`tests/handoff-composition-fixture.ts`由公开TeamEngine接口建立失败或已保存结果的初始前缀。失败协助的status与重试Intent是否pending分别投影为stage/retryPending，不能将RECOVER保留的running协助误当成pending。

| 动作/变量 | 真实入口与约束 |
| --- | --- |
| Retry1/Retry2、ReplayCommand | `submit(intent=retry)`，两个新commandId；重放第一个完全相同载荷只读原receipt |
| LateOriginal | 携原workId/attempt/fence发送原协助结果，失败原工作不得复活 |
| RevokePermission | 重建引擎并注入可信当前TeamConfig，移除B工具权限；不是篡改context |
| ChangeOwner | 失败域公开HANDOFF切换当前owner；新retry命令检查requestedBy/current owner |
| ClaimRetry/SaveRetry | `claim`及`send(RECORD_RESULT)`，必须匹配新work/attempt |
| ConsumeOriginal/ConsumeRetry | 仅一个可消费结果/任务，`flushResults`实际提交一次；由真实投影检查 |
| Recover | 关闭重开SQLite并重建引擎，只提交一个`send(RECOVER)`；消费是独立动作 |
| successors/command1/command2 | 原协助retryOf关系数量与持久命令receipt；重复命令不等于重复工作 |
| originalConsumed/resumes | 原结果消费标记和对应owner续办总数，不能靠当前pending数掩盖历史重复 |

对应关键函数：`assistanceRetryProblem`、`savedHelpResult`、reducer RETRY_ASSISTANCE/RECORD_RESULT/RECOVER、`acceptHelpResult`、TeamEngine.submit/claim/send/flushResults。原子边界是上述单事务，不把整个engine.recover连同flush循环当一条原子动作。

两配置独立检查失败/已保存域；边界和四真实代码改坏锚点保存在composition-suite.json。实际TLC状态/边数与有限进度以本轮run.json和原始tlc.log为准。真实行为由BT_K01（两起点）和BT_K02（权限/owner）直接执行；补充穷举对应通过所有抽象交错而不是在BDD里复制模型。

名称映射：TLC `UniqueRetry`对应真实断言`RetryUniqueness`；TLC `RetryAuthority`同时要求memberRevoked与ownerChanged都为false，分别由真实`RetryAuthority`和`RetryOwner`检查。`ExclusiveResultChoice`/`RetryHandoff`两侧同名；suite列出实际必需TLC不变量与Progress，真实源码负控的property列使用行为断言名称。


## KEJ-109：发现与检查诊断依赖审查

旧覆盖指纹逐文件与可用主线 `5b8c596` 字节相同；从该源等价基线审查到本次产品修复。逐文件原因、旧新指纹及执行结果见 [审查记录](drift-review-kej-109.json)。Handoff 的消费/续办/停止事务及 A2 的 retryOf、保存复用、当前权限与 owner 守卫均不变。检查诊断只写 check 意图，模型切片要求没有候选和 check；运行器的 flushResults 仍先于领取、共享命令上下文或适配器调用。新增三个纯目录/投影依赖纳入指纹。保留全部有限域、性质、公平性、可达性与真实代码变异；新增 CLI 和错引行为由 BT_L77–L87/BT_F29–F31 独立验收，不能从本切片推导其正确性。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。


## KEJ-110 检查效率与来源结构的切片审查

原覆盖清单逐项与可用主线 `942dfe4a9876dc9dcb8db94b221148822edf07a2` 字节相同。逐文件旧/新hash、分类、初始原样blocked和最终执行在 [本轮审查](drift-review-kej-110.json)。新增 `delivery-check-delta.ts`、`source-claims.ts`、`source-items.ts` 是传递依赖，加入保守漂移清单不表示已证明其内容语义。

本次仍由原公开入口、原事务边界驱动；候选与操作身份、存储提交、消费标记、发布记录和final原子性不变。结构化来源校验只处理带sourceItems的报告；既有回放的普通报告不触发。增量材料由runner模型请求使用，直接engine事件回放不执行该投影；handoff进度探针仍先flush且不调用adapter。共享能力事实只读，不生成调用权限或调度。

修订额度按 KEJ-110 与 BT_F77–BT_F81 有意改变，独立 coordination CheckBudget 承接扩大域；本技能原交接切片没有候选/检查，原Delivery只检查一个候选，Cycles的环境只允许跨三个发布周期一次失败修订。后者保留该明确有限域，不声称覆盖多次失败或整个新预算。Verification的工程门禁、SourceLineage的固定来源与直接谱系均未改变；sourceArtifact模式回退完整材料。

原模型、性质、边界、公平条件和真实代码负对照保持。新来源原文状态、D标签渲染、增量复核语义、任意报告和模型供应商质量仍由直接产品场景与集成承接。本轮在产品 `661e438` 上完整运行与独立读回已通过，逐项执行记录见审查JSON；同步元数据由整体验证结束后推进，不把元数据更新称为一次额外完整运行。

本轮原 Handoff 入口108.556秒，146状态/424边，Memory/SQLite各424边；六项见证、四类真实代码负控及原版完整复验通过。重试组合的failed/saved两域分别53状态225边与26状态103边，双存储逐边回放、四类真实负控、原版复验、独立读回及证据缺件/截断负控均通过。真实证据 `reports/kej-110-final-handoff`、`reports/kej-110-final-handoff-composition`；限并发中断的partial目录不计通过。

最终产品 `615b18f` 仅将同一sourceItems说明从交付JSON示例后缀移到owner系统指令，使示例保持JSON。上述形式化入口不调用模型HTTP，声明的事务与投影无影响；仍按精确源码策略重跑全部入口。661成功证据已移至 `reports/kej-110-661-*`，仅作历史；615最终结果在审查JSON的validation单独记录，未完成前保持pending。

### 615b18f 精确源码最终复验

产品615的原Handoff完整入口38.141秒通过；146状态424边，Memory/SQLite各424边、六项见证、四类真实负控及原版完整复验通过。两域重试组合仍为53状态225边与26状态103边，四类真实负控和原版复验通过。独立读回分别108/153件证据，组合证据缺件/截断负控通过。新证据位于 `reports/kej-110-final-handoff`、`reports/kej-110-final-handoff-composition`；615命令日志在 `work/kej110-615-handoff-delivery-commands.json`，661结果仅保存在historicalValidation。

## KEJ-111：有界工具反馈与分片补齐的交接切片审查

产品冻结于 `c239dd39d86f143a2f435f48590c648b20745b8b`。旧同步615的58项原交接指纹、25项A2指纹与可用主线 `49d2bc0ec61df94581cc52aef48725b040ea8603` 逐项同字节；该基线至产品提交的全部12项源码变化及新增依赖已阅读，逐文件原因与原样blocked保存在[审查记录](drift-review-kej-111.json)。原样检查发生在开发中，只证明当时漂移门禁阻止运行，不能冒充冻结提交的完整检查。

原 `compare.mjs.observe` 每步断言没有candidate、check、discussion、discussionId或本地操作；原图只保存/消费协助结果，不执行负责人续办。`RunnerProgress` 探针仍在 `runOne` 首次flush后结束，adapter.execute若被调用会抛错。新增runner回调和Web失败反馈不会进入这些路径，消费标记、唯一owner续办、停止取消与原存储事务没有改变。

A2的 `RetryComposition` 从公开HELP、RECORD_RESULT或WORK_FAILED形成起点，动作全集只含重试、领取/保存/消费、旧结果、权限/owner变化和RECOVER；没有DELIVER或RECORD_TOOL_FAILURE。新增policy分支按事件类型进入，新的可选字段在该前缀与动作中没有值。retryOf唯一后继、保存结果复用与当前权限/owner守卫保持，恢复和flush仍是分开的事务。

`map-recovery.ts` 与 `tool-recovery.ts` 是已覆盖policy/reducer等的新增纯依赖，应加入保守漂移清单。前者只在当前map轮次且候选有恢复声明时生成验收/解决记录；后者只由新事件记录至多两次反馈。它们在本技能原有限域内无新增写入，不能据此宣称整个产品多了一条已穷举的stuttering路径。独立coordination ToolRecovery/MapRecovery切片与BT_M52–M59、BT_Q36–Q48分别检查新协议/行为；本技能原模型、性质、故障预算、界限、见证与真实源码负控均不变。

冻结源码的完整正负/恢复检查及独立读回以审查JSON的validation为准，未完成前不推进同步元数据；同步更新本身不算额外完整复跑。

## KEJ-112：工具推荐和 CLI 重复限制的交接切片审查

冻结产品为 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。旧同步提交 c239 在本地对象库不可用，全部旧覆盖指纹与可用合并基线 `6134a0c7ffa37739d6ee23992705462022b324fb` 逐项同字节；先保存两个原样检查的 blocked 漂移证据，再逐文件阅读变化。审查分类、旧新摘要、初始漂移与完整验证结果见[KEJ-112 记录](drift-review-kej-112.json)。同步提交在全部验证入口完成前保持旧值。

`engine.requestLocal` 只改变本地请求 receipt 身份，使未创建操作的拒绝之后可以提交不同参数或更长模型历史；它仍调用一次 `engine.send` 事务，操作 requestHash 与已有操作幂等语义保持。两个有限切片从未调用该入口。`local-operation` 只在 LOCAL_REQUEST 中新增重复失败守卫；原 Handoff 的逐步投影断言不存在 localOperations，A2 的公开前缀和动作枚举只含协助重试、结果、权限/owner、恢复与消费，不产生本地操作。

Runner 新增推荐 getter 仅在注入 LocalRuntime 时可读取，重复限制反馈也仅在本地 invoke 内处理。原 RunnerProgress 探针没有 LocalRuntime，且必须在调用会抛错的 adapter 前完成 R1 flush，因此不会进入模型或推荐路径。CLI/技能目录的新推荐方法及三个纯 helper（cli-failure、task/tool-guidance、tool-recommendation）已加入保守漂移清单；它们只读已加载元数据或本地回执，不写协助、消费标记、续办意图或事务边界。

原 Handoff 与 A2 的模型、性质、公平性、有限边界、见证及真实源码负对照保持。本技能不把新增工具推荐、CLI 纠正或新 receipt 格式宣称为已穷举行为；这些由 BT_L117–BT_L124 和真实 taskMachine 的 CLI 模型门槛承接。完整运行仍必须包含全部 TLC 图、双存储逐边回放、真实源码故障、原版复验及独立证据读回。


## KEJ-113 / KEJ-114 对应审查（完整复验及独立读回已完成）

逐文件记录见 [drift-review-kej-113-114.json](drift-review-kej-113-114.json)。原 sync commit `7e5b3426…` 的 Git 对象在当前克隆不可读取，但 63 项旧覆盖指纹分别与可用提交 `15d2714`、`62fdb58` 全部字节一致；审查以该可验证等价产品基线进行，不声称读取了缺失对象。两个原入口先按旧指纹运行，均明确 blocked，原始结果保留。

本轮没有改变两个 TLA 模型、原性质、公平性或有限边界。真实输入固定时钟 0/1，原固定窗口仍未到期、没有修复/显式新窗口；新增可执行断言要求不存在 human gate、skip、cleanup、acquisition、资源义务、删除屏障或被投影掉的 SUPERVISE/HUMAN_GATE_DECISION/EXECUTION_NOT_STARTED。Stop→Reopen 现在可能保存空业务材料的 stopped 宿主报告；夹具逐字段检验其 status=stopped、verification=incomplete、唯一宿主文件、原 window、epoch/goal 和正文，并要求没有材料/skip/source/cleanup。当前与历史 stopped 通知都受检验；业务 partial/failed salvage 仍排除。已有 no candidate/discussion/check/host/local 断言保留。只有这些已执行前提成立时，才能沿用原投影。新增全局期限、八阶段修复、部分交付、未知效果隔离与删除不属于旧有限结论。

存储 `atomic()/transactRoom()` 重构仍以同一 SQLite BEGIN/COMMIT/ROLLBACK 或 Memory 克隆提交写入 marker、consumedResults 与唯一 owner；rollback 故障位点仍在提交前。`TeamEngine.flushResults` 仍只在 durable marker 已设置后保存。`WorkRunner.runOne` 经 executeOne 包装后，实际第一项仍是 flushResults；RunnerProgress 不进入适配器。保存结果重试新增逻辑终态元数据恢复，但原 saved/failed 有限起点没有 frozen/门/物理操作；原唯一后继、当前权限和当前负责人仍由生产守卫裁决。

`repeat-saved-work` 的源码负对照锚点由原单行改为当前多行 `if (saved)` 分支，仍只改为 `if (false && saved)`，让原保存结果被错误重新执行；保持 `ExclusiveResultChoice`、基线图及双存储行为检出要求。没有用模型变体代替真实代码变体。转递依赖采用递归相对导入补充指纹，未扩大行为证明域。

最终产品冻结为 `36916b5c6e974c11f8e51720189c64facef9269e`。原 Handoff 完整入口检查 146 状态、424 边/存储、6 个可达见证、4 个真实源码负对照及原版复验；RetryComposition 完整检查 failed/saved 两域 53/26 状态、225/103 边/存储、7 个见证和 4 个真实源码负对照。两入口均退出 0、status=verified、清理全部 true，独立读回分别校验 184/208 个保留文件。证据及命令见本轮 review JSON；sync 只推进到已检查的实际产品字节。全局九入口已全部完成并通过独立读回；authority 两入口保留相同产品字节下的完整 final-2 证明并在 final-3 新读回，coordination 两入口完整重跑 final-3，其余五入口由主交付再次独立读回。此处只同步完成元数据，不声称额外复跑或扩大保证范围。


最终增量另行审查了旧 unsafe adapter 的全局未知效果屏障、宿主批准门与令牌恢复、多必需门、配置不兼容的 skip/stop 门、cleanup 独立唤醒、带资源凭证的分片报告及原负责人检查点续办。原两切片没有 unsafe work、LOCAL_*、协议配置变更或 map 事件；驱动新增 no-unsafe 意图断言，与原有 no local/资源义务/gate 检查共同阻止静默越域。它们不增加新的已穷举外部效果保证。76/77 个覆盖指纹与保留源码逐项一致；composition 的验证夹具维护故意不混入产品提交，证据捕获其实际字节，随后独立验证维护提交承接。

宿主 Handoff 证据格式 v2 还要求覆盖清单中的全部源码确实被捕获，不能只核对现存 manifest 项。独立 reader 负对照删除一个覆盖源码及其 manifest 项并重算 manifest 校验值，真实读回仍拒绝缺少的 `src/task/resilience.ts`；临时副本已清理。这是证据读取器的敏感性检查，不能冒称生产代码故障对照或新的产品性质证明。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## 跨会话资源等待与全局只读观察（2026-11-11）

本轮原样检查先因精确源码变化返回 blocked，随后逐项审查当前工作树与旧覆盖输入；旧清单的全部文件在 HEAD `1991d3094c7fb5c54f20d9b4d77670eaf82f7436` 与原基线逐字节相同。新差分及实际完整检查、独立读回和源码负对照记录见 [本轮审查](drift-review-workspace-wait.json)。新增 `src/coordination-view.ts` 纳入保守依赖清单；其命令参数、路径、原因与门问题均为经过运行时脱敏的只读执行元数据，不构成调度、批准或未知效果结算权限。

`workspaceWait` 仅在合法本地领取因真实资源冲突被拒绝时保存，成功领取清除；旧权限、原子提交、版本、发布和效果锁约束不放宽。资源冲突谓词仅抽取为同一布尔资格与解释共享的 owner 列表。监督新增的 resources 分支不把排队命令算作执行，不花修复额度或延长原窗口。原有限图不含这些跨会话等待/界面/协调语义：Handoff/Retry 不执行本地命令，Delivery 的工程验证切片也没有竞争的资源持有者。新行为由 BT_Y114–BT_Y120 的真实状态模型、服务和浏览器验收承接，不能由旧 TLC 结果推导。

原模型、性质、公平性、有限域、回放、真实源码故障对照与期限均保持。完整 producer 已在所记录的精确工作树字节上通过，随后独立证据读回及适用的 CI reader 反控通过；这些完成状态并不宣称九入口已整体同步。syncCommit 保持此前值，待全局九入口核对后统一处理。
