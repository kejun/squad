---
name: verify-squad-delivery
description: "验证 Squad 固定交付证据、当前候选审查与发布记录的一致性。修改 CHECK_RESULT、资源证据快照、完成发布、停止、换目标或持久化时使用；运行 TLC、双存储迁移回放及真实代码负对照。"
---

# Verify Squad delivery

先读仓库 AGENTS.md 和 [实现对应与保证边界](references/correspondence.md)。本技能保护的承诺：只有当前候选的审查能原子提交发布记录、完成状态和相同文档选择的最终消息，且已冻结的技能资料回执发生变化时不能继续作为同一份证据。违反会发布过期或未核查的内容，或展示与正式交付不同的文档。

## 一条命令

仓库根目录执行：

```sh
npm ci
python3 .agents/skills/verify-squad-delivery/scripts/check.py
```

依赖 Node.js 22.18+（22.x）或 24.11+、Python 3.10+、Java 11+、curl。固定 TLA+ Tools v1.7.4 / TLC 2.19，JAR SHA256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。可使用 `--jar /absolute/path/tla2tools.jar` 或 TLA2TOOLS_JAR。复用 handoff 的有界子进程、固定下载和证据校验函数，不运行其模型或修改其文件。

所有 TLC 子进程最多 45 秒，真实实现回放每次最多 90 秒，下载最多 50 秒。默认报告在 reports/verify-squad-delivery 下新建独立目录；`--evidence` 可以指定新的目录，不覆盖旧证据。不需要 API Key、浏览器或实际外部命令。

## 判断结果

只有完整命令退出 0、run.json 的 status 为 verified、cleanup 全部为 true，才算通过。随后用输出的实际目录执行：

```sh
python3 .agents/skills/verify-squad-delivery/scripts/check.py --verify-evidence "$SQUAD_DELIVERY_EVIDENCE"
```

校验只读，核对原始日志、文件大小、SHA256 和完整运行结果。缺失、空日志、篡改或未完成结果不能通过。

执行顺序：

1. 对 coverage.json 中源码和锁文件检查漂移；有漂移必须先按对应文档审查，禁止仅刷新哈希。
2. TLC 完整探索 Delivery.tla / Delivery.cfg，检查 TypeOK、AtomicPublication、CurrentCandidate、VersionIsolation 和独立 Progress。原始日志必须显示零剩余队列、temporal checking 完成和无错误；不能以进程启动或部分统计冒充通过。
3. 解析全部动作标记图。每条抽象边从真实 submit → claim owner → 保存技能资料回执 → DELIVER → claim check → CONSUME 的可达前缀出发，在 MemoryStore、SqliteStore 上重放，并逐步比对投影。TLC 状态/边数必须与解析回放数量一致。
4. 独立运行 5 个故意为假的不变量，要求得到指定违反，证明发布、停止、换目标、回滚、崩溃可达。语法或依赖失败不算见证。
5. 在隔离产品源码副本执行三类真实负对照，两种存储均须因目标性质失败；前两项同时保留模型反例。原模型和所有图输入保持不变，不能仅靠哈希差异检出。
6. 删除副本，重新完整运行未改坏的模型与实现，确认覆盖源文件不变；保留原始日志、逐边回放、diff、命令/退出码、checker-inputs 和哈希清单。

## 性质与范围

- AtomicPublication：成功的发布记录、complete 状态和恰好一条相同 artifactIds 的最终消息一起持久化，失败提交不能部分保存。
- CurrentCandidate：错误 candidateRevision 的审查不得发布当前候选。
- VersionIsolation：首次发布前已停止或切换目标，旧检查不得发布。
- Progress：当前可发布检查最终发布，或被停止/换目标失效。假设崩溃/提交失败各至多一次、重开与有效审查返回满足弱公平。重开只是存储/engine constructor，不是 TeamEngine.recover；不证明恢复调度器或供应商一定完成。
- SnapshotBinding：9 个明确损坏/旧格式输入分别改变技能回执正文、哈希、技能版本、分页 nextOffset、状态、ok、code、offset，或移除冻结快照。真实 deliveryEvidence 必须拒绝。它们是有限输入测试，不是可达业务事件或穷举所有损坏组合的形式化证明。

原 Delivery 模型精确边界：一个任务、一个候选、一个文档、一份已结算完整技能资源回执、一次检查请求、目标版本 1..2、至多一次进程丢失与一次回滚；错误候选输入使用一个不相等代表；允许重复审查/迟到结果和重复查询。模型通常为 31 个状态和 79 条标记边，但应读取实际日志，不能照抄统计。

