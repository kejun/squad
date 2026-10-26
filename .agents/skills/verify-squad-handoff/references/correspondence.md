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

- `src/task.machine.ts`：fresh/permissionProblem、acceptHelpResult、owner/cancelWork、savedHelpResult/assistanceRetryProblem、reduce 的结果/停止/继续/用户目标/恢复分支，相关 XState 守卫与自动边界。
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
