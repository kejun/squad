# 实现对应审查

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
