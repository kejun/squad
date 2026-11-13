# 当前单向交付对应（2026-11-12）

当前维护范围、逐文件分类、退休性质及版本链真实反例见 [本轮审查](../../../../docs/implementation/forward-delivery-formal.md) 与 [逐文件记录](../../../../docs/implementation/forward-delivery-formal-review.json)。精确源码和同步状态见 coverage.json。以下旧章节中的自动作者修订、MapRecovery、验证失败不交付等描述仅保留为历史；与当前流程冲突时采用本节及实际模型/配置。

- Delivery：单任务、候选、文档及固定技能回执，goal1..2，一次崩溃/回滚。AtomicPublication、CurrentCandidate、VersionIsolation 与 Progress 保留；九种损坏回执是独立有限输入检查。
- Verification：单检查、一次验证成功/失败、最多两次请求（含提前补救）、两个工作区版本、一次最终复核与回滚/重开。允许验证前请求模型；HonestVerification 要求缺失/失败/版本变化进入正文，OrderedPublication 保护停止及发布原子性。
- Cycles：三个明确用户周期、四个文档修订、一次下游直接修正、一次回滚/重开。RetainedPublication、CurrentCandidate、OneFinalPerCycle 与 Progress 保留；不再经过作者自动修订。
- SourceLineage：同群三个任务，A 两版，B 冻结 A1，C 只引用 B，包含停止/续办和一次重开。FrozenSource 与 DirectLineage 保留。
- 主 check.py 自动运行三个组合切片；临时开发可单独运行 composition-check.py，不能据此宣称完整技能通过。

实现连接仍是 TLC 全图与真实 TeamEngine 公开事务的一边一代表前缀对照；冻结原文、版本、授权、停止和未决效果保护分别保留。CHECK_RESULT 中直接修正、结论保存及 finish 是同一事务；工具请求/领取/启动/结果各自是独立事务。验证输出为信息，不能让 failed/unverified 自动变为 verified。

## 历史对应与原始证据

BT_F31冻结原始输入引用的来源链修复见[对应审查](drift-review-raw-input-citation.json)；保留精确ID/逐字引用、原子边界和预算性质。

# 交付模型与实现对应审查

BT_M37 检查信封说明审查：基于 `670df3e08d80a2179c4ab9e733e7f810bb1a0bbe`，仅 `checkMessages` 两条协议提示文本改变；模型、投影、守卫、事务和回放边界不变。逐项审查与验证状态见 [检查信封审查](drift-review-check-envelope.json)。

KEJ-100 依赖审查：`c1f380da1527b8c22a8aaaaf7aef10cd2695146e`，仅空单测集合的 CLI 处理变化；无产品转移、守卫、事务或模型变更。当前审查及完整复跑证据见 [drift-review-kej-100.json](drift-review-kej-100.json)。以下保留 PR40 的产品源码审查。

