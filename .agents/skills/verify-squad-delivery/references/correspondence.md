# 交付模型与实现对应审查

审查基线 cd987f2f4a7e29ad3efae1af36a0f432ce813c8f，PR37 尚未合并。新增验证不修改产品文件。此文件是人工审查记录，不是自动等价证明。

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

coverage.json 保守列出当前 src 的所有 TypeScript 文件以及配置/锁文件，捕捉传递依赖漂移。重点审查 task.machine、task/lifecycle、task/policy、task/delivery、task/evidence、task/reducer、task/operations、task/input、store、engine；其他模块门禁只表示须检查是否影响这些入口，不扩大验证范围。

当增加第二候选、部分失败、WORKSPACE 验证、恢复动作或发布后继续时，应扩展变量和真实回放，而非直接把新路径投影成 stuttering。每个新原子动作必须对应实际事务；每个新字段要讨论它是否影响未来行为。现有模型没有候选替换历史，不可用于证明多修订场景正确。
