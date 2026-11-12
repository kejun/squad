---
name: verify-squad-coordination
description: "验证 Squad 的计费与共享预留、输入安全应用、评审及延期协调、取消讨论恢复、交付检查上限和分片归并。修改相关任务守卫、领取/恢复/CONSUME 或交接时使用；运行 TLC、双存储逐边回放与真实代码负对照。"
---

# Verify squad coordination

先读仓库 `AGENTS.md` 与[代码对应和保证边界](references/correspondence.md)。本技能覆盖 KEJ-96、KEJ-97 的有限协调模型，并提供 KEJ-99 容量的有限实现实例；不替代 B→A 单结果交接、执行授权或交付证据一致性技能。所有运行均使用合成内容，不调用模型供应商、不读取用户数据库。

## 承诺与损害

1. 请求领取和后续请求消耗持久普通额度，自动重试不超过上限，恢复与用户继续不清零历史计费。破坏会导致未计费或超过用户额度的调用。
2. 一个交付周期首次缺口少于3项时至多两次自动修订、三次普通检查，首次缺口至少3项时至多三次自动修订、四次普通检查；全周期至多一次技术重试；实际 CONSUME 才记检查请求，领取不收费。破坏会把一次自动检查放大成反复付费/修订。
3. 两个分片全部结算后只生成一个归并，再将完整原始结果交回负责人；partial/failed 不能被成功归并文字抹除，停止和旧目标不能恢复此轮。破坏会遗漏证据、重复调用或在取消后继续工作。

## 运行

需要 Python 3.10+、项目要求的 Node 22.18+/24.11+、Java 11+ 与 curl。先在本 checkout 安装锁定依赖：

```sh
npm ci
python3 .agents/skills/verify-squad-coordination/scripts/check.py
```

默认复用交接技能的固定版本下载器，在用户缓存查找/下载 TLA+ Tools v1.7.4（TLC 2.19）。JAR SHA256 必须为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。可用 `TLA2TOOLS_JAR` 或 `--jar` 指定预置文件。每个 TLC 最多45秒，每个双存储回放最多180秒。每个模型单 worker，512MiB Java 堆。超时或缺依赖不是通过；不得降低边界让超时变绿。

证据默认位于 `reports/verify-squad-coordination/<UTC时间>-<PID>/`。可传 `--evidence` 指定新目录，拒绝覆盖现有目录。只有完整退出0、`run.json.status=verified`、两种存储所有边全部比较一致、真实负对照按目标行为失败且原实现恢复后再次通过才算通过。对输出的证据目录单独读回：

```sh
python3 .agents/skills/verify-squad-coordination/scripts/check.py --verify-evidence "$SQUAD_COORDINATION_EVIDENCE"
```

读回检查 manifest 与每个原始文件的 SHA/大小、检查状态、TLC状态/迁移数和两存储回放数量。它验证保存证据的完整性，不是密码学签名或远端证明。

## 检查内容与边界

- `Budget.tla`：一项普通 owner 工作，最多两个明确用户 epoch；额度初始3、用户明确追加2后5；自动重试上限1；一次安全 inflight 恢复。CLAIM 收费，首次 CONSUME 使用已收费用，后续 CONSUME 另收费；已耗额度恢复后不返还。CONTINUE 仅在结算后发生，保留全局 usage/retries，增加 epoch。模型不将 RECOVER 当作一次自动失败重试，它可能重新领取并另付普通额度。
- `CheckBudget.tla`：一个交付周期、最多四个候选、首次确定失败项1或3时分别分配2或3次自动修订、普通检查上限为固定修订上限加1，另至多一次技术重试；两次恢复；全局 retry 额度1。覆盖首次请求前失败、请求后失败、结果协议错误、unknown、成功/失败判定、reserved→used、重复恢复、禁止复用已消费许可及修订后新候选。CLAIM 检查不计费，CONSUME 才增加 cycle.requests 与 usage.checks；请求后的第二次不能绕过一次性技术许可。
- `Shards.tla`：一个当前目标，恰好两个分片（success/partial/failed），一个 reducer、一个 owner handoff；允许乱序、重复结果、停止或一次目标替换，以及一次 reopen（包括当前轮安全 inflight 的恢复）。取消后的在途工作只在迟到结果时结算，不做取消后的 inflight RECOVER；不包含新轮次重新分片、分片外部副作用或不安全 replay。

