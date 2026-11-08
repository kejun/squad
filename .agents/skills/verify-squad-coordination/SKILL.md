---
name: verify-squad-coordination
description: "验证 Squad 的普通请求计费、交付检查与修订上限、两分片乱序结算和唯一归并续办。修改 budget、discussion、map-reduce、领取/恢复/CONSUME 或交付检查重试时使用；运行 TLC、双存储逐边回放与真实代码故障对照。"
---

# Verify squad coordination

先读仓库 `AGENTS.md` 与[代码对应和保证边界](references/correspondence.md)。本技能覆盖 KEJ-96、KEJ-97 的有限协调模型，并提供 KEJ-99 容量的有限实现实例；不替代 B→A 单结果交接、执行授权或交付证据一致性技能。所有运行均使用合成内容，不调用模型供应商、不读取用户数据库。

## 承诺与损害

1. 请求领取和后续请求消耗持久普通额度，自动重试不超过上限，恢复与用户继续不清零历史计费。破坏会导致未计费或超过用户额度的调用。
2. 一个交付周期最多两次普通检查、一次技术重试、一次自动修订；实际 CONSUME 才记检查请求，领取不收费。破坏会把一次自动检查放大成反复付费/修订。
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
- `CheckBudget.tla`：一个交付周期、最多两个候选、一项自动修订、两次普通检查加至多一次技术重试；两次恢复；全局 retry 额度1。覆盖首次请求前失败、请求后失败、结果协议错误、unknown、成功/失败判定、reserved→used、重复恢复、禁止复用已消费许可及修订后新候选。CLAIM 检查不计费，CONSUME 才增加 cycle.requests 与 usage.checks；请求后的第二次不能绕过一次性技术许可。
- `Shards.tla`：一个当前目标，恰好两个分片（success/partial/failed），一个 reducer、一个 owner handoff；允许乱序、重复结果、停止或一次目标替换，以及一次 reopen（包括当前轮安全 inflight 的恢复）。取消后的在途工作只在迟到结果时结算，不做取消后的 inflight RECOVER；不包含新轮次重新分片、分片外部副作用或不安全 replay。

每个模型穷举其完整有限状态图，不使用随机模拟。每条图边从其一个最短可达前缀重新构建真实 `TeamEngine`，分别在 `MemoryStore`、`SqliteStore` 执行公共入口并逐步比较所有模型字段。每条边均检查业务性质。另在每个后端公开入口执行 Claim→保留旧 ticket→Reopen→再 Claim→旧 attempt 迟到的探针，确认拒绝且不结算新 attempt。解析节点和边数必须与 TLC 原始统计匹配，不能遗漏边或用仅执行日志冒充比较。

`capacity-probes.mjs` 在每个存储另跑六个有限实现实例：容量0/1时两片整体回退，容量2时两片完整派发，容量4时四片完整派发，恢复重领后容量4→3时原四片整体回退，以及旧快照缺少提示时重领不补字段、仍按当前容量回退。断言准备时预留一次未付理解请求、CLAIM收费后刷新、无部分派发且owner保留完整计划；另直接调用适配器使用的验证函数，确认数字容量限制与缺省旧协议。这些实例及独立负对照不属于 TLC 状态图，不声称容量或0/1/4片的穷举证明；不执行模型 HTTP、格式修复请求或语义分组。旧快照实例只从公共前缀的持久快照移除新增提示，明确区分于三个模型的可达起点。

`discussion-recovery-probes.mjs` 复用同一真实入口回放驱动，在每个存储另跑13个有限实例：讨论/MapReduce × 换目标/停止后继续的4条链、当前安全工作正常恢复、已取消安全成员移除、3种本地未知效果阶段、LOCAL_RESULT及LOCAL_RECONCILE的已知回执结算，共11条公开入口历史；另有旧版恢复产生pending状态的兼容快照与将replay标为unsafe的守卫输入快照。后两者不声称从当前公开入口可达。实例检查重复恢复不新增计费、成员可重新领取、新轮不受旧回复影响、物理/uncertain/unsafe保留占用事实（未枚举任意新工作竞争）、已知回执保留。它们不扩张原Shards图，尤其不把取消后inflight→RECOVER称为原TLC穷举范围；不运行真实命令或证明OS效果。删除退休步骤/旧成员排除/已知回执退休，或放行unsafe/退休当前轮次，必须由两存储各自的行为断言检出。

