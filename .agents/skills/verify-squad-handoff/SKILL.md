---
name: verify-squad-handoff
description: "形式化检查 kejun/squad 中已保存的 B 协助结果向 A 交接的原子性、幂等性、停止取消和调度活性。修改结果消费、保存/恢复、停止/继续、目标版本或 WorkRunner 时使用；运行 TLC、真实代码迁移回放及故障对照，检查模型漂移。"
---

# Verify squad handoff

先读仓库 `AGENTS.md`，再读[实现对应与边界](references/correspondence.md)。本技能保护一个具体承诺：B 的有效结果已保存后，应只安排一次 A 续办，消费标记和续办一起提交；停止/过期结果不能安排本次续办。违反承诺会丢失核查结果、重复工作，或让已停止的任务继续执行。

## Run

从仓库根执行。需要 Python 3.10+、仓库要求的 Node.js 22.18+（22.x）或 24.11+、Java 11+、curl：

```sh
npm ci
python3 .agents/skills/verify-squad-handoff/scripts/check.py
```

首次运行下载固定的 TLA+ Tools v1.7.4（TLC 2.19），后续复用用户缓存。JAR 的 SHA-256 必须为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。已准备 JAR 时设置 `TLA2TOOLS_JAR`，或传 `--jar` 绝对路径。TLC 使用单 worker、512MiB Java 堆，不需要浏览器、模型 API Key 或供应商服务。

默认证据保留在 `reports/verify-squad-handoff/<UTC时间>-<PID>/`。`--evidence` 可指定新的目录；拒绝覆盖已有目录。每个子进程最多45秒，下载最多50秒；超时、依赖错误或未完成探索都不能算通过。

## Read the result

只有命令完整退出0，`run.json.status=verified`、清理项全部为 true 且证据校验通过才通过。完整命令结束后，把输出的真实证据目录赋给 `SQUAD_FORMAL_EVIDENCE`，另行执行：

```sh
python3 .agents/skills/verify-squad-handoff/scripts/check.py --verify-evidence "$SQUAD_FORMAL_EVIDENCE"
```

该命令只读核对保留文件的大小、SHA-256、TLC 原始日志及检查状态；空日志、被截断/修改的证据或未完成的运行都返回非零。主助手依次执行：

1. 比较[覆盖记录](references/coverage.json)中的源码和依赖哈希。变化时返回 blocked，先完成代码到模型审查；不能只重新计算哈希让检查变绿。
2. 用 TLC 对[模型](scripts/Handoff.tla)和[配置](scripts/Handoff.cfg)做完整有限状态探索，检查安全不变量及独立的活性性质。
3. 解析 TLC 带动作标签的图。对每条边，从真实提交入口重放其最短可达前缀，在 MemoryStore 和 SQLite 上逐步比较模型投影，检查真实代码的不变量。
4. 用六个故意为假的不变量产生可达性见证：有效结果、成功交接、停止但尚未归档、旧目标、回滚、停止后新轮次。预期的非零退出必须明确是对应不变量被违反，不能是语法/依赖错误。
5. 在隔离源码副本中运行四个真实代码负对照，各自在 MemoryStore 和 SQLite 上独立执行，并检查各自的模型反例。真实代码变体仍使用未修改的基线模型图；由行为检查捕捉差异，而非仅靠源码哈希。
6. 删除副本，重跑原模型与原实现，核对 coverage.json 列出的覆盖文件哈希未变。完整收集子进程输出后原子保存日志；保留原始日志、图、反例、回放、修改 diff 及证据摘要清单。

`run.json`、`baseline/tlc.log`、实际 cfg 记录工具、命令、性质、边界、状态数、队列和完成情况。读取原始统计，不从示意图推断覆盖；最后队列为0且有 temporal checking 完成记录才算完整模型检查。模拟、缩小边界和单条成功执行不等于原范围验证。

## Properties and assumptions

| 性质 | 检查内容 |
| --- | --- |
| `AtomicHandoff` | 逻辑结果消费与存在 A 续办意图一致；已交接结果有持久消费标记 |
| `AtMostOnce` | 一个 R1 最多生成一条对应 A 续办意图、一条 B 公开答复 |
| `StopCancelsResume` | stopped 时，没有仍 pending/inflight 的 R1 续办意图 |
| `Progress` | 有效待消费的 R1 最终交接，或被用户停止、换轮次、换目标明确失效 |

活性假设与安全分开：恢复动作和持续可执行的 Flush 满足弱公平；最多一次进程丢失和一次提交失败，所以之后有稳定的调度机会。真实 `WorkRunner.runOne` 探针证明该路径实际可走，不证明生产调度器一定公平。A 的外部请求执行、报告交付、无限故障下的进度不在本技能活性结论内。

