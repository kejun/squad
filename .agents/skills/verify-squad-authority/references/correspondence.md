BT_F31冻结原始输入引用的来源链修复见[对应审查](drift-review-raw-input-citation.json)；保留精确ID/逐字引用、原子边界和预算性质。

# 实现对应审查

BT_M37 检查信封说明审查：基于 `670df3e08d80a2179c4ab9e733e7f810bb1a0bbe`，仅 `checkMessages` 两条协议提示文本改变；模型、投影、守卫、事务和回放边界不变。逐项审查与验证状态见 [检查信封审查](drift-review-check-envelope.json)。

KEJ-100 依赖审查：`c1f380da1527b8c22a8aaaaf7aef10cd2695146e`，仅空单测集合的 CLI 处理变化；无产品转移、守卫、事务或模型变更。当前审查及完整复跑证据见 [drift-review-kej-100.json](drift-review-kej-100.json)。以下保留 PR40 的产品源码审查。

基线 21ee46039f594d9b93d400bf703e14d42fab2b0e，2026-11-06。逐文件维护审查及原检查结果见 [PR40 漂移审查](drift-review-pr40.json)。验证代码不改变产品行为，不新增 Gherkin 场景或虚构 XState 层。沿用 BT_L23–28 对应行为及有限交错检查。

| 抽象 | 真实入口/守卫 | 原子边界 |
| --- | --- | --- |
| 已领取 Execution 起点 | submit → claim；task.machine 中创建 taskExecution 子 actor | 每次独立 TeamEngine 事务 |
| Execution Start | TeamEngine.beginExecution → startTaskExecution → EXECUTION_START → executionMachine.sameTicket | 许可变化与持久化同一事务，返回前提交 |
| Stop | TeamEngine.send STOP → task/lifecycle 与 cancelWork；子 actor 同步 PARENT_FACTS | 一次事务，已经运行仅进入取消流程 |
| Recover | SQLite 关闭重开、TeamEngine.recover → RECOVER | 本模型没有结果可 flush；恢复步骤不与其他 I/O 合并 |
| Host 起点 | requestLocal → claimLocal（准备）→ LOCAL_APPROVAL_REQUIRED | 三个实际事务，准备阶段不得启动 |
| Approve | LOCAL_APPROVAL_DECISION → localEventProblem 与 applyLocalEvent | 精确旧 approval ID/fence/期限，同一事务 |
| Claim | claimLocal → acquireWorkspace → LOCAL_CLAIM | lease 获取和状态迁移同一事务；失败释放本拥有者的尝试 |
| Start | LOCAL_STARTED → localEventProblem（session、approval、parent、期限） | 状态记录事务；实际 OS 启动不在本证明内 |
| Expire | 测试受控时间从 1 变为 900 | 环境时间变化，不自行 tick；守卫主动拒绝 |
| LeaseBusy | 另一所有者在 Store.transact 中 acquireWorkspace | 一个工作区键，持有者不释放；不是分布式 TTL |

stage 不是当前产品 status 的复制，而是旧能力曾走过的最远阶段；stopped/expired/recovered/busy 标记后续旧能力障碍。恢复后产品可能生成新 ID 或挂起父操作，这些细节通过“旧调用拒绝”投影。每个图节点重放最短前缀后，重新从真实公共 API 发出授权探针并与模型判断比较；检查不能以只重放正向边代替拒绝边。每条边另外从起点重放其前缀，确保证据包含完整命令序列。

PR40 的 sourceArtifact 和 MapReduce 容量新增分支不改变上述许可事务、LOCAL_* 守卫、执行子 actor 或 Store。回放起点显式断言 sourceArtifact 缺席、已领取 owner、没有 interpretation intent；LocalRuntime 输入也检查这些切片前提。它们不检查跨任务来源选择授权、来源内容不可变、修订交付或容量规划/格式修复，也不把对新依赖的哈希记录当作这些行为的证明。任务创建仍为单次 TeamEngine 房间事务，Interpretation CLAIM 的容量刷新只作用于该 kind，旧 owner CLAIM 的额度和许可边界保持。

安全不变量 OneStart 检查有限抽象计数，NoUnauthorizedStart 记录每次接受启动时的有效性；移除失效守卫的模型变体必须违反后者。StartDenied 自环及每节点探针验证拒绝路径。TypeOK 检查边界。模型的守卫不能自行证明实现守卫存在，因此回放和独立真实代码变体是交付的必要组成。Started/Stopped/Recovered（两域）、Approved/LeaseBusy（宿主）的故意假不变量必须产生对应 TLC 反例，防止关键前提不可达而空通过。

扩展 SessionScope 通过真实引擎准备、approveSession、领取、回执，再克隆已保存上下文做 256 输入组合×撤销位的纯函数对应。20 条生命周期实例使用真实引擎与双存储：明确撤销、恢复、目标变化、停止、新轮次，分别在 queued 和 claimed 点触发；检查新审批恢复、旧授权拒绝、迟到结果和租约释放。它们不是 SessionScope 全事务图回放。

