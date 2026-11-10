BT_F31冻结原始输入引用的来源链修复见[对应审查](drift-review-raw-input-citation.json)；保留精确ID/逐字引用、原子边界和预算性质。

# Code/model correspondence

## KEJ-106 旧讨论工作的安全退休

首轮受审产品提交 `b6ea8ac5d67b5acf331df0030d6157e582f016fa`，最终Engine增量提交 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b`；逐文件指纹、审查与执行结果见 [drift-review-kej-106.json](drift-review-kej-106.json)。`facts.canRetireDiscussionWork`仅接受带discussionId、pending/inflight、安全且无本地物理未决的旧轮次/旧版本工作。`recoveryIssue`不再让这类已可退休的历史成员阻塞当前配置；reducer在RECOVER的同一事务内以及可信LOCAL_RESULT/LOCAL_RECONCILE后复用release退休。unsafe、uncertain、物理未决和当前有效轮次不满足守卫，release仍有物理占用保护，未拆分事务或改变费用。最终Engine增量只改变ended任务是否选入原RECOVER事务，不将RECOVER与flush合并成一个原子动作。原Shards被排除的取消inflight→RECOVER、Budget/CheckBudget无discussion前缀及各自普通ended重开路径均未扩域。

Budget/CheckBudget公共前缀及每次context读取显式断言无discussion与无discussionId，因此新守卫恒false。原Shards只允许Active安全inflight恢复，或无inflight的非Active重开（Shards.tla的Reopen守卫）；原图不含LOCAL_*。这些已有状态/边的投影和语义不变，TLA/CFG/性质/公平性均保留。

新增`discussion-recovery-probes.mjs`复用replay.mjs的公共前缀，不复制BDD驱动、不在临时源码负对照中导入原工作树的实现。双存储各15个有限实例中13个从submit/claim/send/recover等公开入口推进；historical-pending只改持久快照中的旧工作status，以复现旧版RECOVER生成的兼容形状；unsafe-compatibility只改replay分类，是守卫输入实例而非当前可达历史。SQLite重开实际关闭并重建连接。最终Engine只对含可退休安全旧讨论工作者的ended任务发送RECOVER；没有可退休工作者的ended任务仍跳过。map-ended/discussion-ended真实重开两次，检查ended/outcome/owner列表和计费不变，public submit(intent:continue,replyToTaskId)后双方重新claim；两种已知LOCAL_*实例先在ended任务真实恢复，确认安全companion退休、另一成员unknown保留，公开继续拒绝UNRESOLVED_WORK，可信receipt后才继续并重邀双方。所有实例无适配器/OS执行。

6个新增真实源码负对照使用不变的正确TLC图及驱动：删RECOVER退休→CancelledRecovery；恢复检查继续校验旧成员→ObsoleteMemberRecovery；删已知LOCAL_*退休→SettledDiscussionRecovery；移除safe守卫→UnsafeRetention；允许退休当前轮次→ActiveDiscussionRecovery；恢复旧Engine ended无条件跳过→EndedDiscussionRecovery。每项Memory/SQLite都必须因目标行为失败，不能以源码哈希/导入错误冒充检出。物理/uncertain保留有正向有限实例；不声称每个冗余守卫都有独立突变完备性。

Shards仍未穷举取消后inflight→RECOVER、新轮次重新邀请、任意成员/版本/本地效果组合。新增有限实例不是这部分的TLC证明；预算与宿主执行领域仍是独立切片，不能由各自通过推出全系统组合证明。

BT_M37 检查信封说明审查：基于 `670df3e08d80a2179c4ab9e733e7f810bb1a0bbe`，仅 `checkMessages` 两条协议提示文本改变；模型、投影、守卫、事务和回放边界不变。逐项审查与验证状态见 [检查信封审查](drift-review-check-envelope.json)。

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


## KEJ-102–105：验收接线与成功响应资源边界

受审产品及构建编排为 `32c26b376b46ae1a03718a6820683b59b802b413`；旧名义同步 `3d81b0792d9c00c16bbc59fa4f2914bcccc0189b` 在此 clone 不可用，先逐项证明可用 squash 基线 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 与旧覆盖清单所有源字节完全一致，再审阅其后提交消息和逐文件差异。旧新指纹、分类、原样 blocked 及完整检查状态见 [本轮对应审查](drift-review-kej-102-105.json)。

Budget/CheckBudget/Shards 及容量/讨论恢复实例仍由合成事件和省略 maxResponseBytes 的固定服务配置驱动。新适配器读取不参与请求计费或分片结算；原守卫、retry/修订上限、唯一归并与有限投影不变。 `package.json` 仅将 build 改为同样的两套 tsc 和 Vite 加构建证据记录，不改变依赖锁或本技能执行入口。没有新的领域写入口、事务拆分或投影字段；TLA/CFG、性质、公平性、界限及原真实代码负对照保持。

成功响应的实际解压字节上限、取消读取、UTF-8 边界与非瞬时失败由 BT_M46–M49 的真实 HTTP/SQLite/Runner 验收及撤销读取上限的负对照承接；本有限检查不证明供应方 I/O 读取、资源上界、真实进程终止、SQLite 底层抗断电或这几种领域的组合。KEJ-103/104 的真实 SIGKILL/SQLite 依赖验收是额外证据，不替换原模型的事务假设。审查后先更新已确认的覆盖指纹，保留旧 sync；只有完整正负/恢复检查与独立读回成功后才推进同步元数据。

完整检查与独立读回已通过：`reports/verify-squad-coordination/kej-102-105-controlled-env`，396.510 秒，保留 301 项原始证据。三套原图及恢复图的队列均为零，两存储全部边与有限实例比较通过，22 项真实源码负对照均因目标行为失败，清理和 checker 输入不变检查通过；具体数量见审查 JSON 的 verification。同步推进到受测产品 `32c26b376b46ae1a03718a6820683b59b802b413`，后续集成 HEAD 的全部覆盖源/依赖逐项保持相同字节；不把元数据推进说成第二次完整验证。

## KEJ-107/108：协作组合的新增有限域

原 Budget/CheckBudget/Shards 保持其完整历史域。新增入口 `scripts/check-extensions.py` 独立运行以下**真实 TLC 有限图**，不把旧 capacity/discussion-recovery 有限实例改名为证明。每图每条边从公共可达前缀重新建立真实 TeamEngine，在 MemoryStore 与 SQLite 逐步比较所有图变量；每条边只选一条最短代表前缀，未证明其他隐藏历史等价。记录源码实际 SHA、checker 输入、原始 TLC 图/日志、完整双存储回放、独立可达见证、真实源码负对照、原版复验与证据读回。

- **DiscussionBudget**：原负责人已领取且消费首请求；直接邀请两位空闲成员并由已领取促进者保存计划为 Init。`used/requests` 对应 usage.ordinary 与原工作 requestCount；`member1/2` 对应两个已承诺意图状态；`summary` 对应 discussionSummary；`handoff/successor` 对应 delivered 与新负责人领取；`reserve` 独立从 pending 成员/汇总和轮次状态推导。成员 CLAIM、结果、汇总 CLAIM、结果、原 owner SETTLE、后继 CLAIM 均是独立事务。一个额外 owner CONSUME 可与它们交错；达到保护边界拒绝。证明两成员、一次归并、一次负责人续办在此余额7的动态域，**不是任意多轮或所有预算领域笛卡尔乘积证明**。
- **ReservedRequests**：review/retry/host/verification 四个独立可达前缀固定当前义务，枚举首次免费使用已付请求、额外付费请求及前沿拒绝。host 前缀中活跃宿主批次与背景讨论同时存在；保留量3含一个尚未收费宿主命令、一次讨论归并及一次 owner 续办。verification 是缺报告后真正生成的唯一修订 owner，保留验证费用；没有执行 CLI 或模型。四域不枚举义务生命周期任意变化，变化部分由 DiscussionBudget 和其他技能承接。依据 `task/budget.requestBudgetProblem`、reducer CLAIM/CONSUME。
- **InputBoundary**：help/check 两前缀。help 枚举补充与保存结果的先后、独立 Flush、解释领取、成功/澄清、一次恢复、一次明确继续及停止。check 的 Init 是一个已消费首请求且已冻结证据的真实候选；旧 CHECK_RESULT 在补充未解析时只能交接，解释成功在同宏步 BOUNDARY 清除旧检查证据。`InputNote.applied` 与 `InputAnalysis.status` 是不同事实：help 消费可能先标 applied，再解释；check 路径解释结束后才标 applied。CONTINUE 新建 deliveryCycle，会清除旧 evidence；这是源码行为而不是额外模型迁移。没有第二个补充、真实语义质量或无限澄清。
- **ReviewQueue**：两名明确请求的评审成员、成功/确定失败、RECORD_RESULT 与 Flush 分立、一次安全恢复、重复/迟到结果、一次对第一位失败成员的显式 retryOf 修复。completed 必须属于 targets 且唯一；同一收集阶段只有一个有效成员工作；每次完整收集只生成一个有效汇总。修复沿用同 reviewId，会保留第二位结果并取代旧 pending owner，因此完整历史可以有两份汇总意图，但只有当前一份有效。停止后只有无在途工作时显式继续才建立空的新 pending 轮次；新轮次后续执行不在这个图里。预算足够，不冒充共享预算组合保证。
- **DeferredCoordination**：一个 safe 工具、两个失败指纹、阈值2、一次新证据进展、一次普通 ACTIVITY、一次恢复和停止。repeat 的重置不等于撤销已有协调义务；工具结算或安全恢复后由当前宏步生成唯一协调意图，STOP 阻止后继。`Progress` 在持续有效的延期请求、可执行工具最终结算/安全恢复/领取动作弱公平下成立；不证明真实调度公平或永久未知效果下进展。
- **CancelledDiscussion**：map/discussion 两公共前缀 × goal/stop/end 三失效来源 × 无物理操作/一项已启动隔离 CLI，共12域。两个旧成员均真实 CLAIM，物理变体的 request、claim、start 各自先经公开事务到达 Init。Cancel、RECOVER、可信 LOCAL_RESULT、显式继续、owner CLAIM、新邀请、planner CLAIM、计划、新成员 CLAIM、旧结果拒绝分别为图边。最多两次恢复；一个旧成员未知时保留占用并拒绝继续，安全同伴退休；已知原回执后释放，再公开邀请双方。没有 unsafe 讨论快照、人为改状态或 OS 命令。本地进程是否真结算由外部可信回执假设承担，其他技能检查其执行接线。

### 原子性及活性边界

InputBoundary/ReviewQueue/Deferred 的恢复边使用 constructor 重开连接后 `engine.send(RECOVER)`，**不调用会继续 flush 的 engine.recover**；Flush 单列。CancelledDiscussion 没有保存结果、只有一个任务、时钟0且所有期限尚未到：其 engine.recover 至多产生一个 RECOVER 事务；已退休 ended 任务重开为0提交 no-op。测试 Store 代理独立计算提交次数并断言这一限制，所以并未把多个提交伪装为原子操作。TLC 的单个环境重开/恢复尝试可对应0或1提交，执行中间没有其他被模型省略的存储变更。

所有安全结论独立于公平性。Input Progress 允许合法澄清或 STOP 作明确终点；不把“用户最终回答所有澄清”写成无条件保证。Review Progress 假设可领取工作/合成返回/Flush 弱公平，允许用户停止。Cancelled RetirementProgress 除恢复弱公平，还假设已启动效果最终有可信已知回执；若永远未知，安全保留但不声称终会释放。Discussion 的公平推进动作只覆盖有预算的基础领取/返回/交接，不证明额外工具总能成功。ReservedRequests 只证明授权/计费安全，不作业务完成活性声明。

### 首轮模型误差及新增源码审阅

首轮发现的是模型投影问题：澄清是合法人工等待终点；CONTINUE 新建周期清 evidence；旧事件拒绝可能退休自己的已取消工作，不能一律 stutter；safe 工具恢复为 pending 后达到重复阈值仍可协调并取消该 pending。这些修正从现有源码和公共回放取得，没有弱化产品承诺或改产品代码。

原覆盖清单从6432243到当前工作树的额外传递依赖变化为 `local-runtime.prepareScratch` 对缓存工程副本再次准备，以及 `local-skills.readonlyDirectories` 对已发布技能目录再次设只读。旧三模型和新增组合图均不调用这些文件系统适配器；其初始化模块不增加业务动作、调度、许可或事务。因此保留原域并更新实际字节漂移门禁，真实执行可靠性由独立接线验收负责。源码版本以最终证据中的 commit 与 coveredFileHashes 为准；未完成整轮检查前不推进成功同步声明。

当前产品e77f052还在WebService启动效果核对循环中增加closing提前退出。新增/旧协调驱动不实例化该服务，模型无启动I/O，故不改变有限切片；真实接线由服务恢复验收负责。以上三项已逐文件审查，非仅更新哈希。

首次全域回放还区分了ended恢复选择：若安全旧同伴已由迟到结果退休，而只剩带物理未决的旧成员，engine.recover可能0提交跳过，原成员仍为inflight/cancelling并继续占用，不是已结算。CancelledDiscussion因此将Host RECOVER与room Reopen分别建边；后者包含明确0提交条件，前者单独做1次RECOVER。两者均保留未知成员，可信结算后才退休。本模型不证明WebService会为这条ended历史自动发起效果核对。

可信回执退休的负对照单独指向KnownReceiptRetirement：receiptAfterCancel来自持久trace中cancel-round与trusted-receipt的顺序，只在取消后得到可信已知回执时要求原工作立即done，不把“恢复前已获得的回执”错误等同为已退休。primaryBusy直接投影原负责人inflight，LateOwner仅结算该原工作。两字段均进入真实TLC变量和每边双存储投影，不隐藏影响Continue的状态。

### 最终执行结果

产品源码e77f052acacd208fd8eb8587ac6901ba19003220上，`reports/verify-squad-coordination/kej-107-108-extensions-complete`完整通过，389.684秒。21配置正向及未改坏原版复验，各阶段每个存储比较2998条模型边；58个声明的前提见证、18项真实源码负对照在两存储均以正常exit1、AssertionError及各自目标性质失败。5个外层SHA自洽删除输入分别因目标raw缺失/必需进度性质缺失被拒绝。独立读回889份保留证据通过，三个cleanup字段均为true。原三图当前产品复验及330份读回为`reports/verify-squad-coordination/kej-107-108-original-reviewed`，339.623秒。

此前candidate/final目录是模型投影/负控定位的未完成红运行，不是当前产品缺陷结论，不作为通过证据。最终完整轮中源码、模型、checker和fixture均未变化；后续仅推进当前成功元数据，不把元数据推进说成额外完整复跑。场景BT_J01–J06另直接执行18实例全部通过；这与21配置TLC及双存储图对应证据分别计数。


## KEJ-109 CLI 元数据与定向引用诊断审查

最终受审产品提交为 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596`。历史同步 e77 提交在当前浅克隆不可用，已逐项核对可用基线 5b8c596 的全部原覆盖文件与旧 SHA 完全一致，再审阅其后三个提交及10个已覆盖文件和3个新导入模块。逐文件理由、原样 blocked、运行和独立读回记录见 [KEJ-109审查](drift-review-kej-109.json)。

