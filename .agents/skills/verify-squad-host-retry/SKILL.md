---
name: verify-squad-host-retry
description: "检查 squad 宿主续办批次的安全退休、已知回执保留、按来源去重和后续批次推进。修改 hostRetryRequests/hostRetryBatch、负责人终结或恢复、LOCAL_RECONCILE、任务自动转移时使用。运行真实 TLC、所有标记迁移的双存储公共入口回放和真实源码负对照，并检查代码漂移。"
---

# 宿主续办批次验证

先读仓库 AGENTS.md 与 [实现对应](references/correspondence.md)。保护的承诺是：未知物理效果不能因负责人结束而丢掉阻挡；已保存回执不能因批次退休被改写；结束的已决批次不永久占位，同来源和后续工作不重复。违约会重复执行宿主命令、误报执行结果或使用户的后续请求卡死。

## 执行

仓库根运行，需要已安装仓库依赖、Python 3.10+、受支持的 Node 与 Java 11+。使用固定 TLA+ Tools v1.7.4，SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。没有固定 JAR 时报告 blocked，不换工具或跳过模型检查。

```sh
python3 .agents/skills/verify-squad-host-retry/scripts/check.py --jar "$TLA2TOOLS_JAR"
```

可用 `--evidence` 指定一个尚不存在的目录。每个 TLC 最多45秒，回放最多60秒。整个流程依次：检查 [覆盖指纹](references/coverage.json) → TLC 全探索及 Progress → 所有有标签边从公共前缀在 Memory/SQLite 回放 → 四个可达性见证 → 四种真实源码变异在两个存储上分别被行为检查检出 → 删除副本 → 重跑原模型及原代码 → 独立证据清单。每步原始日志、模型、图、变异差异、工具命令及工作树指纹均保留。

只有命令退出0、run.json.status为verified、清理全真，才可报告通过。随后使用新命令独立读回：

```sh
python3 .agents/skills/verify-squad-host-retry/scripts/check.py --verify-evidence "$SQUAD_FORMAL_EVIDENCE"
```

读回会核对必需原始文件清单、大小和SHA、全covered实现及driver原文与指纹、实际cfg性质集、实际JSON与摘要/raw日志的一致性、原始TLC完成/活性记录、全部双存储标记边JSONL及其目标状态和公共前缀、可达性失败原因和真实代码负对照。模型图中的虚线自动stutter仅表示TLA规格允许无动作，不是漏掉的运行时事务；每条标记边都回放。

读回器本身的完整性负对照也应执行。它只改临时证据副本并重算manifest，原始证据不改：

```sh
python3 tests/host-retry-formal-evidence-controls.py "$SQUAD_FORMAL_EVIDENCE"
```

必须分别拒绝：删除全部负对照原始件、删一条回放记录、删除基线回放JSON、篡改actual目标状态、伪造公共前缀、删除实现原文、漏配指定性质。仅报告SHA不一致不足以承接这些内部一致的缺件检查。

## 性质、界限与边界

- `NoUnknownAdvance`：首条效果未知时，旧批次不能退休，不能生成下一来源操作。
- `PreserveReceipt`：成功/拒绝回执在负责人结束、到期后退休及恢复中保持事实；运行时还比较完整回执与既存候选。
- `UniqueSuccessor`：旧批次退休一次、下一来源操作只建一次；运行时还核对来源请求不重复。
- `Progress`：批次效果已确认后，在恢复、领取负责人及负责人结算弱公平的前提下，后续批次最终生成。没有假定人工一定能确认未知效果。

一个任务、两个失败沙箱来源、先后两批、一位负责人；四种公共前缀为queued、成功、拒绝、效果未知；最多一次对象丢失/重开、两类时钟位置。权限、当前目标和充足额度固定，第二请求在第一请求期限之后仍有效。无限供应商或宿主故障、任意多批次、模型正文质量、审批digest/CLI沙箱语义、预算与停止/换目标组合不在这个切片。它们有已有场景/其他技能，不能声称组合穷举证明。

模型是有限协议穷举，真实代码连接是所有标记迁移的公共入口执行对照及源码对应审查；不是 TypeScript 的机器证明。`Crash`丢失宿主对象的抽象由构造新引擎/SQLite关闭重开对应，未声称此技能执行了OS进程崩溃或真实CLI。真实进程效果由KEJ-103、KEJ-108准备验证另行给证据。旧版本手工遗留的missing-owner初态由BT_L54/L55验收，不混为本模型当前实现可达起点。

## 维护

覆盖文件变化时默认 blocked。先按 [维护流程](references/maintenance.md) 审查所有改变及迁移的写入口，明确模型动作、边界或承诺是否变化，再更新模型/回放/真实负对照。不得只刷新文件哈希；不得削弱性质来接受产品缺陷；未通过不推进syncCommit。首次建立记录的基线commit与当前工作树受测指纹共同标识产品版本，不能将未提交修复说成已经属于该commit。

KEJ-110 当前受审产品为 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9`；本轮逐文件审查、明确改变的预算承诺（如适用）、完整正向/真实负对照/原版复验与独立读回见[KEJ-110审查](references/drift-review-kej-110.json)。仅在全部九个CI形式化入口成功后推进同步元数据；此同步操作不是额外完整复跑，新功能的语义与真实模型供应商行为仍由独立验收负责。

KEJ-111 维护：受审冻结产品 `c239dd39d86f143a2f435f48590c648b20745b8b`。保留原有限图、性质、界限和负对照；逐文件分类、驱动与实际进程接线边界、最终完整运行和独立读回状态见 [KEJ-111审查](references/drift-review-kej-111.json)。全部九入口完成前保持旧syncCommit；新增ToolRecovery/MapRecovery由coordination扩展单独承接。

KEJ-112 维护：受审冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。逐文件审查、原样漂移阻塞、完整正向/真实源码负对照/原版复验、独立读回与读回反控均已通过，见 [KEJ-112 审查](references/drift-review-kej-112.json)。原有限域、性质和边界保留；新增推荐与重复限制由独立 BDD/真实 XState 验收，本旧切片不扩大语义范围。父流程确认全部九入口前保留旧 syncCommit。

KEJ-112 最终同步：全部九个 CI 形式化入口在冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62` 完整通过，真实源码负对照、原版复验及中央独立读回完成后，统一推进覆盖元数据。原始证明中捕获的旧同步值保留；本次同步不表示额外完整复跑，也不扩大原有限保证。见本轮审查的 `syncAdvance`。
# KEJ-113 / KEJ-114 当前维护状态

已按维护流程保留原样源码漂移 blocked，并完成候选逐文件对应审查；详见 [KEJ-113/114 审查](references/drift-review-kej-113-114.json)。当前产品已冻结于 `36916b5c6e974c11f8e51720189c64facef9269e`，候选 coverage 记录精确字节；完整原入口、真实代码负对照、恢复后复验、独立读回与证据反控均已通过；全部九入口及独立读回现已确认，syncCommit 已同步到该产品提交，精确结果见本轮审查记录。旧有限域不自动覆盖新资源正文语义、监督/人工门禁、读写资源租约、归档删除或独立进程守卫。

KEJ-113/114 最终同步：全部九个 CI 形式化入口及独立读回已通过，同步元数据推进到产品 `36916b5c6e974c11f8e51720189c64facef9269e`。原失败/blocked 轨迹、证明时旧同步值和全部原始件保留。该元数据推进不是额外完整运行，仍不扩大原有限保证。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](references/drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](references/drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。