这是有限抽象模型穷举 + 每边一个代表前缀的真实实现回放，不是所有 TypeScript 历史的等价证明。原 Delivery 单切片未证明 SQLite/文件系统断电可靠性、文本语义真实性、技能 hash 与文件内容的密码学核验、分页重组、多候选连续修订/已发布版本替换、审查失败自动修订、工作区验证执行、审批租约、无限重试、外部工具副作用或 UI 渲染。文件哈希是漂移门禁，不能证明对应性。源码读取细节与未覆盖情况见 correspondence.md。

## 负对照

- 删除 complete 的最终消息：真实实现违反 AtomicPublication，模型 drop-final 给出对应反例。
- 删除输入 candidateRevision 相等判断：真实旧版本输入违反 CurrentCandidate，模型 accept-stale 给出对应反例。
- 删除资源 snapshot 比较：真实损坏输入违反 SnapshotBinding。这是代码级输入对照，不伪造模型对应反例。

每个对照须因行为断言失败，而不是构建、加载或超时错误。发现真实当前代码违反性质时保留反例，判断是模型错误还是实现错误，不放宽断言制造通过。

## 维护

KEJ-109 当前同步产品基线为 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596`。十项既有源文件与三项新增传递依赖已逐项审查；原 Delivery 及 Verification、Cycles、SourceLineage 的模型、性质和边界保持。完整正向、真实代码负对照、恢复复验与 290 件原始证据独立读回通过后才推进同步元数据，见[本轮审查](references/drift-review-kej-109.json)。目录发现、分页、共享方法和诊断定位由独立行为验收承接，未扩展本技能保证。

本轮 KEJ-102–105 对应审查及完整检查已通过，当前同步产品/包基线为 `32c26b376b46ae1a03718a6820683b59b802b413`。逐文件分类、原样漂移、受控环境、真实负对照、恢复后复验及独立读回见 [本轮审查](references/drift-review-kej-102-105.json)。原模型、性质、公平性和边界保持；成功响应字节限制与真实进程/SQLite 崩溃验收不扩大本技能的有限保证。成功后仅推进同步元数据并复核指纹、读回原证据，不冒称又完整运行一次。

KEJ-106 历史对应审查基线为 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b`。原样检查因 facts/reducer 指纹漂移而 blocked；逐项审查后，新增无 discussion 及无 discussionId 的可执行切片断言，候选完整检查和独立读回通过后才推进同步基线。模型、性质、边界及事务假设不变；最终运行、真实代码负对照与读回状态见 [KEJ-106 审查](references/drift-review-kej-106.json)。随后 engine 的 ended 恢复入口也经逐项审查，并在新产品源上完整运行及独立读回；成功后只推进同步元数据并复核指纹，不为元数据更新重复完整运行。前轮 b6ea 的候选/最终证据仅作历史，该轮最终证据为 `kej-106-final-engine`。本切片不证明 BT_Q19–Q24 的取消分片恢复、成员占用或已结束任务续办；以下保留历史审查记录。

BT_F31 历史审查基线为 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`（BT_M37 检查协议说明、BT_F31 冻结输入引用）。完整检查及独立读回已通过，逐文件对应、额外真实代码负对照与保证边界见[引用链审查](references/drift-review-raw-input-citation.json)和[协议说明审查](references/drift-review-check-envelope.json)；当前指纹见 coverage.json。

KEJ-100 历史依赖审查基线为 `c1f380da1527b8c22a8aaaaf7aef10cd2695146e`；仅 `package.json` 的空单测集合处理变化，产品源码、模型、性质、边界和回放均沿用原审查。当前指纹及运行状态见 [KEJ-100 审查记录](references/drift-review-kej-100.json) 与 [coverage.json](references/coverage.json)。下列 PR40 基线为产品源码对应审查的历史记录。

PR40 产品源码对应审查基线为 `21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。从原cd987f2f基线的逐文件分类、传递依赖及运行证据见[PR40审查记录](references/drift-review-pr40.json)。原发布/回执模型的变量、边界和性质未改变；回放增加显式无来源、无解释和无并行分片的切片约束。精确源文件见coverage.json；保守包含src传递依赖不代表跨任务修订和容量规划均获形式化证明。

请用 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-delivery` 请求维护，并遵循[维护流程](references/maintenance.md)。覆盖文件变化时逐项审查原子边界、守卫、新写入口和投影遗漏；先更新模型/回放，完整运行真实负对照和恢复检查后再推进 sync commit。blocked 时不推进。规则/验证变更不改变产品行为，不另造产品 Gherkin；若发现产品缺陷需要修复，遵守 AGENTS.md 的场景与状态模型先行流程。

工具来源：https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4 。技能结构与维护流程采用现有 handoff 技能约定，保留其 MIT LICENSE。


托管宿主若仅注入 `MODEL_API_KEY` 而没有模型端点，`team.config.ts` 的模块默认导出会在回放前报配置错误。验证命令可加前缀 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true`，仅给当前进程提供导入前提；实际回放仍使用显式固定配置，不调用该地址，也不修改用户 `.env`。本轮原配置失败及受控重跑证据均保留。