审查基线 `21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。前一次基线为 cd987f2f4a7e29ad3efae1af36a0f432ce813c8f（PR37合并前head，其树与squash后d7b80a4相同）。PR40逐文件审查与完整验证见下文和 drift-review-pr40.json。验证更新不修改产品文件；此文件是人工审查记录，不是自动等价证明。

## 数据与可达前缀

compare.mjs 使用真实 TeamEngine 公共入口，不直接写持久存储。submit 创建 requiredArtifacts=1 的任务；claim owner 后 requestLocal/claimLocal/LOCAL_RESULT 保存完整 readSkillResource 回执；DELIVER 生成一个文档、候选和绑定检查；claim check、CONSUME 取得一次检查请求许可。模型 Init 位于此处，非凭空构造 TaskContext。每次重放均新建 MemoryStore 或 SQLite 文件，前缀的每项结果必须成功。

模型只投影 publication 的存在、final 消息数、stopped、goalVersion、在线/故障标记及 staleAccepted；字符串 revision 与 artifactIds 不进入有限模型，但回放每步用真实初始候选值核对。随机 session、trace、reply 和消息 ID 不进入投影，其余具体历史并未自动证明可忽略。

## 原子动作

| 模型动作 | 真实实现 | 审查边界 |
|---|---|---|
| Publish | TeamEngine.send(CHECK_RESULT) → policy.boundCheckProblem → checkDisposition → reducer → operations.finish → storeTask | 一个 Store.transact 提交，发布、outcome 和 final 一起更新 |
| StaleRevision | 同一请求但 candidateRevision 不相等 | boundCheckProblem 在进入结果处理前拒绝；拒绝回执可保存但不改变发布投影 |
| Duplicate | 已发布后重复 CHECK_RESULT | consumedResults / 终态守卫拒绝；不重复 final 或发布 |
| Stop | TeamEngine.send(STOP) | reducer 标记 stopped 并取消工作；本模型只允许首次发布之前停止 |
| ChangeGoal | TeamEngine.send(USER_INPUT with goal) | 输入更新目标版本、取消旧工作；本模型一次换目标且不创建第二个交付候选 |
| LateCheck | STOP、换目标或成功后重发原检查 | task.machine、lifecycle、policy 的工作状态/fence 与终态检查共同拒绝 |
| Crash | 丢弃进程内 TeamEngine 引用 | 不改持久数据，模拟进程丢失而非操作系统 kill 或断电 |
| Reopen | 重开 SQLite 连接和 TeamEngine constructor | 不调用 recover；明确不合并任何 recovery 事务 |
| Rollback | Store.failNextCommit 注入 CHECK_RESULT 提交失败 | 比较完整 store.read(room) 前后完全相等，并要求 thrown 原因是 Injected commit failure；失败 engine 丢弃再打开 |

store.ts 的 MemoryStore 克隆事务提交、SQLite transaction/rollback 是模型原子性假设；回放检查适配实现契约，不证明底层数据库自身的持久性。

## 冻结证据输入验证

src/task/evidence.ts 的 settledSources 只取当前目标已结算资源/CLI 回执；canSeeEvidence 约束当前工作的 epoch、goal、角色；deliveryEvidence 排除检查本身并只投影保存回执。capturedData 将完整技能资源正文映射为 stdout，resourceSnapshot 将内容、hash、skillVersion、skillId/path、offset/nextOffset、status/ok/code 保存为精确 JSON。

DELIVER 在 reducer.ts 固定 deliveryCycle.evidence。checkDisposition 重新调用 deliveryEvidence(c, work, frozenRefs)，不存在或不同则 CHECK_EVIDENCE_CHANGED。冻结 refs 的 stdout/stderr hash 与 resourceSnapshot 必须一致，旧资源 refs 缺快照失败关闭。checkDisposition 之后的 criteria/citation 检查并非此模型的文本真实性证明。

9 项输入验证对从真实存储读取的 context 克隆进行单字段损坏，不写回存储、不声称这些修改可经业务事件发生；调用真实 deliveryEvidence，断言返回 undefined。完整回执必须返回原 saved source 字符串。覆盖 hash、正文、技能版本、分页、状态/结果和 legacy snapshot 缺失，不涵盖任意多字段损坏、skillId/path 重写、命令型证据和输出散列伪造。skip-snapshot 负对照必须在正文改变而 hash 不变的案例失败，不能仅依靠预设哈希门禁。

## 故障检出与活性

真实负对照在独立 src 副本改变 operations.finish 的最终消息条件、boundCheckProblem 的 candidateRevision 守卫或 deliveryEvidence 的 snapshot 比较。原始模型图保持不变。每种修改在两个存储上独立运行；必须含指定性质名，导入失败、编译失败和超时不能算检出。

Progress 的弱公平是环境假设：在线、未停止、未换目标且有效的检查最终被提交。模型未执行 WorkRunner，不把公平假设说成调度器证明，也不声称恢复 consumed check 会自动重发。达到 Publish、Stop、ChangeGoal、Rollback、Crash 的独立见证避免空前提。

## 维护审查

### KEJ-109：目录与检查诊断的切片审查

逐文件审查见 [KEJ-109 记录](drift-review-kej-109.json)。旧名义 sync `e77f052` 在当前 clone 不可用；已逐项证明可用 `5b8c596` 的全部 62 项覆盖源码/依赖与旧 coverage 清单字节一致，再审阅两条产品提交及当前工作树差异。

`judgmentsDiagnostic` 保持原逐项完整性、来源存在和逐字子串校验，只为错误结果附带定位；`checkDisposition` 的处置和预算不变。`saveCheckDiagnostic` 仅在当前检查的引文错误时写工作元数据，与原 `CHECK_RESULT`／`WORK_FAILED` 同一事务，不写 publication、candidate、final 或冻结回执。原 Delivery、Verification、Cycles、SourceLineage 回放均提供合法且无引文的检查条目；Verification 失败事件无诊断，因此新增保存分支在这些切片为无操作。有效结果、一次语义修订、旧发布保留、停止、目标隔离、工作区复核及原子提交路径保持。

CLI 目录、技能搜索和共享方法通过 `catalog-search.ts`、`cli-catalog.ts`、`task/tool-knowledge.ts` 新增传递依赖，纳入保守漂移清单。四个回放从公开 engine 注入保存回执，不创建 LocalRuntime、不枚举目录、不运行模型 HTTP；新增目录或提示不会修改既有回执或赋予调用权限。模型、性质、有限域、公平假设、回放和真实负对照保持。新目录分页、方法关联、引用定位准确性及模型修正效果仍由独立行为验收承担，未扩展为形式化保证。

完整检查 `reports/verify-squad-delivery/kej-109-audited-outer` 用时 204.592 秒退出 0：原 31 状态／79 边，组合 47／91、79／203、71／226，每条边在 Memory/SQLite 均回放；十类真实代码负对照在两后端命中，原版恢复复验全通过，四项清理门禁为 true。独立读回 290 件证据通过。沙箱内 Java RMI 端口限制的失败单独保留，不算性质反例。受测工作树的 65 项源/依赖与产品提交 `8f4a1ac` 逐项同字节后才推进 sync；仅元数据更新不冒称第二次完整运行。

coverage.json 保守列出当前 src 的所有 TypeScript 文件以及配置/锁文件，捕捉传递依赖漂移。重点审查 task.machine、task/lifecycle、task/policy、task/delivery、task/evidence、task/reducer、task/operations、task/input、store、engine；其他模块门禁只表示须检查是否影响这些入口，不扩大验证范围。

当增加第二候选、部分失败、WORKSPACE 验证、恢复动作或发布后继续时，应扩展变量和真实回放，而非直接把新路径投影成 stuttering。每个新原子动作必须对应实际事务；每个新字段要讨论它是否影响未来行为。现有模型没有候选替换历史，不可用于证明多修订场景正确。


## PR40 对应审查

审查目标为 `21ee46039f594d9b93d400bf703e14d42fab2b0e`，从原同步基线逐项审阅的21个变化/新增源文件、哈希与原因见 [drift-review-pr40.json](drift-review-pr40.json)。CI首次在TLC之前因18份已有覆盖文件漂移返回blocked；这证明同步记录已过期，不是已有性质的反例。

KEJ-98增加跨任务来源固定和新Markdown门禁；在本模型不带sourceArtifact、显式生成单份report.md的前缀中，它们不改变当前候选发布或技能回执冻结路径。KEJ-99在理解意图与分片派发中引入容量；本模型禁用解释、没有并行分解。回放每次observe都明确断言无sourceArtifact、无interpretation工作、无mapReduce轮次，使这些切片假设能被实际实现检验。Publish/CHECK_RESULT、STOP、ChangeGoal和回滚的事务边界、snapshot比较及三个真实负对照锚点保持；模型性质、变量与边界不变。

新增三个传递依赖artifact-request.ts、source-artifact.ts和task/map-reduce-capacity.ts加入漂移清单。列入清单只要求今后重新审查，不代表已证明跨任务选择、原文一致性/内容保留、动态规划容量、HTTP权限、UI或供应商判断。上述行为仍由各自模型/集成/Gherkin/浏览器验证承担；不能把它们投影成已获Delivery性质的stuttering分支。

## KEJ-106 取消讨论恢复变更的切片审查

受审产品提交 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`；逐项源文件指纹、初始 blocked、候选/最终执行与真实负对照见 [维护记录](drift-review-kej-106.json)。新增 `canRetireDiscussionWork` 只处理带 discussionId、可安全重放且没有未决物理效果的过期讨论意图；recoveryIssue 的过滤、RECOVER 的逻辑结算和 LOCAL_RESULT/LOCAL_RECONCILE 后的结算仍位于原 reduce/存储事务。

