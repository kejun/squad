---
name: verify-squad-local-effects
description: "检查 Squad 本地命令的未知效果、可信回执、检查点、工作区独占与停止/崩溃/提交失败的组合恢复。修改 LOCAL_RESULT/LOCAL_RECONCILE、CliJournal、Store 或恢复调度时使用。"
---

# Verify Squad local effects

保护承诺：没有确定回执的本地命令不能在恢复时自动重做或释放工程；原可信回执必须与检查点和租约结算一起提交，重复或错误会话不能再次推进任务。

先读仓库 AGENTS.md 和 [实现对应](references/correspondence.md)。本技能只改变验证临时副本；不修改产品、用户数据库、凭据或已有证据。校验过程中运行本仓库受控 CLI/SQLite 崩溃夹具，不访问模型供应商。

## 执行

需要仓库 Node 22.18+/24.11+、npm ci、Python 3.10+、Java 11+。使用官方 TLA+ Tools v1.7.4（TLC 2.19），JAR SHA-256 必须是 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`；本技能不自行下载或安装依赖。

省略 --jar 时使用 TLA2TOOLS_JAR，或尊重 XDG_CACHE_HOME 的 ~/.cache/squad-formal/tla2tools-1.7.4.jar。

```sh
env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true \
  python3 .agents/skills/verify-squad-local-effects/scripts/check.py --jar /absolute/path/tla2tools.jar
```

默认在 reports/verify-squad-local-effects 下创建全新证据目录，`--evidence` 可指定尚不存在的目录。每子进程最多 90 秒；超时、源码漂移、错误反例或未完成探索均不通过。完整命令后再单独读回实际证据目录：

```sh
python3 .agents/skills/verify-squad-local-effects/scripts/check.py --verify-evidence reports/verify-squad-local-effects/实际目录
```

只有完整退出零、run.json.status=verified、清理与覆盖源未变、模型和回放/反例阶段完整、证据读回成功才通过。保留原始 TLC 日志、图、实际配置、全部逐边 JSONL、源码突变 diff、反例、真实进程接线证据及 SHA/字节清单。摘要不能代替原始证据。

## 精确范围

有限模型起点经两个房间的 submit → claim → beginExecution → requestLocal 到达，原命令再 claimLocal 并写 prepared 日志。两个任务竞争一个工程；主模型只追踪原命令，另一任务只尝试获取同一租约。原命令一次逻辑启动、最多一次宿主丢失和一次回执提交失败；停止、确定回执保存和其他操作可交错。

`prepared` 抽象包括启动前和启动后尚无确定回执两个窗口，故它始终不能证明未启动。CliJournal phase=spawned 的 PID/身份判断不在这张图内；KEJ-103 真实进程接线另外验证该窗口。无 journal 的 notStarted、新领取 session 和错误 session 由 BT_L93 的公开接口实例验证，不冒充主图的全部组合穷举。

安全性质：`UnconfirmedKeepsLease`、`AtomicCheckpoint`、`CompetitorAfterSettlement`、`OneStart`、`NoUnsafeReplay`、`SessionBound`、`NoFalseNotStarted`。最后一项约束未知日志的分类输出，不声称该次负对照已实际重放命令。这些检查有限抽象，不能据此推出无限多操作或任意 TypeScript 历史等价。

活性性质 `SettledProgress`：确定回执已经持久化后，最终保存到任务检查点。假设最多一次丢失/失败，且恢复 Reopen 和持续可执行的 Commit 弱公平；不要求用户一定批准，也不要求未知效果一定得到核清。真实逐边回放证明代表前缀的可执行性，不证明生产调度器公平。

先复验真实 taskMachine 的纯转换门槛，再完整 TLC、MemoryStore/SQLite 每条标记边各重放一条最短前缀；Crash 仅丢宿主引用，Reopen 则真正重开 SQLite、重建引擎并 RECOVER。保存 journal 和提交任务是分开的动作，提交失败保留原快照、检查点与租约。

六项独立可达见证必须分别达到启动、未知、已结算、停止后结算、回滚及竞争者成功，避免守卫不可达导致空通过。四个真实源码负对照分别破坏未知效果持锁、检查点消费、会话匹配与 prepared 日志的保守分类，两种存储必须因指定行为断言失败；相应模型变体也须产生指定安全反例。随后移除副本，完整重跑原模型与原实现。

最后复用 KEJ-103 的 beforeReceipt/afterJournal/stopped 三个真实 CLI 与 SIGKILL 接线，以及 KEJ-104 的 report/lease × COMMIT 前后四个真实 SQLite 写进程接线。它们独立于有限图：不证明 OS 沙箱隔离、磁盘断电、外部服务恰好一次、跨主机锁或 PID 实现形式化正确。原子数据库事务仍是模型假设，实际进程夹具提供有界接线证据。

## 维护

coverage.json 保守记录本轮实际源码、夹具和依赖 SHA；哈希门禁不是实现证明。源码变化先审查动作原子边界、身份/恢复守卫和新写入口，按 [对应说明](references/correspondence.md) 修改模型、回放和真实负对照。不得仅刷新指纹，不得放宽性质使真实缺陷通过。

请求 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-local-effects` 时，先原样执行，区分 drift/bug/blocked；逐项审查同步提交后的差异，再完整运行及独立读回。记录实际提交、脏源哈希及覆盖边界；只有受测代码与记录一致且全阶段通过后才推进同步元数据。

KEJ-109 维护同步产品为 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596`。原样执行先检出覆盖漂移；逐文件审查十个变化及三个新传递依赖后，原108状态/282边、双存储回放、正负见证、恢复复验和七条真实进程接线全部通过，220件原始证据独立读回成功。受测工作区字节与同步提交逐项一致；详见 [本轮对应审查](references/drift-review-kej-109.json)。模型、性质、公平性、界限及真实故障检出保持，目录/共享方法/检查诊断的语义另由 BDD 验收。

KEJ-110 当前受审产品为 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9`；本轮逐文件审查、明确改变的预算承诺（如适用）、完整正向/真实负对照/原版复验与独立读回见[KEJ-110审查](references/drift-review-kej-110.json)。仅在全部九个CI形式化入口成功后推进同步元数据；此同步操作不是额外完整复跑，新功能的语义与真实模型供应商行为仍由独立验收负责。

KEJ-111 维护：受审冻结产品 `c239dd39d86f143a2f435f48590c648b20745b8b`。保留原有限图、性质、界限和负对照；逐文件分类、驱动与实际进程接线边界、最终完整运行和独立读回状态见 [KEJ-111审查](references/drift-review-kej-111.json)。全部九入口完成前保持旧syncCommit；新增ToolRecovery/MapRecovery由coordination扩展单独承接。