## KEJ-107 #3 / KEJ-108 A1、A6 组合切片

同一 `scripts/check.py` 命令在保留原Delivery完整检查之后，额外运行三个独立有限模型：

| 模型 | 用户承诺 | 有限范围 |
| --- | --- | --- |
| Verification | 工程验证成功后才可请求模型检查，最终发布必须完成同版本复核 | 单检查，成功/失败CLI，两个工作区版本，单次最终复核与回滚/重开 |
| Cycles | 连续修订保留旧交付，陈旧检查不能发布新候选 | 三个发布周期、四个文档修订、跨周期一次自动修正 |
| SourceLineage | 来源在创建时冻结，后继任务只记录直接交付来源 | 同群三个任务，A两版、B冻结A1并发布，C直接引用B |

申请、领取、启动、结果、模型请求、交付和发布分别对应真实事务；不把多次公开调用画成原子一步。所有模型完整探索后均逐标记边重放Memory/SQLite，执行正前提见证、七类真实代码负对照和匹配模型反例，最后完整复验原版。详细边界、外部版本事实、输入失败、弱公平及代码对应见[组合对应审查](references/correspondence.md#kej-107-3--kej-108-a1a6三个独立有限切片)。BT_F50–F53有可直接执行的中文Gherkin，不能把formal命令通过称为这些场景直接执行。

`--verify-evidence` 除旧manifest还逐项读回三个模型的原始完成统计/活性、图、双存储全部边、目标投影、见证及真实负对照。开发时可单独运行 `python3 .agents/skills/verify-squad-delivery/scripts/composition-check.py --jar /absolute/path/tla2tools.jar`；最终交付仍执行完整技能命令。所有子进程维持45秒TLC、90秒真实回放上限。

本扩展不证明真实CLI/文件系统散列、外部编辑与发布之间的全局原子性、无限周期/重试/来源图；原Delivery排除项中只有这里明确列出的有限部分新增了证据。源码在工作树中的适配器恢复修复经过逐文件无影响审查，指纹与精确结果记录在[KEJ-107/108维护记录](references/drift-review-kej-107-108.json)；sync commit仅在完整验证成功后推进，未提交源码以运行报告hash绑定。

独立审查补强：新负控的原始JSON/log/diff与回放fixture正文均为读回必需输入；不能只保留run摘要并重签manifest。运行 `python3 .agents/skills/verify-squad-delivery/scripts/composition-evidence-controls.py "$SQUAD_DELIVERY_EVIDENCE" --output /absolute/path/evidence-controls.json` 可检验新增与原Delivery域十一种自洽缺件/性质移除/摘要冲突均被拒绝。该检验只复制/修改临时证据副本，不触碰产品或正本。

KEJ-110 当前受审产品为 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9`；本轮逐文件审查、明确改变的预算承诺（如适用）、完整正向/真实负对照/原版复验与独立读回见[KEJ-110审查](references/drift-review-kej-110.json)。仅在全部九个CI形式化入口成功后推进同步元数据；此同步操作不是额外完整复跑，新功能的语义与真实模型供应商行为仍由独立验收负责。

KEJ-111 受审产品为 `c239dd39d86f143a2f435f48590c648b20745b8b`。原 Delivery、Verification、Cycles、SourceLineage 模型及其性质、边界、公平性和回放保持；这些公开前缀没有map轮次或恢复声明，不发送新增工具失败事件，也不运行模型Web调用。新增map恢复会有意改变该域之外的发布资格，不能把原Delivery通过扩展为恢复语义证明。逐项对应、新纯依赖、精确源码完整运行与独立读回状态见[KEJ-111审查](references/drift-review-kej-111.json)；新ToolRecovery、MapRecovery有限切片由coordination扩展入口执行。pending/blocked不表示通过，所有九个入口成功后才推进同步。

KEJ-112 受审产品为 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。原 Delivery、Verification、Cycles、SourceLineage 的有限域中不触发非 check 的两次可诊断 CLI 失败守卫，也不执行新的只读模型建议；公开事务和冻结/发布不变量保持。七项已有源变化及三项纯依赖、原样 drift 阻断与完整正负/复验/读回见 [KEJ-112 审查](references/drift-review-kej-112.json)。原模型、性质、边界和回放保持，推荐/纠正语义不纳入原形式化保证；九个 CI 入口全部成功前不推进 sync。

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