本技能所有前缀无 discussion，且所有意图均无 discussionId。回放新增可执行断言固定这些前提，因此新 helper 在本切片恒为 false，恢复工作集合、许可/审批/租约和发布/冻结证据行为保持。原模型、性质、边界和负对照均不改变；不能把新 helper 的分片恢复正确性投影成已经由本有限模型证明。BT_Q19–Q23 的真实状态模型门槛和具体集成由产品验收另行承担。

### Engine ended 恢复入口增量

产品 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 仅在 engine.ts 增加既有纯谓词的导入，并把原 ended 直接跳过改为“ended 且没有可安全结算的过期 discussion 工作才跳过”。本技能可执行切片同时要求 discussion 缺席与所有 intent.discussionId 缺席，故新增 some 判断恒为 false：原 ended 仍跳过，非 ended 仍走原 RECOVER 事务。Delivery 回放只重开引擎而不调用 recover，Authority 的恢复仍逐边及生命周期实例核对。没有新增权限、发布、外部 I/O 或事务边界。

前轮 b6ea 的运行不能证明该新增产品源；本次 `kej-106-final-engine` 在实际 HEAD `0503c956a7c9af3d6ddaee7c7b54224e7f0f85ce`（3d81 后仅测试提交）完整通过并独立读回，62项覆盖源/依赖与产品 3d81 逐字一致。运行输入保留旧 sync=b6ea；成功后才将 sync 元数据推进至 3d81，再核对指纹及读回原证据，不重复执行同一源的完整检查。精确结果见 [维护记录](drift-review-kej-106.json)。新 ended+obsolete-discussion 路径由 BT_Q24 等产品验收承接，不扩大本模型保证。


