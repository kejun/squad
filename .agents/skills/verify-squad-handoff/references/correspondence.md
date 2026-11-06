# 实现对应、投影和边界

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