真实 LocalRuntime.execute 的 10 个输入/文件变体验证 commandDigest（plan/action/requestHash/workId/epoch/goalVersion）的绑定。回调在 spawn 之前主动中止正常对照，无 fixture 命令运行；变体必须在回调前被拒绝。覆盖 runtime 的校验接线，不证明 host OS 进程的外部效果。

本轮限制：没有模拟两条真实 CLI 同时运行。MemoryStore/SQLite 对外部租约占用的相同结果仅证明此 Store 契约及接线，不证明 OS 文件锁或底层数据库抗断电实现。

逐边投影包括从已提交返回与读取所得的最远授权阶段、实际启动计数、停止状态、受控时钟及恢复/外部租约操作记录。stage/recovered/busy 是明确的历史观察量，不宣称是产品持久化字段；阶段变化只有在成功返回并核对真实 status 后计入。完整 checker 输入副本、每边投影、节点探针与 TLC 统计保留在证据中。

## KEJ-106 取消讨论恢复变更的切片审查

受审产品提交 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`；逐项源文件指纹、初始 blocked、候选/最终执行与真实负对照见 [维护记录](drift-review-kej-106.json)。新增 `canRetireDiscussionWork` 只处理带 discussionId、可安全重放且没有未决物理效果的过期讨论意图；recoveryIssue 的过滤、RECOVER 的逻辑结算和 LOCAL_RESULT/LOCAL_RECONCILE 后的结算仍位于原 reduce/存储事务。

本技能所有前缀无 discussion，且所有意图均无 discussionId。回放新增可执行断言固定这些前提，因此新 helper 在本切片恒为 false，恢复工作集合、许可/审批/租约和发布/冻结证据行为保持。原模型、性质、边界和负对照均不改变；不能把新 helper 的分片恢复正确性投影成已经由本有限模型证明。BT_Q19–Q23 的真实状态模型门槛和具体集成由产品验收另行承担。

### Engine ended 恢复入口增量

产品 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 仅在 engine.ts 增加既有纯谓词的导入，并把原 ended 直接跳过改为“ended 且没有可安全结算的过期 discussion 工作才跳过”。本技能可执行切片同时要求 discussion 缺席与所有 intent.discussionId 缺席，故新增 some 判断恒为 false：原 ended 仍跳过，非 ended 仍走原 RECOVER 事务。Delivery 回放只重开引擎而不调用 recover，Authority 的恢复仍逐边及生命周期实例核对。没有新增权限、发布、外部 I/O 或事务边界。

前轮 b6ea 的运行不能证明该新增产品源；本次 `kej-106-final-engine` 在实际 HEAD `0503c956a7c9af3d6ddaee7c7b54224e7f0f85ce`（3d81 后仅测试提交）完整通过并独立读回，62项覆盖源/依赖与产品 3d81 逐字一致。运行输入保留旧 sync=b6ea；成功后才将 sync 元数据推进至 3d81，再核对指纹及读回原证据，不重复执行同一源的完整检查。精确结果见 [维护记录](drift-review-kej-106.json)。新 ended+obsolete-discussion 路径由 BT_Q24 等产品验收承接，不扩大本模型保证。


## KEJ-102–105：验收接线与成功响应资源边界

受审产品及构建编排为 `32c26b376b46ae1a03718a6820683b59b802b413`；旧名义同步 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 在此 clone 不可用，先逐项证明可用 squash 基线 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 与旧覆盖清单所有源字节完全一致，再审阅其后提交消息和逐文件差异。旧新指纹、分类、原样 blocked 及完整检查状态见 [本轮对应审查](drift-review-kej-102-105.json)。

authority 的 Execution/Host/SessionScope 与 LocalRuntime 启动前中止探针不调用模型 HTTP；一次性许可、审批身份/摘要/期限、作用域、租约及本地恢复边界未改。 `package.json` 仅将 build 改为同样的两套 tsc 和 Vite 加构建证据记录，不改变依赖锁或本技能执行入口。没有新的领域写入口、事务拆分或投影字段；TLA/CFG、性质、公平性、界限及原真实代码负对照保持。

成功响应的实际解压字节上限、取消读取、UTF-8 边界与非瞬时失败由 BT_M46–M49 的真实 HTTP/SQLite/Runner 验收及撤销读取上限的负对照承接；本有限检查不证明供应方 I/O 读取、资源上界、真实进程终止、SQLite 底层抗断电或这几种领域的组合。KEJ-103/104 的真实 SIGKILL/SQLite 依赖验收是额外证据，不替换原模型的事务假设。审查后先更新已确认的覆盖指纹，保留旧 sync；只有完整正负/恢复检查与独立读回成功后才推进同步元数据。

完整检查与独立读回已通过：`reports/verify-squad-authority/kej-102-105-final`，保留 126 项原始证据；具体原图/恢复图规模、真实源码负对照和清理结果见审查 JSON 的 verification。同步推进到受测产品 `32c26b376b46ae1a03718a6820683b59b802b413`，后续集成 HEAD 的全部覆盖源/依赖逐项保持相同字节；不把元数据推进说成第二次完整验证。