## KEJ-102–105：验收接线与成功响应资源边界

受审产品及构建编排为 `32c26b376b46ae1a03718a6820683b59b802b413`；旧名义同步 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 在此 clone 不可用，先逐项证明可用 squash 基线 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 与旧覆盖清单所有源字节完全一致，再审阅其后提交消息和逐文件差异。旧新指纹、分类、原样 blocked 及完整检查状态见 [本轮对应审查](drift-review-kej-102-105.json)。

delivery 以公开引擎事件注入完整合成检查结果，不执行 WorkRunner/模型 HTTP。候选绑定、冻结资源快照、发布及 final 消息仍在原事务；新响应读取路径不在此切片中。 `package.json` 仅将 build 改为同样的两套 tsc 和 Vite 加构建证据记录，不改变依赖锁或本技能执行入口。没有新的领域写入口、事务拆分或投影字段；TLA/CFG、性质、公平性、界限及原真实代码负对照保持。

成功响应的实际解压字节上限、取消读取、UTF-8 边界与非瞬时失败由 BT_M46–M49 的真实 HTTP/SQLite/Runner 验收及撤销读取上限的负对照承接；本有限检查不证明供应方 I/O 读取、资源上界、真实进程终止、SQLite 底层抗断电或这几种领域的组合。KEJ-103/104 的真实 SIGKILL/SQLite 依赖验收是额外证据，不替换原模型的事务假设。审查后先更新已确认的覆盖指纹，保留旧 sync；只有完整正负/恢复检查与独立读回成功后才推进同步元数据。

完整检查与独立读回已通过：`reports/verify-squad-delivery/kej-102-105-controlled-env`，保留 82 项原始证据；具体原图/恢复图规模、真实源码负对照和清理结果见审查 JSON 的 verification。同步推进到受测产品 `32c26b376b46ae1a03718a6820683b59b802b413`，后续集成 HEAD 的全部覆盖源/依赖逐项保持相同字节；不把元数据推进说成第二次完整验证。

## KEJ-107 #3 / KEJ-108 A1、A6：三个独立有限切片

原 Delivery.tla/CFG 及原性质不变；新的 Verification、Cycles、SourceLineage 分开探索，避免把三个生命周期的笛卡尔积当成一个不可复跑模型。三者只扩大验证描述，不改变产品承诺或源码。`references/drift-review-kej-107-108.json` 记录旧基线运行、在开发中新增的适配器差异及分类、完整结果与独立读回。工作树源码以报告的逐文件 hash 精确绑定，未提交修复不冒称已存在于 HEAD。

### 原子步骤与投影

