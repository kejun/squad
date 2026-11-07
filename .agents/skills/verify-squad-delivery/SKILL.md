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

精确边界：一个任务、一个候选、一个文档、一份已结算完整技能资源回执、一次检查请求、目标版本 1..2、至多一次进程丢失与一次回滚；错误候选输入使用一个不相等代表；允许重复审查/迟到结果和重复查询。模型通常为 31 个状态和 79 条标记边，但应读取实际日志，不能照抄统计。

这是有限抽象模型穷举 + 每边一个代表前缀的真实实现回放，不是所有 TypeScript 历史的等价证明。未证明 SQLite/文件系统断电可靠性、文本语义真实性、技能 hash 与文件内容的密码学核验、分页重组、多候选连续修订/已发布版本替换、审查失败自动修订、工作区验证执行、审批租约、无限重试、外部工具副作用或 UI 渲染。文件哈希是漂移门禁，不能证明对应性。源码读取细节与未覆盖情况见 correspondence.md。

## 负对照

- 删除 complete 的最终消息：真实实现违反 AtomicPublication，模型 drop-final 给出对应反例。
- 删除输入 candidateRevision 相等判断：真实旧版本输入违反 CurrentCandidate，模型 accept-stale 给出对应反例。
- 删除资源 snapshot 比较：真实损坏输入违反 SnapshotBinding。这是代码级输入对照，不伪造模型对应反例。

每个对照须因行为断言失败，而不是构建、加载或超时错误。发现真实当前代码违反性质时保留反例，判断是模型错误还是实现错误，不放宽断言制造通过。

## 维护

当前审查基线为 `3ee6c875bbde0f802eae954d9017ffe5663a3cfc`（BT_M37 检查协议说明、BT_F31 冻结输入引用）。完整检查及独立读回已通过，逐文件对应、额外真实代码负对照与保证边界见[引用链审查](references/drift-review-raw-input-citation.json)和[协议说明审查](references/drift-review-check-envelope.json)；当前指纹见 coverage.json。

KEJ-100 历史依赖审查基线为 `c1f380da1527b8c22a8aaaaf7aef10cd2695146e`；仅 `package.json` 的空单测集合处理变化，产品源码、模型、性质、边界和回放均沿用原审查。当前指纹及运行状态见 [KEJ-100 审查记录](references/drift-review-kej-100.json) 与 [coverage.json](references/coverage.json)。下列 PR40 基线为产品源码对应审查的历史记录。

PR40 产品源码对应审查基线为 `21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。从原cd987f2f基线的逐文件分类、传递依赖及运行证据见[PR40审查记录](references/drift-review-pr40.json)。原发布/回执模型的变量、边界和性质未改变；回放增加显式无来源、无解释和无并行分片的切片约束。精确源文件见coverage.json；保守包含src传递依赖不代表跨任务修订和容量规划均获形式化证明。

请用 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-delivery` 请求维护，并遵循[维护流程](references/maintenance.md)。覆盖文件变化时逐项审查原子边界、守卫、新写入口和投影遗漏；先更新模型/回放，完整运行真实负对照和恢复检查后再推进 sync commit。blocked 时不推进。规则/验证变更不改变产品行为，不另造产品 Gherkin；若发现产品缺陷需要修复，遵守 AGENTS.md 的场景与状态模型先行流程。

工具来源：https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4 。技能结构与维护流程采用现有 handoff 技能约定，保留其 MIT LICENSE。
