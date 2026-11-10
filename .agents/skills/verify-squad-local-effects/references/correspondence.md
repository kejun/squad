# 本地效果组合：实现对应与审计边界

本次只新增验证。现有真实 XState 和行为契约保持；中文场景为 features/37_local_effects_composition.feature 的 BT_L90–BT_L93。

## 变量与所有者

| 变量 | 真实观察/所有者 |
| --- | --- |
| op | 原 Intent.localOperations[].status；src/local-operation.ts 的 localEventProblem/applyLocalEvent/recoverLocalOperations |
| journal | CliJournal 公开 write/read/reconcile；prepared=尚无可信确定回执，settled=completion.settled且effectsKnown |
| lease | Store.acquireWorkspace/releaseWorkspace；原操作、空闲或另一房间操作。只用公开租约 API 的幂等探测，不修改快照或私有 Map |
| pending、receipts | 原 localCheckpoint.pendingOperationId 与该检查点 local_tool_result 消息数量 |
| stopped | 原 TaskContext.stopped |
| starts | 成功 LOCAL_STARTED 的观察计数，代表逻辑启动许可，不声称实际 OS 启动次数 |
| badSession | 错误会话 LOCAL_RESULT 被真实入口接受的历史观察标志；基线始终为false，独立性质SessionBound禁止错误回执获准 |
| falseNotStarted | prepared日志被CliJournal错误分类为notStarted的历史观察；基线为false，NoFalseNotStarted检查分类输出，不谎称已经重新执行 |
| online、crashed、rolledBack | 宿主驱动与有界故障记账，不声称是产品持久字段 |
| competitor | 另一真实房间的 LOCAL_CLAIM 已成功；该任务保持已领取，不自行模拟释放 |

## 逐边对应

| 抽象动作 | 公开接口与真实边界 |
| --- | --- |
| Init | 两房间 submit/claim/beginExecution/requestLocal；原 claimLocal 与 prepared journal.write。每项是独立真实事务/日志写，初始化前缀不是图内一个生产事务 |
| Start | send(LOCAL_STARTED)，只记录受校验逻辑启动；不执行 CLI |
| SaveReceipt | journal.write(settled) 的真实 fsync/rename，内容是环境合成的可信回执，不偷偷提交业务结果 |
| UnknownResult | send(LOCAL_RESULT, settled=false,effectsKnown=false)，保留本地与父工作 uncertain、检查点和租约 |
| Stop | send(STOP)；不把取消请求误作物理效果已决 |
| Crash | 驱动不再调用原引擎，持久记录不改变；真实 SIGKILL 另验 |
| Reopen | SQLite 关闭重开（Memory 保留Store），重建 TeamEngine，再 engine.recover；不合并 journal 核对或任务结果提交 |
| Commit | 先从 CliJournal.reconcile只读取已经固定的确定回执，再一个send(LOCAL_RESULT 或 LOCAL_RECONCILE)事务保存回执、检查点与租约结算；该只读步骤不改变模型变量，可消去为stutter，唯一生产线性化点是send。不能把此前SaveReceipt发布合并进来 |
| Rollback | failNextCommit 后执行相同 Commit，快照与租约必须保持；原引擎熔断，只有重开后可继续 |
| UnknownProbe | prepared journal 的 reconcile 必须 null；原操作 claimLocal 必须拒绝，不能把缺回执解释成可重做 |
| WrongSession | 新事件身份的错误 session LOCAL_RESULT，真实守卫拒绝且投影不变 |
| Duplicate | 重放原已提交事件，返回持久 duplicate 回执，不再次推进 |
| BusyProbe、Compete | 另一房间真实 claimLocal；原效果未决时拒绝，原可信结算后才成功 |

Reopen 的可执行切片断言保证 original 房间只有一个任务、没有待消费协助结果、协助/讨论/续办批次、没有到期工作且当前时钟尚未到 nextCheckAt。故 engine.recover 仅有一个可能改变投影的 RECOVER 事务（已结束任务可以跳过）；随后的 flushResults 循环和 tick 均不提交业务事件。不能把此结论扩大到生产的多任务或有结果的 recover 宏。UnknownProbe 的 journal 核对和拒绝领取是两次独立探针，均不改变投影，不宣称它们构成同一存储事务。

SaveReceipt 在完整 journal 文件发布时线性化，prepared 与确定回执分两种可观察结果；文件发布内部的 fsync/rename 正确性是环境假设，真实进程夹具只验证明确选取的崩溃屏障，不声称枚举每条文件系统指令。

lease 观察按 engine 中 room/task/operation 的规范摘要确定两个候选 owner，再用不持有的 probe 先检测空闲；空闲 probe 立即释放，同 owner 获取是幂等。观察事务不写 guarded 任务和回执，也不改变租约归属；若源码摘要格式改变，回放立即失败，需审查，不能伪造 owner 取得租约。

## 对应过程及限度

TLC 完整导出图；解析全部节点/标记边并核对原始生成计数和队列。对每条边分别从可达公共初始化前缀重建，重放一条最短源前缀、再执行该边，并逐项比较全部投影。Memory/SQLite 分开执行并保留每条 JSONL。该方法不是自动 refinement 或充分投影证明；同一抽象节点的全部具体历史没有枚举。