| 模型 | 动作 | 当前实现与不可分边界 |
| --- | --- | --- |
| Verification | RequestValidation / ClaimValidation / StartValidation / ValidationPassed、ValidationFailed | 分别为 requestLocal、claimLocal、LOCAL_STARTED、LOCAL_RESULT 的一次提交；不把这四笔事务合成原子动作 |
| Verification | ConsumeEarly / Consume | CONSUME → policy 的 deliveryVerificationProblem(false)；失败不扣检查请求 |
| Verification | ModelResult | WorkRunner 的 adapter 输出本地载体；不是持久化业务事件 |
| Verification | ChangeWorkspace | 外部工作区差异代表；在后续受控版本回执中显现，不修改任务存储 |
| Verification | RequestVersion / ClaimVersion / StartVersion / VersionResult、VersionFailure | 分开的 verifyWorkspace 本地操作申请/领取/启动/回执提交；匹配版、真实失败码及防御性不一致 success 回执均保留 |
| Verification | Publish / PublishWithoutVersion / FailVersionWork | CHECK_RESULT → checkDisposition/checkedDelivery，或 WorkRunner 失败回传 WORK_FAILED；一次事务 |
| Cycles | Continue / ClaimOwner / Draft / ClaimCheck / Consume / Pass、Fail | 分别对应 CONTINUE、CLAIM owner、DELIVER、CLAIM check、CONSUME、CHECK_RESULT；任何中间状态均可插入停止、旧工作回执；每轮旧候选判断在当前检查已消费时插入 |
| SourceLineage | FreezeB、FreezeC | submit 与 resolveArtifactSource 同一房间事务，保存全文与直接来源元数据 |
| SourceLineage | ContinueA / ClaimA / DeliverA / ClaimCheckA / ConsumeA / RepublishA | 分开的可信继续、负责人领取、交付、检查领取、许可、结果提交；A1保留为旧 artifact/final，当前选择切换A2 |
| SourceLineage | ResumeB / ClaimB / DeliverB / ClaimCheckB / ConsumeB / PublishB | B的同一分解，固定来源一直为A1；C只选择已独立发布B |
| SourceLineage | Reopen / RecoverFrozen | 连接/引擎重开不合并恢复事务；RECOVER只针对B，以公开send提交；在B负责人或检查已领取的状态不启用该恢复动作，避免假称证明这些执行恢复 |
| 各模型 | Rollback / Reopen | failNextCommit 对一次CHECK_RESULT事务注入回滚并核对整个store.read；丢弃故障引擎并重开，不模拟OS kill或数据库断电 |

每条标记边从真实可达 Init 前缀重建，逐项运行其最短BFS代表路径和待核对边；MemoryStore、SqliteStore分开实例化并核对每步投影。完整TLC原始统计必须满足图节点数=distinct、标记边数+初始节点=generated，并与两种存储各自完成的全部边一一相等。不是仅抽样最终状态或拿哈希代替行为。额外具体不变量包括旧artifact/final深度不变、当前发布选择保留、final数量及选择一致、冻结来源全文/元数据不变、重复/冲突请求不新建任务、C来源任务/产物身份必须是B。

### 有限域、环境假设与保证边界

- Verification：一个任务/候选/检查、一次工程验证成功或失败、一次独立检查请求、两个工作区版本代表、一次最终复核、一次提交回滚/重开。模型检查前缺成功隔离工程回执不得CONSUME；发布要求有效工程回执、模型请求和三个相等版本。工作区变化只在最终版本结果前引入；不证明外部编辑与最终CHECK_RESULT之间的全文件系统原子快照。真实LocalRuntime的版本计算与CLI执行由已有BT_L场景集成检查承接；本模型注入受控回执，不调用真实工具。
- Cycles：一个任务、三个发布周期、跨这些周期最多一次自动失败修正、至多四个文档修订、一次回滚/重开。每个成功周期增加一条final，后续活动保留此前publication、文档和final；旧候选或旧工作回执无发布权限。不证明无限周期或每轮多次失败/技术重试。
- SourceLineage：同群三个任务、A两版发布、B冻结A1后停止和继续并独立发布、C引用B；一次重开和一次针对B的受控RECOVER。无跨群、名字歧义、任意来源图、超大正文或语义保留正确性保证。A原文及final、B完整sourceArtifact每步核对。
- 活性与安全分开：Verification只要求已完成最终复核且持续可重开的检查最终结算；Cycles以持续可用ClaimOwner/Draft/ClaimCheck/Consume/Pass/Reopen的弱公平保证继续后的周期可结束；SourceLineage对固定的用户停止/继续及公开执行步骤加弱公平，证明这条有限工作流可最终到C，而非要求用户一定发出停止或继续。