CLI catalog/分页及共享调用经验是纯投影或适配器路径，不新增调度、计费或执行授权。交付引用诊断在原 CHECK_RESULT/WORK_FAILED 事务内只追加当前候选的 checkDiagnostics；原引用错误码、补试/请求/修订上限和事务边界保留。非引文错误不追加诊断，CheckBudget 的 BadProtocol 和无诊断技术失败仍得到相同固定材料。现有模型、性质、公平性和界限均不变；新引用正文诊断、真实CLI发现与模型HTTP质量由独立场景验收，不能因本检查通过声称已形式化证明。

本轮原三图完整检查及原版复验在 `reports/verify-squad-coordination/kej-109-reviewed` 通过，422.184秒：Budget151状态/345边、CheckBudget117状态/237边、Shards456状态/1379边，双存储每阶段比较1961边，19个见证、22项真实双存储源码负对照通过；独立读回331文件通过。组合入口 `reports/verify-squad-coordination/kej-109-extensions-reviewed` 完整通过，467.595秒：21配置、58见证、18项双存储真实源码负对照、恢复后全域复验、5项自洽证据删除负控、每存储每阶段2998边以及892份原始证据独立读回通过。两入口cleanup全true。

实际运行在2cd9bad加当时已存在的适配器消息排序改动上；随后逐文件证明全部覆盖源码与最终产品提交 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596` 完全一致，再推进两个syncCommit。新增场景身份的后续重编号不改本模型或覆盖代码。当前元数据不是一次额外完整复跑；旧e77记录和本轮初始blocked证据均保留。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。
