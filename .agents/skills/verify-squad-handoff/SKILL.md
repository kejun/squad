---
name: verify-squad-handoff
description: "形式化检查 kejun/squad 中已保存的 B 协助结果向 A 交接的原子性、幂等性、停止取消和调度活性。同时检查失败重试资格、retryOf 唯一后继与保存结果复用。修改结果消费、重试、保存/恢复、停止/继续、目标版本或 WorkRunner 时使用；运行 TLC、真实代码迁移回放及故障对照，检查模型漂移。"
---

# Verify squad handoff

先读仓库 `AGENTS.md`，再读[实现对应与边界](references/correspondence.md)。本技能保护一个具体承诺：B 的有效结果已保存后，应只安排一次 A 续办，消费标记和续办一起提交；停止/过期结果不能安排本次续办。违反承诺会丢失核查结果、重复工作，或让已停止的任务继续执行。

## Run

从仓库根执行。需要 Python 3.10+、仓库要求的 Node.js 22.18+（22.x）或 24.11+、Java 11+、curl：

```sh
npm ci
python3 .agents/skills/verify-squad-handoff/scripts/check.py
python3 .agents/skills/verify-squad-handoff/scripts/check-composition.py
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
6. 删除副本，重跑原模型与原实现，核对 coverage.json 列出的覆盖文件哈希未变。完整收集子进程输出后原子保存日志；保留原始日志、图、反例、回放、修改 diff、覆盖清单中全部实现源码副本及证据摘要清单。独立读回还核对捕获源码与本次指纹清单逐项相符。

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

KEJ-113 / KEJ-114 对应维护已完成，受测产品为 `36916b5c6e974c11f8e51720189c64facef9269e`。两入口旧指纹先明确 blocked；逐文件审查、可执行切片排除、真实故障对照和原版复验后，完整检查及独立读回均通过。证据分别为 `reports/kej-113-114-handoff-final`（146 状态、424 边/存储、6 见证、4 代码故障对照、184 保留文件）和 `reports/kej-113-114-handoff-composition-final`（53/26 状态、225/103 边/存储、7 见证、4 代码故障对照、208 保留文件）。清理项全部为 true。

结果为 updated；本技能同步到上述受测字节，九个形式化入口现已全部完成并通过独立证据读回。全局完成仅同步元数据，不冒称额外完整复跑；各入口保留原有限范围。完整源码、夹具维护和范围见 [本轮记录](references/drift-review-kej-113-114.json) 及 [对应说明](references/correspondence.md)。新增监督、人工门、部分交付、物理隔离、负责人 CLI 检查点续办和删除不能据此宣称已被旧有限模型证明。以下旧同步记录保留为历史。


本轮 KEJ-102–105 对应审查及完整检查已通过，当前同步产品/包基线为 `32c26b376b46ae1a03718a6820683b59b802b413`。逐文件分类、原样漂移、受控环境、真实负对照、恢复后复验及独立读回见 [本轮审查](references/drift-review-kej-102-105.json)。原模型、性质、公平性和边界保持；成功响应字节限制与真实进程/SQLite 崩溃验收不扩大本技能的有限保证。成功后仅推进同步元数据并复核指纹、读回原证据，不冒称又完整运行一次。

KEJ-106 历史审查产品基线为 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b`。初轮 `facts.ts`/`reducer.ts` 审查后，最终增量仅改变 `engine.ts` 的 ended 任务恢复选择；本切片逐项排除 discussionId，故退休谓词恒false、普通 ended 仍跳过，原交接状态域保持。最终源码完整检查、独立读回及旧版证据区别见 [KEJ-106 审查](references/drift-review-kej-106.json) 的 engineIncrement。handoff图将RECOVER事务与flush拆开，不动态覆盖新增的ended讨论选择分支；该行为由 coordination 的公共入口实例与产品场景承接，不扩张为成员占用或物理效果证明。以下保留历史对应记录。