### 检出能力与独立读回

七类隔离真实产品变异：删除工程前置门禁、跳过最终版本门禁、忽略版本相等、清空续办时旧发布选择、接受前周期candidateRevision、破坏创建时固定原文、把直接来源换成祖先来源。两种存储均必须正常退出1且命中对应行为性质；错误导入、超时或TLC语法错误不算检出。每项同时保留匹配的小模型反例；纯模型变异不能替代真实代码对照。

原版最后完整重跑所有三个模型及全部双存储边。`--verify-evidence` 独立读回原始TLC完成/活性/零队列、配置性质、图节点与全部标记边、两个后端逐边JSONL及目标投影、所有前提见证、实际负对照性质和清理，再校验manifest。它是有限模型与每边一个真实前缀的执行对应证据，未声称任意TS历史双模拟或无限系统证明。

### 独立审查后的证据与反例层级修正

SourceLineage 的 corrupt-freeze 反例现在保持真实 revision=1，用独立 `badFrozenContent` 历史观察位表示创建时实际内容不等于选中原文；FrozenSource同时要求旧revision与内容完整性。真实engine内容变异与模型内容位在同一FreezeB动作失败，不再把坏正文解释为revision=2。

证据读回将每个真实负控的两个backend原JSON、原日志及real-code.diff作为必需非空artifact；检查原JSON含目标AssertionError、正常exitCode=1、实际失败backend，并与run摘要完全相同。两份fixture正文与feature/steps也必须在checker-inputs中出现，可复原未提交回放输入。配置校验精确要求各模型全部安全性质、SPECIFICATION Spec及PROPERTY Progress；删除性质不能降级成只检查状态空间。

`composition-evidence-controls.py EVIDENCE --output RESULT.json`先确认正本通过，再在隔离副本删除JSON/log/diff/fixture、移除Progress/安全性质或修改摘要，逐份更新并重新签manifest。通用hash层仍应接受这些自洽副本，但独立领域读回必须拒绝；最后再次核对正本通过且未修改。

原Delivery根域也执行必需baseline/restored原件、三类真实负控原JSON/log/diff与实际退出/AssertionError/摘要一致检查，五项原见证不能缺失。十一项自洽副本反控包含删除根negative-controls整目录及其JSON/log/diff。该原域补强是完整运行后的只读reader refinement，生产源码、模型、回放与数据未变；维护记录保留captured producer函数AST与当前相等的核对，不冒称又执行一次TLC。

原Delivery baseline/restored的JSONL现按Memory/SQLite分别与原graph.dot全部标记边做Counter核对，并逐行匹配目标投影。独立删掉根JSONL一行并重签manifest曾揭示只信摘要的虚绿，红证据保留；只读reader修复后四种独立自洽反控全部拒绝且正本290件通过，见`reports/formal-readback-controls/delivery-all-four-reviewed`。模型、driver、producer与原始证明数据未变。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。


## KEJ-110 检查效率与来源结构的切片审查

原覆盖清单逐项与可用主线 `942dfe4a9876dc9dcb8db94b221148822edf07a2` 字节相同。逐文件旧/新hash、分类、初始原样blocked和最终执行在 [本轮审查](drift-review-kej-110.json)。新增 `delivery-check-delta.ts`、`source-claims.ts`、`source-items.ts` 是传递依赖，加入保守漂移清单不表示已证明其内容语义。

本次仍由原公开入口、原事务边界驱动；候选与操作身份、存储提交、消费标记、发布记录和final原子性不变。结构化来源校验只处理带sourceItems的报告；既有回放的普通报告不触发。增量材料由runner模型请求使用，直接engine事件回放不执行该投影；handoff进度探针仍先flush且不调用adapter。共享能力事实只读，不生成调用权限或调度。

修订额度按 KEJ-110 与 BT_F77–BT_F81 有意改变，独立 coordination CheckBudget 承接扩大域；本技能原交接切片没有候选/检查，原Delivery只检查一个候选，Cycles的环境只允许跨三个发布周期一次失败修订。后者保留该明确有限域，不声称覆盖多次失败或整个新预算。Verification的工程门禁、SourceLineage的固定来源与直接谱系均未改变；sourceArtifact模式回退完整材料。