真实突变保持基线模型图不变，两种存储都要因目标行为失败：engine 错误释放 uncertain 租约；finishOperation 不消费检查点；LOCAL_RESULT 忽略 session；CliJournal 把 prepared 当 notStarted。编译/导入错误和哈希漂移不得冒充检出。移除临时副本后重跑原模型与真实回放。

replay-unknown的实际负对照在分类返回处被NoFalseNotStarted检出；模型变体也只改变分类观察位，不发送LOCAL_RECONCILE或把op改成queued。它证明错误的重放许可分类可被检出，不声称该次对照已经产生第二次物理写入。

完整图中的 Start/SaveReceipt 是可信环境输入的抽象；无需真实模型或 CLI。实际进程与原子存储接线复用 localEffectCrashAcceptance 和 SqliteTransactionCrash。前者证明受控非幂等账本一次效果、正确崩溃窗口、未知重复恢复、核对/旧停止结算；后者证明受控真实 COMMIT 前后 room/receipt/lease 同时可见与去重。它们不能替代模型的所有交错，也不能证明外部供应商效果可撤销。

不覆盖：宿主审批/会话授权、新旧 attempt 组合（authority）；固定续办批次（host-retry）；工程验证版本门禁（delivery）；共享预算与输入边界（coordination）；无限故障、任意数量操作、跨主机锁、磁盘/硬件损坏和 OS 身份探针正确性。

## 原子性与活性

确定回执保存和任务提交分开；故障可落在两者之间。单次 Commit 对应已有 Store.transact，数据库原子性作为假设。Rollback 真实检查完整 room JSON 与租约保持，不把其强度描述成 SQLite 实现证明。

SettledProgress 仅在最多一次 crash/提交失败、Reopen/Commit 弱公平下成立；未知日志无自动活性承诺。Six witnesses 与已恢复正路径防止不可达空通过。BT_L93 的无日志恢复/新 session 是独立真实接口实例，未增加进主图，不声称其组合已经穷举。

## KEJ-109：元数据读取与检查诊断审查

详见 [逐文件审查和运行记录](drift-review-kej-109.json)。先执行未修改技能，得到覆盖源漂移；旧同步提交不可读取时，逐项证明可用主分支 `5b8c596` 的全部 77 个旧覆盖文件与原清单字节相同，再审查本轮差异。新增目录、分页和共享方法三个传递依赖纳入 SHA 门禁。

本轮 `LOCAL_*` 效果守卫及 `finishOperation`、`recoverLocalOperations`、`CliJournal`、Store 未改变。命令目录只扩展发现动作，模型前缀仍为 owner/runCli，真实进程桥仍使用空目录及原命令。新 `saveCheckDiagnostic` 仅针对 bounded check，本切片没有 check 或 candidate，所以 WORK_FAILED 中该调用不写状态。共享方法是确定成功回执的纯投影，运行器只追加模型上下文，没有新增命令意图、journal 写入、检查点消费或租约释放入口。

维持原 LocalEffects 图、全部安全/活性性质、界限与恢复/提交事务映射，保留六个见证、四类模型/真实源码负对照、双存储逐边回放及七条实际进程接线。命令目录搜索、共享方法和检查诊断的产品语义由各自 BDD 验收承担，本有限效果模型不扩大为这些新领域的任意组合证明。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。

## KEJ-110 交付优化的效果切片审查

受审产品 `661e438e8705d08a36b9dc0d07b296616737eee4`。旧同步对象不可读时，先逐文件证明可用主线 `942dfe4` 与全部旧coverage指纹一致，再审查13项变更/新增依赖，详见 [KEJ-110审查](drift-review-kej-110.json)。新增sourceItems是纯预检和渲染，增量检查是纯投影，自适应修订的承诺由coordination单独更新；本切片保持既有动作原子性、模型、性质、公平性和界限。共享能力事实来自已结算回执，不写原回执、不发命令、不批准也不释放租约。不能把纳入传递依赖SHA解释为已形式化证明新增文本语义或任意新旧领域组合。

本切片没有交付或检查工作；LOCAL_RESULT/LOCAL_RECONCILE、CliJournal、检查点消费、Store和恢复守卫未变。完整108状态/282标记边，双存储每边对应、6个独立见证、4类模型/真实源码负对照、原版恢复复验及7条真实CLI/SIGKILL/SQLite进程接线均通过，证据 `reports/kej-110-661-local-effects`；228件原始证据独立读回及自洽缺件/截断/篡改读回负控通过，后者在 `reports/kej-110-661-local-effects-reader-controls`。

### KEJ-110 最终提示布局修复后的严格源绑定复验

产品 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9` 仅把sourceItems说明从deliver的JSON示例末尾移入owner系统提示；这些有限驱动不执行模型HTTP，因此授权、效果及批次的对应不受影响。仍按严格源绑定要求对最终源码完整重跑，未把661证据改称615运行。旧661目录保留历史；新运行、真实负对照、恢复后复验、独立读回和源未变检查均成功，详见本轮审查中的 strictSourceRerun 与 verification。

最终证据 `reports/kej-110-final-local-effects` 保留108状态/282标记边、4类模型与真实源码负对照、6见证、原版复验及7条真实进程接线；228件原始件独立读回成功。`reports/kej-110-final-local-effects-reader-controls` 的自洽篡改/缺件/截断负控重新全部通过。