历史引用修复审查基线为 `756074087685bed3f52f0e6b6e06caf19c587a01`（产品代码 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`）。49个覆盖文件中两项冻结输入引用传递依赖变化，经逐文件及切片断言审查后，完整模型/双存储回放/真实负对照及独立读回通过。见[BT_F31审查](references/drift-review-raw-input-citation.json)。下文保留历史基线；当前哈希见 coverage.json。

KEJ-100 历史依赖审查基线为 `c1f380da1527b8c22a8aaaaf7aef10cd2695146e`；仅 `package.json` 的空单测集合处理变化，产品源码、模型、性质、边界和回放均沿用原审查。当前指纹及运行状态见 [KEJ-100 审查记录](references/drift-review-kej-100.json) 与 [coverage.json](references/coverage.json)。下列 PR40 基线为产品源码对应审查的历史记录。

PR40 产品源码对应审查：`21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40 的已审 head）。PR40 的逐文件变更分类、旧新指纹与未覆盖新行为见 [drift-review-pr40.json](references/drift-review-pr40.json)；函数级对应见 [correspondence.md](references/correspondence.md)，精确同步与哈希见 [coverage.json](references/coverage.json)。更早审查保留在 [drift-review-2026-11-06.json](references/drift-review-2026-11-06.json)。这些记录是漂移门禁与人工审查，不是任意 TypeScript 等价证明。

覆盖代码变化后，逐项审查 sync commit 到当前的差异：事务是否拆分、守卫/版本/权限是否变化、是否增加新的写入口、投影遗漏是否影响后续行为。更新模型、回放和负对照，再完整运行。只有确认对应且检查完成后，才推进 sync commit 和哈希。产品真实违反性质时保留反例，解释用户损害，未经授权不改产品、不放宽性质。

## Evidence and cleanup

- `baseline/`、`restored/`：实际模型、配置、命令、原始 TLC 日志及带标签状态图。
- `*-code.json` / `*.jsonl`：两种存储的全部边回放、入口探针和失败前缀。
- `reachability/`：防止前置条件从不可达而空通过的反例见证。
- `negative-controls/`：真实代码修改 diff、具体行为失败和对应 TLC 反例。
- `run.json` / `artifacts.json`：源码 SHA、工作区差异、覆盖文件哈希、每步结果、清理状态及证据大小/哈希。

临时产品副本、SQLite 和依赖链接只存在于本轮独立 scratch 目录；finally 删除该目录，证据不删除。coverage.json 列出的全部源码/依赖文件哈希必须与运行前一致，`coveredFilesUnchanged` 只代表清单中的文件。助手不会修改业务代码、现有 `.env` 或用户数据库。强制杀死父进程可能留下临时目录，只清理本轮已确认归属的目录。读取结果时区分模型错误、真实代码错误、对应审查未完成和工具阻塞。

## Helpers and maintenance

两个助手文件均可执行。主入口为上面的 `python3 .../check.py`；`Handoff.tla` / `.cfg` 是声明性检查输入。

`compare.mjs` 可单独诊断：用 `node --import tsx .agents/skills/verify-squad-handoff/scripts/compare.mjs`，后接仓库绝对路径、已有基线 `graph.dot` 和新输出 JSON 的绝对路径；三个路径均取本次真实运行结果。它驱动生产模块，不修改模型或产品。

维护时请求 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-handoff`，遵循[维护流程](references/maintenance.md)。与网页技能 `verify-squad` 配合使用；任一通过都不能替代另一个。

## Sources

KEJ-112 冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62` 的原 Handoff 与 A2 完整检查及独立读回已通过，见[本轮审查](references/drift-review-kej-112.json)。候选覆盖指纹包含三个新增纯 helper；本地请求和推荐不在原图动作域，原交接/重试性质、边界和真实故障对照保持。同步提交在九个形式化入口全部通过前保留旧值；本轮补写结果摘要不声称额外完整复跑。