原模型、性质、边界、公平条件和真实代码负对照保持。新来源原文状态、D标签渲染、增量复核语义、任意报告和模型供应商质量仍由直接产品场景与集成承接。本轮在产品 `661e438` 上完整运行与独立读回已通过，逐项执行记录见审查JSON；同步元数据由整体验证结束后推进，不把元数据更新称为一次额外完整运行。

完整 Delivery 入口134.801秒通过，原Delivery与Verification/Cycles/SourceLineage三组合域全部完整探索、双存储逐边回放、三类原始与七类组合真实负控、原版完整复验及独立读回通过，cleanup四项全true。十一项自洽缺件/性质移除/摘要冲突和通用缺件/截断读回负控均通过。证据 `reports/kej-110-final-delivery` 与 `reports/kej-110-reader-controls-delivery`；限并发中断partial目录不计通过。

最终产品 `615b18f` 仅将同一sourceItems说明从交付JSON示例后缀移到owner系统指令，使示例保持JSON。上述形式化入口不调用模型HTTP，声明的事务与投影无影响；仍按精确源码策略重跑全部入口。661成功证据已移至 `reports/kej-110-661-*`，仅作历史；615最终结果在审查JSON的validation单独记录，未完成前保持pending。

### 615b18f 精确源码最终复验

产品615完整Delivery入口125.614秒通过，原31状态79边与三组合47/91、79/203、71/226全部完整探索、双存储逐边回放、三类原始和七类组合真实负控及原版完整复验通过。独立读回290件原始证据，十一项自洽证据缺件/性质移除/摘要冲突负控与通用缺件/截断负控均通过，cleanup四项全true。证据 `reports/kej-110-final-delivery` 与 `reports/kej-110-615-reader-controls-delivery`；661结果仅保存在historicalValidation，不作为615最终证明。

## KEJ-111：恢复声明与原发布切片的对应审查

产品冻结于 `c239dd39d86f143a2f435f48590c648b20745b8b`。旧同步615的71项源码/依赖指纹与可用主线 `49d2bc0ec61df94581cc52aef48725b040ea8603` 全部同字节。读取该基线至产品的全部12项源码变化、提交说明与新增纯依赖，记录于[逐项审查](drift-review-kej-111.json)；原样blocked发生在开发中，保留其实际源码/工作树，不称为冻结提交的完整运行。

原Delivery每步显式排除discussion与discussionId；Verification、Cycles、SourceLineage由固定公开submit/DELIVER前缀建立，不启动讨论、分解或map轮次，所有交付均省略partitionRecoveries。新 `mapRecoveryProblem` 和 `mapRecoveryCheckProblem` 因没有声明返回null，`mapRecoveryCriteria`、`uncoveredMapRecoveries`因没有map轮次返回空数组，`resolveMapRecoveries`没有写入。检查要求没有requiredSourceIds，故新的强制来源分支不改变原合成结果。普通独立评审先于map恢复处理的规则在这些无评审前缀亦无行为变化。

DELIVER仍在一次事务中固定候选与验收要求；CHECK_RESULT仍由当前candidateRevision、attempt/fence、固定证据及工作区复核门禁约束，完整发布、final与完成状态在同一事务提交。新resolver在该事务内、finish之前运行，没有拆分原发布边界；它只会处理本技能未建模的恢复声明。原SnapshotBinding、版本隔离、多周期历史与直接来源固定的关键实现保持。

新增 `RECORD_TOOL_FAILURE` 只在显式事件分支记录有界历史；这些图的动作全集不含该事件。模型适配器和runner的Web反馈/声明传输是新接线，不在直接engine回放中运行。`map-recovery.ts`、`tool-recovery.ts`加入保守指纹门禁，表示将来变化必须审查，不代表本技能已证明其外部调用或语义。

故原四模型、性质、公平性、界限、原有真实负控与逐边回放保持。当前map恢复发布资格有意改变，独立coordination MapRecovery切片检查声明绑定、冻结来源、逐片独立引用、保留失败历史与原子解决；ToolRecovery切片检查有界反馈身份和额度。真实替代工具是否成功、正文是否对应分片目标及八片集成仍须BT_M52–M59、BT_Q36–Q48和实际接线验收，不能从四个原模型的通过推出。完整运行/读回状态以审查JSON的validation为准，未完成前不推进sync。