**精确范围：** 一个任务、A/B 两名角色、一个已保存且未消费的 R1、一项原协助；epoch=1..2、goalVersion=1..2；最多一次 Crash、一次回滚失败；重复送达、消费和重开允许任意重复；续办意图只检查生成/取消，不领取执行。起点经 submit → claim A → HELP → claim B → RECORD_RESULT 到达。原子动作对应一个存储事务；恢复中的 RECOVER 事务与 flush 循环被拆开，未合并为一个原子步骤。

这是**有限抽象模型的穷举检查 + 有限迁移的真实代码对应验证**，不是 TypeScript 的机器证明或无限规模证明。每条抽象边只重放一条代表前缀；不能据此推出所有隐藏状态、所有具体历史都等价。模型沿用 SQLite 事务原子性的假设，回滚探针检查实现契约，未证明 SQLite/文件系统/断电行为。详细范围见对应文档。

## Negative controls

| 隔离副本中的真实改坏 | 必须检出的性质 |
| --- | --- |
| 删除 R1 的持久消费标记 | 保存结果重试入口违反 `AtomicHandoff` |
| 重复安排 A 续办 | `AtMostOnce` |
| 停止时保留 pending owner | `StopCancelsResume` |
| WorkRunner 跳过 flushResults | `RunnerProgress` 探针不再推进；匹配模型违反 `Progress` |

失败必须来自这些行为断言，而非无法导入、依赖缺失或构建错误。单个负对照仅证明对该类变更敏感。特别是删消费标记时，普通 flush 会拒绝提交，显式重试入口却可能提交不完整标记；助手同时检查两条真实入口，避免用错误原因宣布检出。

## Coverage and synchronization

最近核对实现的提交：`06be10113d80a8e884d93b9e3c6d5877143bf2c7`。函数级对应关系在[correspondence.md](references/correspondence.md)，哈希和边界在[coverage.json](references/coverage.json)。这些记录是审查与漂移门禁，不是自动等价证明。

覆盖代码变化后，逐项审查 sync commit 到当前的差异：事务是否拆分、守卫/版本/权限是否变化、是否增加新的写入口、投影遗漏是否影响后续行为。更新模型、回放和负对照，再完整运行。只有确认对应且检查完成后，才推进 sync commit 和哈希。产品真实违反性质时保留反例，解释用户损害，未经授权不改产品、不放宽性质。

## Evidence and cleanup

- `baseline/`、`restored/`：实际模型、配置、命令、原始 TLC 日志及带标签状态图。
- `*-code.json` / `*.jsonl`：两种存储的全部边回放、入口探针和失败前缀。
- `reachability/`：防止前置条件从不可达而空通过的反例见证。
- `negative-controls/`：真实代码修改 diff、具体行为失败和对应 TLC 反例。
- `run.json` / `artifacts.json`：源码 SHA、工作区差异、覆盖文件哈希、每步结果、清理状态及证据大小/哈希。

临时产品副本、SQLite 和依赖链接只存在于本轮独立 scratch 目录；finally 删除该目录，证据不删除。coverage.json 列出的14个源码/依赖文件哈希必须与运行前一致，`coveredFilesUnchanged` 只代表这14个文件。助手不会修改业务代码、现有 `.env` 或用户数据库。强制杀死父进程可能留下临时目录，只清理本轮已确认归属的目录。读取结果时区分模型错误、真实代码错误、对应审查未完成和工具阻塞。

## Helpers and maintenance

两个助手文件均可执行。主入口为上面的 `python3 .../check.py`；`Handoff.tla` / `.cfg` 是声明性检查输入。

`compare.mjs` 可单独诊断：用 `node --import tsx .agents/skills/verify-squad-handoff/scripts/compare.mjs`，后接仓库绝对路径、已有基线 `graph.dot` 和新输出 JSON 的绝对路径；三个路径均取本次真实运行结果。它驱动生产模块，不修改模型或产品。

维护时请求 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-handoff`，遵循[维护流程](references/maintenance.md)。与网页技能 `verify-squad` 配合使用；任一通过都不能替代另一个。

## Sources

- [TLA+ Tools CLI](https://github.com/tlaplus/tlaplus/blob/master/USE.md)：工具运行方式。
- [固定 v1.7.4 发行说明](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)：发行版本和原始校验值。
- 结构与维护流程改编自 [pstack](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-formal-verification-skill)，保留 [MIT LICENSE](LICENSE)。