- [TLA+ Tools CLI](https://github.com/tlaplus/tlaplus/blob/master/USE.md)：工具运行方式。
- [固定 v1.7.4 发行说明](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)：发行版本和原始校验值。
- 结构与维护流程改编自 [pstack](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-formal-verification-skill)，保留 [MIT LICENSE](LICENSE)。


托管宿主若仅注入 `MODEL_API_KEY` 而没有模型端点，`team.config.ts` 的模块默认导出会在回放前报配置错误。验证命令可加前缀 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true`，仅给当前进程提供导入前提；实际回放仍使用显式固定配置，不调用该地址，也不修改用户 `.env`。本轮原配置失败及受控重跑证据均保留。

## KEJ-108 A2：重试资格与唯一后继

完整 handoff 验证需要上述两个入口分别完整通过、分别独立读回。`check.py` 仍检查原 Handoff 图；`check-composition.py` 检查新的失败/已保存两域，不能用其中一个替代另一个。新证据默认写入 `reports/verify-squad-handoff-composition/`；支持同样的 `--jar`、`--evidence`、`--verify-evidence` 参数。每个子进程最多120秒，TLC使用隔离Java临时目录，空白、部分或工具错误均失败。

[组合对应](references/correspondence.md#kej-108-a2重试组合)、[配置](references/composition-suite.json)和[指纹](references/composition-coverage.json)定义精确域：一个任务、A/B两角色、两个新命令身份、最多一个retryOf后继、一个原保存结果、一次恢复、dispatch前最多一次权限或owner变化。起点由真实 submit/claim/HELP/RECORD_RESULT 或失败事件形成；不手写 TaskContext，不修改live store。

`RetryUniqueness`要求原协助最多一条后继；`ExclusiveResultChoice`要求已保存有效结果走消费而不重做B工作；`RetryAuthority`/`RetryOwner`要求新命令使用当前权限和owner；`RetryHandoff`保持消费与唯一A续办一致。已接受命令的相同载荷重放允许返回旧receipt，不视为重新授权。新命令才重新检查资格。旧失败原工作的迟到结果不成为新结果。

每条抽象边分别从一条最短公共前缀在Memory/SQLite重放，恢复的RECOVER事务与Flush分开。七项可达性见证防止未触及资格分支；四项真实代码变异分别删除唯一后继、保存复用、权限、owner守卫，必须在两种存储以目标AssertionError检出；原模型与原实现再次完整复验。Progress依赖ClaimRetry/SaveRetry/ConsumeRetry/ConsumeOriginal的弱公平；不要求用户必然请求重试，也不证明被永久撤销权限的工作必然执行。

读回检查捕获的suite、实际TLC完成/活性/统计、每域所有边的两存储JSONL与目标投影、全部原始负对照JSON/diff、见证集合和清理。负对照错误的原始证据在JSON中；旧兼容日志可能为空。独立读回不是重新执行TLC，也不是恶意作者不可伪造的签名证明。

这仍是有限模型穷举与代表前缀对应；不证明无限重试、任意成员数、dispatch后的owner/工具变化、外部效果恰好一次或所有未投影历史。原Handoff切片的排除项保留于其范围，不把新切片合并成全系统证明。

KEJ-110 当前受审产品为 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9`；本轮逐文件审查、明确改变的预算承诺（如适用）、完整正向/真实负对照/原版复验与独立读回见[KEJ-110审查](references/drift-review-kej-110.json)。仅在全部九个CI形式化入口成功后推进同步元数据；此同步操作不是额外完整复跑，新功能的语义与真实模型供应商行为仍由独立验收负责。

KEJ-111 受审产品为 `c239dd39d86f143a2f435f48590c648b20745b8b`。原 Handoff 与 A2 的有限域、模型、性质、公平性和回放保持；两者不发送新增 `RECORD_TOOL_FAILURE`，且不执行带分片恢复声明的负责人交付。新增纯依赖与每项变化的入口条件见[KEJ-111审查](references/drift-review-kej-111.json)。有界 Web 反馈及负责人证据补齐分别由 coordination 扩展的 ToolRecovery、MapRecovery 切片和直接产品场景承接，不能由原交接通过推导。精确源码完整运行、独立读回与同步状态以该审查的 validation 为准；pending/blocked 不表示通过。

KEJ-112 最终同步：全部九个 CI 形式化入口在冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62` 完整通过，真实源码负对照、原版复验及中央独立读回完成后，统一推进覆盖元数据。原始证明中捕获的旧同步值保留；本次同步不表示额外完整复跑，也不扩大原有限保证。见本轮审查的 `syncAdvance`。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](references/drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](references/drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## 统一工具上下文维护

全量元信息、后台共享快照与直接宿主选择的源码对应审查见 [本轮审查](references/drift-review-unified-tool-context.json)。本轮保留原有限模型、性质、边界与公平性；元信息观察和仅省略模型输出中未使用的空技能标识，不替代原执行许可、按次审批、技能激活、租约、停止或恢复守卫。新增 BT_Y121–BT_Y130 的选择语义、实时目录及实际 UI/模型行为由独立验收承接；不能用旧有限图通过扩大这些保证。完整生产器、真实源码负对照、原版恢复和独立读回的实际状态以本轮审查为准，全部九入口通过前不推进同步提交。

冻结产品 `d865873678688789dbf9399980b841caeed17946` 的九个 CI 形式化入口已完整通过正向、真实源码负对照、原版恢复及独立读回后同步对应基线。本次推进仅改变验证元数据，保留原始证明捕获的旧同步身份；同步后的再次独立读回及原始件未改核对见本轮审查引用的中央索引，不冒称又运行了一遍生产器。