## KEJ-112：工具建议与重复失败守卫的切片审查

受审产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。旧覆盖指纹逐项与可用主线 `6134a0c` 字节相同；七项已有源变化与三项新增纯传递依赖的旧/新指纹及对应理由见 [本轮审查](drift-review-kej-112.json)。原样检查以 covered-source drift 阻断，是描述过期而不是性质反例；候选指纹在逐项审查后更新，完整检查和独立读回通过前不推进 sync。

Delivery 的真实前缀只申请 `readSkillResource`，新 guard 仅处理非 check 的重复 runCli，故不改变该前缀。Verification 的工程验证 runCli 为 check 工作，明确豁免新重复限制；其申请、领取、开始、回执与发布仍分别是原事务。Cycles、SourceLineage 没有两次先前可诊断 CLI 失败的请求路径。requestLocal 回执 id 现在绑定完整 messages/parentAttempt/action 身份，操作幂等仍由 operationId/requestHash 保持；这些 id 是投影外的标识，公开步骤和持久化原子边界不变。

Runner/Adapter 的候选/诊断仅为当前工作的只读模型输入，不修改 publication、candidate、final 或已冻结来源；四个模型均不执行真实模型 HTTP 和工具推荐，也不把推荐当作成功采集证据。新增 cli-failure、task/tool-guidance 与 tool-recommendation 纳入保守漂移清单不扩大形式化保证。原四个模型、性质、公平条件、界限、逐边回放及真实代码负对照保持；新工具建议与纠正由 BT_L117–BT_L124 和真实 XState/持久化门槛、受控模型/CLI 接线单独验收。
# KEJ-113 / KEJ-114 维护候选（尚未完成验证）

本轮原样入口先因源码漂移返回 blocked，原始证据位于 `reports/kej-113-114-initial-delivery`。名义同步对象 7e5b342 在此克隆不可读取；已逐文件核对可用 HEAD e526f6f 以及 15d2714、62fdb58 与原 coverage 全部字节相同，然后从 e526f6f 审查当前工作树。逐文件旧/候选 SHA、迁移写入口、原事务边界和新增依赖分类见 [本轮审查](drift-review-kej-113-114.json)。候选源码仍可能变化，SOURCE_FREEZE 前不将这些指纹或旧通过结果称为当前产品验证。

原有限模型、性质、公平假设与域界限保留；不能用减小域、删边或弱化不变量接受产品缺陷。新自动监督、处理硬截止、人类回复/跳过、独立清理、部分宿主报告、资源正文凭证、读写资源租约、归档删除与进程守卫均有独立契约，本旧切片不证明它们任意组合正确。完整原入口及真实代码负对照、原版复验、独立证据读回尚待源码冻结后执行；当前 syncCommit 未推进。

冻结产品 `36916b5c6e974c11f8e51720189c64facef9269e` 已逐文件对应审查，候选 coverage 已绑定当前字节。完整入口、原真实代码故障反控、恢复复验和独立读回开始执行；当前仍未通过，syncCommit 未推进。旧域排除新增监督/权限门/资源正文语义/RW/归档删除与任意供应商时序，不能将字节纳管当作这些性质证明。

KEJ-113/114 本入口最终完整执行通过：`reports/kej-113-114-final-delivery`，固定产品 `36916b5c6e974c11f8e51720189c64facef9269e`；290 件原始证据独立读回成功，证据读回反控也全部按预期拒绝。原有限模型、性质、界限及全部标记边双存储对应保留；具体统计、真实突变、清理和运行命令见本轮审查 verification。受测实现未变；syncCommit 等待父流程全部九入口确认，后续同步元数据不表示又完整执行一次。

全部九入口和独立读回已由父流程确认，当前 syncCommit 已推进到 `36916b5c6e974c11f8e51720189c64facef9269e`；旧证明输入、失败反例和保证边界保持。仅元数据同步，不冒称又完成一次完整执行；同步后再次独立读回原始证据。
同步元数据后的独立原始证据读回已再次通过，覆盖实现 SHA 仍全部相同，九份证明 run/manifest 均未改写。


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