每个模型穷举其完整有限状态图，不使用随机模拟。每条图边从其一个最短可达前缀重新构建真实 `TeamEngine`，分别在 `MemoryStore`、`SqliteStore` 执行公共入口并逐步比较所有模型字段。每条边均检查业务性质。另在每个后端公开入口执行 Claim→保留旧 ticket→Reopen→再 Claim→旧 attempt 迟到的探针，确认拒绝且不结算新 attempt。解析节点和边数必须与 TLC 原始统计匹配，不能遗漏边或用仅执行日志冒充比较。

`capacity-probes.mjs` 在每个存储另跑六个有限实现实例：容量0/1时两片整体回退，容量2时两片完整派发，容量4时四片完整派发，恢复重领后容量4→3时原四片整体回退，以及旧快照缺少提示时重领不补字段、仍按当前容量回退。断言准备时预留一次未付理解请求、CLAIM收费后刷新、无部分派发且owner保留完整计划；另直接调用适配器使用的验证函数，确认数字容量限制与缺省旧协议。这些实例及独立负对照不属于 TLC 状态图，不声称容量或0/1/4片的穷举证明；不执行模型 HTTP、格式修复请求或语义分组。旧快照实例只从公共前缀的持久快照移除新增提示，明确区分于三个模型的可达起点。