这是**有限抽象模型的穷举检查 + 代表前缀的真实实现对应验证**，不是 TypeScript 的机器证明、无限大小证明或全部历史等价证明。文件哈希是漂移门禁，不是行为等价证明。SQLite 事务/文件系统原子性是假设；此处不注入断电、部分磁盘写入或真实网络故障。三个模型不是整个系统的笛卡尔乘积，不证明预算与所有宿主/目标/输入行为的组合。

## 安全、进度与可达性

- Budget：`PaidBudget` 与 `RetryBound`。它验证授权额度而非业务一定完成，终态包括明确等待人、unknown 和额度用尽；没有假定外部请求一定成功。
- CheckBudget：`CheckAccounting`、`BoundedChecks`、`OneTechnicalRetry`、`OneRevision`。达到请求上限后不许再免费检查，失败可以结束为 partial；不把安全上界说成业务成功保证。
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
| 自动修订不记录 revisionUsed | OneRevision |
| 准备理解时不预留本次未收费请求 | CapacitySnapshot（有限实例） |
| 恢复重领不刷新容量 | CapacityRefresh（有限实例） |
| 对缺少提示的历史工作补写容量 | LegacyCapacity（有限实例） |
| 分发绕过当前容量检查 | CapacityDispatch（有限实例） |
| 验证函数忽略适配器传入容量 | CapacityValidation（有限实例） |

一个改坏只能说明对这一变体敏感，不能推出检测全部同类缺陷；NoStaleHandoff 的停止/换目标由全部图边比较和显式迟到拒绝覆盖，不声称对每种越权错误有独立突变完备性。故障副本移除后必须完整重跑三个模型和真实回放；原工作区覆盖文件哈希必须保持不变。

## 实现同步与维护

KEJ-106 对应审查与候选/正式运行状态见 [讨论恢复审查](references/drift-review-kej-106.json)。受审产品提交为 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`；只有 `facts.ts` 与 `reducer.ts` 两项覆盖源码变化。新增安全旧轮次退休保持原事务边界；Budget/CheckBudget显式排除discussion，原Shards的活动恢复、迟到结算及取消后无inflight重开域不变。新增取消恢复链由上述有限实例承接，原TLA模型、配置、性质、公平性和边界未变；不得把新增实例算入TLC状态/边数。完整原始结果与最终同步以审查JSON和coverage.json为准，下列基线为历史记录。

当前审查基线为 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`（BT_M37 检查协议说明、BT_F31 冻结输入引用）。完整检查及独立读回已通过，逐文件对应、额外真实代码负对照与保证边界见[引用链审查](references/drift-review-raw-input-citation.json)和[协议说明审查](references/drift-review-check-envelope.json)；当前指纹见 coverage.json。

KEJ-100 历史依赖审查基线为 `c1f380da1527b8c22a8aaaaf7aef10cd2695146e`；仅 `package.json` 的空单测集合处理变化，产品源码、模型、性质、边界和回放均沿用原审查。当前指纹及运行状态见 [KEJ-100 审查记录](references/drift-review-kej-100.json) 与 [coverage.json](references/coverage.json)。下列 PR40 基线为产品源码对应审查的历史记录。

PR40 产品源码对应审查基线：`21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。从旧基线 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f` 逐文件审查21个变更/新增src依赖；分类、性质影响和首轮完整验证见 [PR40审查记录](references/drift-review-pr40.json)。旧基线是 PR37 合并前head，与 squash 合入的 main `d7b80a4b0e032d300a7201e2532238709eb601cf` 完整树相同。代码范围和精确 SHA 见 [coverage.json](references/coverage.json)。清单保守包含全部 src 模块及 config/package/lock 作为传递依赖漂移门禁；核心函数映射见对应文档，不代表逐个模块均有形式化性质。

代码变化时按[维护流程](references/maintenance.md)逐项核对事务边界、守卫、预算范围、调度与投影，必要时更新模型和驱动。不得仅更新哈希。新性质先从代码/契约定义，不因当前运行失败而放宽；当前实现违反性质时保留真实反例并报告产品缺陷，未经授权不改产品。

维护请求：`$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-coordination`。在生成器维护规则下运行，记录 updated/in sync/bug/blocked、旧新基线、变更原因与真实负对照。仅验证文件的变更无需另造产品 Gherkin 场景；现有 `BT_Q01–06` 与预算/交付场景仍是独立回归入口，不称为本命令直接执行了它们。

## 来源

TLA+ 版本、下载器与证据组织沿用项目 `verify-squad-handoff`。形式化技能维护结构源自 [pstack](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-formal-verification-skill)，保留同目录 MIT LICENSE。
