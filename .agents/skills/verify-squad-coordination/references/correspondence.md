# Code/model correspondence

KEJ-100 依赖审查：`c1f380da1527b8c22a8aaaaf7aef10cd2695146e`，仅空单测集合的 CLI 处理变化；无产品转移、守卫、事务或模型变更。当前审查及完整复跑证据见 [drift-review-kej-100.json](drift-review-kej-100.json)。以下保留 PR40 的产品源码审查。

审查基线：`21ee46039f594d9b93d400bf703e14d42fab2b0e`（PR40）。旧基线 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f` 至此的全部21个src差异、提交消息和性质判断见 [drift-review-pr40.json](drift-review-pr40.json)。旧基线与PR37 squash main d7b80a4完整树相同。没有修改产品行为。本审查继承 AGENTS.md 的事务/纯状态边界，以真实 TeamEngine 公共入口为回放对象。每个抽象动作对应 engine.send/claim 的一次提交，Reopen 包含重建存储连接及 public recover 对本任务的一次 RECOVER；没有跨实际事务伪造原子性。模型起点有可执行前缀，不能直接注入不可能的 context。三个模型与补充容量实例均显式断言context.sourceArtifact缺席，防止投影静默忽略来源任务行为。

## Budget

公共前缀：submit（显式 goal、输入解析关闭）→ 一个 pending owner。

- `Claim` → `TeamEngine.claim` → `task/policy.permissionProblem(CLAIM)`、`task/budget.requestBudgetProblem` → `task/reducer.reduce(CLAIM)`。普通 work 的 claim 增加 usage，并将 requestCount 归零。
- `Consume` → `send(CONSUME)` → policy 请求计数守卫 → reducer：第一个请求用领取已支付额度，后续请求再加 usage。
- `Fail`/`Uncertain` → `send(WORK_FAILED)` → guards.retryable/canRetryWork → reducer：仅已知可重放 transient 且剩余额度/重试额度足够才重排；unknown 不自动重排。
- `Recover` → 关闭/重开 SQLite（MemoryStore保留同一对象）→ new TeamEngine + recover(room)。安全 inflight 回 pending，不清 usage/retries；再次领取付普通额度。
- `Continue` → send(CONTINUE, extraOrdinary:2)，是**用户显式追加**，不是自动刷新额度；进入第二 epoch、保留 usage/retries。
- `StaleAttempt` → 旧 attempt 的失败事件被 policy 拒绝，不应释放当前尝试。
- `DeniedClaim` → 耗尽额度的 claim 返回 null，并可能经过任务结束逻辑取消 pending work。本模型将 cancelled/done 都投影到已结算2，只在实际允许的 waitingHuman/ended 中继续。
- `DeniedConsume` → 已耗尽额度时额外请求拒绝，不增计费。

`charges` 是驱动对成功领取与额外 CONSUME 的独立计数，不从 usage 计算；因此删计费能被查出。work聚合了done/cancelled，因为本模型只关心之后允许用户继续而非两者内部语义；若其后有区别的新路径，须扩展投影。

## CheckBudget

公共前缀：submit → claim owner → DELIVER（非空合格文本、无文件输出）→ pending bounded check，cycle.requests=0。

- `ClaimCheck` → claim 只增加 attempt，不增加 usage.checks/currentRequests。
- `Consume` → policy 检查当前 candidate 的一用许可与 deliveryCheckBudgetProblem → reducer 增加 cycle.requests、usage.checks/currentRequests，reserved技术许可变used。
- `Failure` → transient WORK_FAILED，只有 work.requestCount>0、无 cycle.retry、未耗完请求/全局retry才 reserveDeliveryRetry；在首次请求前失败不构成免费技术重试。
- `BadProtocol` → CHECK_RESULT 空 criteriaResults，经 checkDisposition 协议校验走技术 retry 或停止；不通过格式错误虚构业务检查失败。
- `FailedJudgment` → 完整 criteriaResults 全failed，经 checkedDelivery/canReviseDelivery 仅一次生成 deliveryRevision owner；后续再失败终止。
- `PassedJudgment` → 同一候选完整判断全passed，结束周期。实际证据内容校验由 verify-squad-delivery 覆盖。
- `ClaimRevision`/`DeliverRevision` → 真实 claim owner / DELIVER 两次独立提交，不合并为一原子动作。新 check requestCount 为0，但 cycle.requests/retry/revisionUsed 保留。
- `Recover` → 支持两个恢复事件，pending重复恢复保留reserved；已发请求的inflight先预留一次technical permit；used后再恢复无法另预留则结束。工作额度高于所需普通步骤，不把这个模型当作普通预算组合证明。
- `DeniedConsume`/`DuplicateResult` → 没有新许可的重复请求与已结算检查结果被拒绝，不追加请求/修订。

`revisions` 从持久 owner intents 的 deliveryRevision 标志计数，独立于 cycle.revisionUsed，因此遗漏标记不会空通过。`checks` 读取全局计费，`requests` 读取周期计数。模型只含一个周期，所以检查二者相等；跨多个用户周期全局检查数不能再这样投影。

## Shards

公共前缀：submit复杂输入 → claim interpretation → INTERPRETATION_RESULT携带两个独立分片。`startMapReduce` 的宿主成员分配、quota守卫创建两项pending assistance，owner暂不运行。

KEJ-99 将成员、协助余额、普通余额限制合并为 `task/map-reduce-capacity.ts` 的共享纯函数。对于schema允许的2..8片，`partitions.length <= max(0,min(8,members,assists,ordinary-2))` 与旧三个dispatch守卫等价。prepareInterpretation 在 cancelWork 后为未收费理解请求预留1次；CLAIM 先收费，再仅对已有数字提示刷新容量，不给历史缺省字段补值。TLC前缀的普通额度20、4名非owner成员足够创建两片，驱动独立断言准备/领取容量均4。之后的分片结算、唯一归并与handoff动作没有变化，故不扩张或缩小图中的变量/动作/性质。

`capacity-probes.mjs` 是与TLC图分开的有限实例：双存储各运行容量0/1的两片整体回退、容量2的两片完整分发、容量4的四片完整分发、公开claim→recover→re-claim后普通计费保持且提示4→3使原四片整体回退、旧快照移除新增提示后重领不补字段但仍执行当前dispatch守卫。直接调用 `validInputIntent` 验证数字cap与缺省静态协议，不能据此声称运行适配器HTTP或修复循环。保留完整分片目标/产出/归并要求及owner输入，分别检查 assist消费和无部分派发。每种新增断言有真实源码突变负对照；0/1/4片和容量状态没有加入模型穷举。

- `Claim1/2` → TeamEngine.claim，经 policy/workLaneAvailable 允许两成员并行。
- `Success/Partial1/2` → DISCUSSION_RESULT，acceptDiscussion在同一状态提交释放work、保存原始results、必要时设置incomplete，仅所有分片非pending/inflight才创建discussionSummary。
- `Failure1/2` → WORK_FAILED、discussionFailed；保留失败结果并参与“已结算”判断，不自动重试或伪造成功。
- `ClaimSummary` → claim reducer；`SummaryResult` / `SummaryFailure` → 归并内容或原始来源兜底，discussionReady 与机器内部 DISCUSSION_HANDOFF 在同一宏步存储提交内完成。`task.machine.ts`/guards 的 handoff 要求无在途阻塞；本界限只含该两分片与reducer。
- `Stop` / `ChangeGoal` → STOP / USER_INPUT含goal，cancelWork(true) 取消pending，保留真实inflight等待物理结算，discussion变cancelled。目标版本变化不等于原work版本变化。
- `Late1/2/LateSummary` → actions.reject 允许过期完成只结算属于自己的旧work，不推进新目标；**不是全状态stutter**。模型明确释放旧work，无results或handoff变化。
- `Duplicate1/2/DuplicateSummary` → 同结果内容使用新event ID，真实状态守卫拒绝。不是仅依赖存储receipt去重。
- `Reopen` → active安全inflight回pending（可再领取），已结算results不变；也允许无inflight边界重开。`interrupted` 记录本次reopen是否遇到inflight，防止恢复见证仅静态空通过。只允许一次reopen，所以再领取次数有界，普通额度20足够；不证明无限崩溃下预算公平。

独立 `RecoveredStaleAttempt` 探针保留恢复前的分片 ticket，重开并再次领取后送回旧 attempt，断言拒绝且投影完全不变；真实负对照移除 policy attempt 守卫必须检出。图投影没有把每个隐藏 attempt 编号列为模型变量，因此不声称对所有尝试历史等价。

`results`按成员身份投影，保留success/partial/failed但不按数组顺序比较；原始正文在fixture固定，本文不证明任意正文的语义质量。owner handoff计数只匹配原round.id和delivered快照，不将换目标产生的新owner计入旧轮次。

## 审查中修正的模型误差（非产品缺陷）

1. 初稿把额度拒绝的claim当stutter；真实引擎结束并取消耗尽的工作，改为结算投影。
2. 初稿把迟到分片结果当stutter；actions.reject会物理释放原work，按源码加入Late动作结算。
3. 初稿仅无inflight重开；为覆盖执行中恢复，加入current active inflight→pending与独立中断见证。
4. ordinary模型不等于交付检查预算，因此单独新增CheckBudget，没有用普通额度检查代替KEJ88的2+1检查/一次修订契约。

## 覆盖缺口

TLC不枚举超过两个分片、容量资源状态、任意输入组合、动态成员权限、宿主副作用、真实模型HTTP返回质量、时间超时、发布证据任意正文、磁盘崩溃或多个任务竞争；新增有限实例的范围见上文。KEJ-98 的固定来源解析、原文保存与跨任务发布不在这三个无source前缀中，不因新增传递依赖哈希声称已形式化证明。Shards未覆盖取消后仍inflight时再RECOVER，authority技能覆盖不同但相关的授权/恢复边界，不能由两技能单独通过推出它们完整组合。Budget不含所有discussion/host-reservation支路，CheckBudget不含stop/new goal/new user delivery-cycle。明确列出的有限模型和代表前缀之外仍需产品回归与审查。