`discussion-recovery-probes.mjs` 另跑双存储各15个有限实例：13条公开入口历史与2个明确标注的快照输入。修改讨论取消/终局恢复、成员占用或本地效果核对时，先读[实例分类与实现对应](references/correspondence.md#kej-106-旧讨论工作的安全退休)，再核对[本轮审查及6项新增真实负对照](references/drift-review-kej-106.json)。这些实例与原Shards图分开计数，不扩大TLC穷举域，也不执行真实命令。

这是**有限抽象模型的穷举检查 + 代表前缀的真实实现对应验证**，不是 TypeScript 的机器证明、无限大小证明或全部历史等价证明。文件哈希是漂移门禁，不是行为等价证明。SQLite 事务/文件系统原子性是假设；此处不注入断电、部分磁盘写入或真实网络故障。三个模型不是整个系统的笛卡尔乘积，不证明预算与所有宿主/目标/输入行为的组合。

## 安全、进度与可达性

- Budget：`PaidBudget` 与 `RetryBound`。它验证授权额度而非业务一定完成，终态包括明确等待人、unknown 和额度用尽；没有假定外部请求一定成功。
- CheckBudget：`CheckAccounting`、`BoundedChecks`、`OneTechnicalRetry`、`BoundedRevisions`。达到请求上限后不许再免费检查，失败可以结束为 partial；不把安全上界说成业务成功保证。
- Shards：`AllSettledBeforeReduce`、`UniqueHandoff`、`PreserveIncomplete`、`NoStaleHandoff`。`Progress` 在用户不终止/换目标时依赖对可执行的领取/返回/归并动作 `ProgressStep` 的弱公平。在此有限有向推进结构中，公平的有效推进最终交回 owner。它假定执行器最终返回结果、调度最终领取工作，不证明生产调度器公平或模型供应商可用。
- 每条声明的 reachability 用独立、故意为假的 `Never...` 不变量运行 TLC，只有明确违反对应不变量才成立。包括重试、额度用尽、用户继续、恢复后再次收费、unknown、三次检查、重复恢复时已预留许可、修订、第二分片先到、partial/failed 后完成归并、停止/旧目标在途和中断恢复。

## 故障检出

在隔离源码副本中运行以下改坏版本，仍使用**不变的正确模型图与回放驱动**，不能靠修改模型或哈希拒绝冒充行为检出。MemoryStore 与 SQLite 各自必须失败，且错误包含表中业务性质；导入/构建/依赖失败不合格。

| 实际代码改坏 | 必须检出 |
| --- | --- |
| 不对普通 CLAIM 计费 | PaidBudget |
| 忽略自动重试上限 | RetryBound |
| 第一个分片结果就安排 reducer | AllSettledBeforeReduce |
| 丢弃 partial 的 incomplete 标记 | PreserveIncomplete |
| 重复安排 owner 续办 | UniqueHandoff |
| 最后一个分片结算后遗漏 reducer | ProgressHandoff |
| 接受重开前旧分片 attempt | NoStaleAttempt |
| CONSUME 不记 usage.checks | CheckAccounting |
| 复用已消费的检查请求许可 | BoundedChecks |
| 技术 retry 预留不记次数 | OneTechnicalRetry |
| 自动修订不记录 revisionUsed / 已用计数，或把上限扩为4 | BoundedRevisions |
| 准备理解时不预留本次未收费请求 | CapacitySnapshot（有限实例） |
| 恢复重领不刷新容量 | CapacityRefresh（有限实例） |
| 对缺少提示的历史工作补写容量 | LegacyCapacity（有限实例） |
| 分发绕过当前容量检查 | CapacityDispatch（有限实例） |
| 验证函数忽略适配器传入容量 | CapacityValidation（有限实例） |

一个改坏只能说明对这一变体敏感，不能推出检测全部同类缺陷；NoStaleHandoff 的停止/换目标由全部图边比较和显式迟到拒绝覆盖，不声称对每种越权错误有独立突变完备性。故障副本移除后必须完整重跑三个模型和真实回放；原工作区覆盖文件哈希必须保持不变。

## 实现同步与维护

本轮 KEJ-102–105 对应审查及完整检查已通过，当前同步产品/包基线为 `32c26b376b46ae1a03718a6820683b59b802b413`。逐文件分类、原样漂移、受控环境、22 项真实代码负对照、三套模型恢复后复验及独立读回见 [本轮审查](references/drift-review-kej-102-105.json)。原模型、性质、公平性和边界保持；成功响应字节限制与真实进程/SQLite 崩溃验收不扩大本技能的有限保证。成功后仅推进同步元数据并复核指纹、读回原证据，不冒称又完整运行一次。

KEJ-106 历史最终受审产品为 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b`，该轮同步与验证状态见 [KEJ-106 审查记录](references/drift-review-kej-106.json)。维护读取 facts/reducer 的首轮修复及 Engine 的终局恢复选择增量；代码到模型和新增有限实例的边界见[对应说明](references/correspondence.md#kej-106-旧讨论工作的安全退休)。原TLA/CFG、性质、公平性和边界保持不变。下列基线均为历史记录。

历史审查基线为 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`（BT_M37 检查协议说明、BT_F31 冻结输入引用）。完整检查及独立读回已通过，逐文件对应、额外真实代码负对照与保证边界见[引用链审查](references/drift-review-raw-input-citation.json)和[协议说明审查](references/drift-review-check-envelope.json)；当前指纹见 coverage.json。

KEJ-100 历史依赖审查基线为 `c1f380da1527b8c22a8aaaaf7aef10cd2695146e`；仅 `package.json` 的空单测集合处理变化，产品源码、模型、性质、边界和回放均沿用原审查。当前指纹及运行状态见 [KEJ-100 审查记录](references/drift-review-kej-100.json) 与 [coverage.json](references/coverage.json)。下列 PR40 基线为产品源码对应审查的历史记录。

PR40 产品源码对应审查基线：`21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。从旧基线 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f` 逐文件审查21个变更/新增src依赖；分类、性质影响和首轮完整验证见 [PR40审查记录](references/drift-review-pr40.json)。旧基线是 PR37 合并前head，与 squash 合入的 main `d7b80a4b0e032d300a7201e2532238709eb601cf` 完整树相同。代码范围和精确 SHA 见 [coverage.json](references/coverage.json)。清单保守包含全部 src 模块及 config/package/lock 作为传递依赖漂移门禁；核心函数映射见对应文档，不代表逐个模块均有形式化性质。

代码变化时按[维护流程](references/maintenance.md)逐项核对事务边界、守卫、预算范围、调度与投影，必要时更新模型和驱动。不得仅更新哈希。新性质先从代码/契约定义，不因当前运行失败而放宽；当前实现违反性质时保留真实反例并报告产品缺陷，未经授权不改产品。

维护请求：`$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-coordination`。在生成器维护规则下运行，记录 updated/in sync/bug/blocked、旧新基线、变更原因与真实负对照。仅验证文件的变更无需另造产品 Gherkin 场景；现有 `BT_Q01–06` 与预算/交付场景仍是独立回归入口，不称为本命令直接执行了它们。

## 来源

TLA+ 版本、下载器与证据组织沿用项目 `verify-squad-handoff`。形式化技能维护结构源自 [pstack](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-formal-verification-skill)，保留同目录 MIT LICENSE。


托管宿主若仅注入 `MODEL_API_KEY` 而没有模型端点，`team.config.ts` 的模块默认导出会在回放前报配置错误。验证命令可加前缀 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true`，仅给当前进程提供导入前提；实际回放仍使用显式固定配置，不调用该地址，也不修改用户 `.env`。本轮原配置失败及受控重跑证据均保留。

## KEJ-107/108 协作组合扩展

在原三模型检查之外，还必须执行独立组合入口：

```sh
python3 .agents/skills/verify-squad-coordination/scripts/check-extensions.py
```

使用与原入口相同的固定 TLA+ Tools 1.7.4（`TLA2TOOLS_JAR` 或 `--jar` 可指定）。每次 Java 调用使用该模型证据目录内独立的 `java-tmp`，避免并行TLC抽取标准模块相互删除。Node 运行若受 MODEL_API_KEY 导入前提影响，使用本文末尾相同受控环境前缀，不调用模型 HTTP。

扩展保护五项用户承诺：共享普通额度不被额外请求侵占已承诺后继；补充先经过安全解释再续办且旧检查不能越过；取消讨论的已知旧工作退休、未知效果先核对；评审队列不漏成员、不重复汇总且显式修复保留其余结果；延期协调请求在安全边界履行或被用户停止。分别由 DiscussionBudget、ReservedRequests、InputBoundary、CancelledDiscussion、ReviewQueue、DeferredCoordination 六份TLA覆盖。确切21个配置、状态载体、公开前缀及原子动作见 [新增对应说明](references/correspondence.md#kej-107108协作组合的新增有限域) 与 [扩展覆盖记录](references/extensions-coverage.json)。它们是独立小模型，不声称全系统组合或任意大小证明。

必须完成全部21配置的TLC、每条边在MemoryStore/SQLite的代表前缀回放、声明的独立可达性见证、18项隔离真实源码负对照（双存储）、未改坏原版全域复验与独立读回。只有退出0、run.json.status=verified且cleanup全部true才通过；导入失败、超时、图不完整或非目标断言失败不得计通过。每个TLC最多45秒、每个回放最多180秒；不得缩小原域让超时通过。证据位于 reports/verify-squad-coordination/extensions-*，拒绝覆盖旧目录。读回命令：

```sh
python3 .agents/skills/verify-squad-coordination/scripts/check-extensions.py --verify-evidence "$SQUAD_COORDINATION_EXTENSION_EVIDENCE"
```

扩展由场景 BT_J01–J06 的18个直接实例提供独立产品行为验收；不把TLC回放冒称运行Gherkin，也不把这18例称为穷举。安全与进度分开：ReservedRequests仅保护授权/计费；其他模型的公平推进、有限恢复及可信效果最终结算假设见对应说明。未知效果永久不返回时只保证保留占用，不保证最终释放。SQLite事务是模型原子性假设，不证明数据库抗断电、真实CLI或供应商可用。

扩展覆盖源变化时，按本文维护流程逐文件审阅，更新模型/回放和真实负对照后完整运行；不要仅刷新扩展覆盖哈希。单个已保存R1的原子消费和自适应检查上限仍由既有handoff/CheckBudget承接，未在本域重复申报新保证。

KEJ-107/108 原三图已在产品e77f052源码上完整复验（339.6秒）并独立读回330份证据，记录见coverage.json末项。runtime/skills缓存准备与WebService关闭守卫已逐项审阅，原保证不扩大。新增21域仍以本轮扩展入口最终run.json及独立读回为完成依据，不用原三图通过代替新增验证。

扩展读回固定校验每模型必需INVARIANTS及Progress/RetirementProgress，实际TLC日志/图/配置/结果，保存的逐边JSONL完整性、双存储真实投影与正常子进程退出码。全部covered源码与未提交fixture正文归档；真实负控须保留原始JSON/log/diff且正常exit=1、AssertionError和目标性质。还必须拒绝5种外层SHA已自洽更新的删除：负控JSON、负控日志、真实diff、必需进度性质及fixture正文。它保证证据协议完整，不是数字签名或远端证明。

本次新增域已完整执行通过：`reports/verify-squad-coordination/kej-107-108-extensions-complete`，389.684秒；21配置、58见证、18项双存储真实代码负对照、全域原版复验、5项自洽删除读回负控，889份原始证据独立读回通过。两阶段各自每个存储均比较2998条边。源码基线为e77f052acacd208fd8eb8587ac6901ba19003220；具体fingerprint和成功记录在extensions-coverage.json。后续变更仍须重做对应审查与执行，不能直接照抄本次统计。

## KEJ-110 自适应交付预算维护

原承诺“一次自动修订、两次普通检查与一次技术重试”按需求 KEJ-110 和直接验收 BT_F77–BT_F81 明确改变为“首次确定失败项少于3项固定2次修订，至少3项固定3次；普通检查至多修订上限加1，全周期技术重试仍至多一次”。任务 checks/ordinary/retries 总上限不变。

`CheckBudget` 增加持久修订上限和已用计数；一个或三个失败项分别通过真实 CHECK_RESULT 驱动，在第一次分配后不随后续结果扩张。全部435状态图（以实际TLC结果为准）及每边双存储对应另需完整运行，不沿用旧117状态统计。`BoundedRevisions` 验证已用计数等于独立 owner 意图计数、marker 与是否已修订一致，以及从未超过固定上限。真实负对照保留漏marker并增加漏已用计数和超三次上限；不能把模型允许更多付费请求当作取消计费或技术重试保护。

旧快照已耗唯一修订、不足普通或checks额度、unverified及停止/迟到回执仍由直接产品模型场景承接；本TLC切片不假装穷举这些新增组合。完整执行和sync状态以本轮审查记录为准，原样 blocked 证据在 `reports/verify-squad-coordination/kej-110-original-drift`。

KEJ-110 当前受审产品为 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9`；本轮逐文件审查、明确改变的预算承诺（如适用）、完整正向/真实负对照/原版复验与独立读回见[KEJ-110审查](references/drift-review-kej-110.json)。仅在全部九个CI形式化入口成功后推进同步元数据；此同步操作不是额外完整复跑，新功能的语义与真实模型供应商行为仍由独立验收负责。

## KEJ-111 工具失败反馈与分片补齐

KEJ-112 冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62` 的两入口完整验证与独立读回已通过，见[逐文件审查与证据](references/drift-review-kej-112.json)。新推荐/诊断投影及 CLI 重复失败守卫没有扩大原有限图；CLI 重复上限由独立产品模型/BDD承接，不将 Web ToolRecovery 证明用于 CLI。保留首次并发负载下的180秒回放超时，使用相同边界和超时在新目录完整重跑通过。正式 syncCommit 仍等待项目全部九入口汇总通过后统一推进。

修改 `RECORD_TOOL_FAILURE`、`partitionRecoveries`、检查指定来源或分片 resolution 时，运行原入口与扩展入口。扩展当前包含23配置、70项可达见证、29项双存储真实源码负对照及6项自洽证据删除负对照。原21域和原三图的性质、边界及超时保持；新增域的精确前缀、投影和保证范围见[KEJ-111对应说明](references/correspondence.md#kej-111-工具失败反馈与分片补齐)。

ToolRecovery 验证两次持久失败反馈上限、已收费请求身份、重复拒绝、恢复后累计、普通预算和截止边界。MapRecovery 验证当前候选的独立检查、指定完整来源逐字引用、全部分片债务关闭后才发布，以及原失败状态与结果保持。原 Shards 的终点仍是负责人交接；`PreserveIncomplete` 在该域保持，后续补齐由新图承接。

新增驱动正文必须归档并由读回器明确要求。MapRecovery 的六项无效来源/声明探针使用公开事件前缀；独立评审缺口探针标为有限快照输入，不声称图枚举了评审与分片生命周期的组合。语义正确性由独立检查者承担；图证明证据和结论的绑定，不证明任意正文含义、实际HTTP/CLI成功或供应商活性。

KEJ-112 最终同步：全部九个 CI 形式化入口在冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62` 完整通过，真实源码负对照、原版复验及中央独立读回完成后，统一推进覆盖元数据。原始证明中捕获的旧同步值保留；本次同步不表示额外完整复跑，也不扩大原有限保证。见本轮审查的 `syncAdvance`。

## KEJ-113/114 维护

修改独立cleanup、逻辑终止或资源责任时，先读[本轮对应说明](references/correspondence.md#kej-113114逻辑终止独立清理与执行恢复)和[逐文件审查及验证结果](references/drift-review-kej-113-114.json)。原三个模型保持；CancelledDiscussion把新内容继续与未知物理责任分别投影，新增真实Store租约保留及cleanup所有权性质/负对照。两个入口仍必须完整执行并独立读回；pending记录不算成功，不推进sync。精确当前域/控制/见证以checker和原始结果为准。


KEJ-113/114 最终复验：冻结产品 `36916b5c6e974c11f8e51720189c64facef9269e`，本技能两个完整入口均完成真实源码负对照、原版复验和各自独立读回，结果为 updated。最终原始证据分别为 `reports/kej-113-114-four-formal-36916b5-final-3/coordination`、`reports/kej-113-114-four-formal-36916b5-final-3/coordination-extensions`；汇总与最新独立读回位于 `reports/kej-113-114-four-formal-36916b5-final-3`。精确计数、首轮冗余负控失败与维护理由见[逐文件审查](references/drift-review-kej-113-114.json)。同步元数据不表示额外完整运行；本技能有限域不证明新宿主、网页、人类门或删除行为的全部组合。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](references/drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](references/drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](references/drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## 统一工具上下文维护

全量元信息、后台共享快照与直接宿主选择的源码对应审查见 [本轮审查](references/drift-review-unified-tool-context.json)。本轮保留原有限模型、性质、边界与公平性；元信息观察和仅省略模型输出中未使用的空技能标识，不替代原执行许可、按次审批、技能激活、租约、停止或恢复守卫。新增 BT_Y121–BT_Y130 的选择语义、实时目录及实际 UI/模型行为由独立验收承接；不能用旧有限图通过扩大这些保证。完整生产器、真实源码负对照、原版恢复和独立读回的实际状态以本轮审查为准，全部九入口通过前不推进同步提交。

冻结产品 `d865873678688789dbf9399980b841caeed17946` 的九个 CI 形式化入口已完整通过正向、真实源码负对照、原版恢复及独立读回后同步对应基线。本次推进仅改变验证元数据，保留原始证明捕获的旧同步身份；同步后的再次独立读回及原始件未改核对见本轮审查引用的中央索引，不冒称又运行了一遍生产器。


## 三小时处理窗口与工具经验维护

修改窗口续办、自动目录、共享经验或 stdin 时，读取[本轮源码对应审查](references/drift-review-window-tool-experience.json)。该记录区分旧有限图与新增实际模型、进程和界面验收，列出原样漂移、候选源码指纹及完整验证状态。九入口全部通过并完成独立读回后，才推进同步提交。
