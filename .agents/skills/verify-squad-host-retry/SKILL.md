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
