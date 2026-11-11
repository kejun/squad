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

## KEJ-108 ApprovalComposition：重新授权与新父attempt组合

这是新增独立有限图，原Authority/SessionScope/Execution的模型和范围未被替换。TLC变量是`attempt`、`stage`、审批身份等价类、一次撤销、一次恢复、父工作是否待重新领取、新permit是否消费、原审批command是否已有成功回执及实际开始计数。首次预备领取及LOCAL_APPROVAL_REQUIRED已在公开前缀完成；允许RECOVER时操作为awaitingApproval或queued，尚未为实际执行再次领取，不覆盖claimed/running的物理恢复。

| 图动作 | 真实公共入口/存储原子边界 | 不变量与观测 |
| --- | --- | --- |
| Init前缀 | submit→claim→beginExecution→requestLocal→claimLocal→send(LOCAL_APPROVAL_REQUIRED) | owner attempt1许可已消费、宿主操作待审批、无讨论/分片/检查/来源/hostRetry |
| Approve | TeamEngine.decideHostApproval→send的一次事务 | 当前approval ID批准为approveSession；固定commandId `approve:审批代` |
| Revoke | TeamEngine.revokeHostSession→纯revokeHostSession | queued操作回awaitingApproval、换ID、清会话；最多一次 |
| Recover | SQLite实际close/reopen（Memory重建Engine）→engine.recover的一次RECOVER事务 | 旧owner pending、审批换ID、会话清除；不触及任何已实际领取/启动命令 |
| ReclaimParent / NewPermit | 公开claim与beginExecution分别是两次事务 | 产生attempt2并消费其独立一次性票据，不能合并成一个模型动作 |
| Claim / Start | claimLocal与send(LOCAL_STARTED)分别一次事务 | 当前parentAttempt/session/授权有效，开始计数从已接受的公开事件记录投影 |
| LateDecision / LateClaim / LateStart | 使用旧approval ID、旧parentAttempt或旧预备session提交的新事件 | 拒绝，当前work/grant/permits/usage/candidate不变 |
| OldPermit / DuplicatePermit | beginExecution传入旧attempt票据或重复消费attempt2票据 | 返回false，不影响当前许可或工作 |
| ReplayDecision | 用原成功approve:0和完全相同命令体再次decideHostApproval | 可以返回保存的ok=true，但上述领域投影全部不变；不能以ok=false作幂等假设 |

开始计数只数该宿主提交的已接受LOCAL_STARTED事件ID，不把同一转换的附加诊断记录重复算成另一次执行。审批ID投影是公开结果中观察到的三个不同身份映射，不从内部私有Map构造状态。每条TLC边从一次公共可达最短前缀重放，Memory/SQLite均覆盖182边；不同具体历史映射到同一抽象状态时不据此宣称全程序等价。

图显式包含Approve/ReclaimParent/NewPermit/Claim/Start的弱公平性，在至多一次撤销与恢复后证明`Progress`。这是调度与用户批准的条件性活性；用户永久不批准、物理效果未核清、无限轮次和任意外部I/O均不在图内。

最终完整证据为`reports/verify-squad-authority-composition/final-complete`：基线/恢复各183生成、36不同、0队列，双存储各182标记边；四见证、四源码变异各双存储检出及原实现恢复复验通过。独立读回110件并额外核对双负后端/见证/活性。BT_N30–N32直接执行3场景、12业务步骤（另132共享钩子）；这些实例没有冒充新图。

## KEJ-109：命令元数据与检查诊断的切片审查

逐文件差异、等价基线及完整运行状态见 [原授权审查](drift-review-kej-109.json) 与 [授权组合审查](drift-review-kej-109-composition.json)。旧同步提交在本 checkout 不可读取；先证明可用主分支基线 `5b8c596` 的全部 62 / 64 个覆盖文件与旧清单 SHA 逐一相同，再审查本轮提交及受测工作区差异。新增 `catalog-search`、`cli-catalog`、`task/tool-knowledge` 三个传递实现依赖也纳入门禁。

`validLocalAction` 只扩展 `discoverHost` 的查询/游标；上述有限前缀仍请求 `runCli`。原 `LOCAL_CLAIM`、审批身份/摘要/期限、session、一次性许可、租约、停止与恢复守卫没有变化。目录类只读取/克隆受信元数据，空目录构造没有 I/O；原运行时绑定夹具保留默认空目录、无技能的 owner 输入。共享方法是已有确定成功回执的纯投影，不能产生新操作或批准。检查诊断只写当前候选的 bounded check；本技能的 owner/runCli 前缀没有 check/candidate，新增保存调用在此返回而不改变状态。

原 Authority/SessionScope 和 ApprovalComposition 的模型、性质、公平性、有限界限、逐边回放与真实代码负对照保持原样。目录与分页正确性、共享方法语义、引用诊断和任意新旧操作组合继续由各自场景验收承担；本审查不把源指纹扩展当作新领域的证明。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。

## KEJ-110 交付与纯投影变更的授权切片审查

受审产品 `661e438e8705d08a36b9dc0d07b296616737eee4`。旧同步对象不可读时，先逐文件证明可用主线 `942dfe4` 与全部旧coverage指纹一致，再审查13项变更/新增依赖，记录于 [KEJ-110审查](drift-review-kej-110.json)。授权与审批组合前缀没有candidate/check/sourceItems；新增来源门禁、增量检查及自适应修订不进入这些前缀，共享能力事实只是带来源的纯观察，不能授予一次性许可或审批。LOCAL_*、approval/session/digest/lease、恢复及事务提交边界未改变。

原authority完整34步骤、全部6类真实代码负对照、原版恢复复验及独立读回通过，证据 `reports/kej-110-661-authority`；授权组合36状态/182边，两存储逐边回放、四类真实负控、完整恢复复验及独立读回通过，证据 `reports/kej-110-661-authority-composition`。不把源hash扩展或这些有限授权检查说成已证明sourceItems语义、增量审核质量或预算与授权任意组合；预算承诺变化由coordination模型独立维护。

### KEJ-110 最终提示布局修复后的严格源绑定复验

产品 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9` 仅把sourceItems说明从deliver的JSON示例末尾移入owner系统提示；这些有限驱动不执行模型HTTP，因此授权、效果及批次的对应不受影响。仍按严格源绑定要求对最终源码完整重跑，未把661证据改称615运行。旧661目录保留历史；新运行、真实负对照、恢复后复验、独立读回和源未变检查均成功，详见本轮审查中的 strictSourceRerun 与 verification。

最终入口证据为 `reports/kej-110-final-authority`（34步骤）及 `reports/kej-110-final-authority-composition`（36状态、182标记边，两存储各完整回放）；6类原授权与4类组合真实代码负对照全部检出。独立读回均退出0。


## KEJ-111：工具失败反馈与补齐分片的旧切片审查

受审冻结产品 `c239dd39d86f143a2f435f48590c648b20745b8b`；可用旧基线 `49d2bc0ec61df94581cc52aef48725b040ea8603` 的所有旧coverage文件与旧同步清单逐项同SHA，原样运行先被漂移门禁阻塞。12项改变/新增实现依赖的分类及原始阻塞证据见 [KEJ-111审查](drift-review-kej-111.json)。

原authority回放和runtime-binding显式断言无discussion、无discussionId、无输入解释；ApprovalComposition.observe另断言无check、hostRetry或sourceArtifact。它们直接调用公开TeamEngine/LocalRuntime，未实例化WorkRunner或OpenAICompatibleAdapter。新增RECORD_TOOL_FAILURE不在图动作字母表；旧一次性许可、审批/会话/租约身份守卫均保持。late-DELIVER仍是旧目标拒绝探针。新增MapRecovery只在有当前分片恢复声明及独立检查时写resolution；这些前缀不具备该条件。

因此旧图、全部性质、公平性、有限界限、双存储逐边比较及真实源码负对照保持。新Web恢复/MapRecovery有自己的有限扩展与具体BDD，不以保守传递依赖指纹声称这些旧图已验证任意新旧领域组合。最终完整执行、恢复后复验、负对照与独立读回状态见本轮审查，pending不算通过，不推进syncCommit。

最终冻结源完整复验已通过：`reports/kej-111-final-authority`（34步骤，Execution 8状态/19边，Host 48状态/174边，SessionScope 512输入投影，6类真实源码负对照）与`reports/kej-111-final-authority-composition`（36状态/182标记边，双存储、4见证及4类真实源码负对照）。独立读回分别核验139/191件原始证据。各运行与恢复后复验成功，清理及覆盖源未变为真；不将稍后同步元数据声称为额外完整执行。

## KEJ-112：任务工具引导与 CLI 重复失败守卫的切片审查

受审冻结产品为 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。原样两入口先被覆盖漂移门禁阻塞；可用基线 `6134a0c` 的全部旧 73/75 个指纹逐项与旧清单相同。7 个变化文件和 3 个新增纯传递依赖的旧新 SHA、分域理由及真实运行状态见 [KEJ-112 审查](drift-review-kej-112.json)。

`LOCAL_REQUEST` 的新守卫只在同一工作已经发生两次相同可诊断 CLI 失败时拒绝。Execution 和 SessionScope 不申请 CLI；Host、ApprovalComposition 的公共前缀只创建一个宿主操作，没有两次先前已结算失败，因此新守卫在本域恒不触发。请求 receipt ID 增加完整不可变请求身份，仍保留 operationId/requestHash 的操作幂等检查；它不改变审批摘要、旧审批/旧 attempt/旧 session/旧 permit 的资格，也不拆分事务。原 claim/start/stop/recover、会话和租约规则保持。

这些驱动直接调用 TeamEngine 和 LocalRuntime，不实例化 WorkRunner 或 OpenAICompatibleAdapter；runtime-binding 使用无技能和空 catalog，不调用推荐方法，且在启动回调主动阻止实际 spawn。新增候选、诊断、重复失败模型门槛和受控模型 HTTP 由 BT_L117–L123 单独验收，不冒称这两张旧有限图证明新旧行为的任意组合。

原 TLA/CFG、性质、公平性、边界、双存储所有标记边、6 类原授权及 4 类组合真实代码负对照保持。完整正向、负对照、未改坏原版恢复复验和独立读回均已通过；证据为 `reports/kej-112-final-authority` 与 `reports/kej-112-final-authority-composition`，精确统计和结果见本轮审查。两入口通过不代替其余七入口；全部九入口通过前保留旧同步提交。

## KEJ-113/114：恢复与资源责任的旧授权切片审查

逐文件旧/候选SHA、原样阻塞、完整运行和读回见 [本轮审查](drift-review-kej-113-114.json)。可用 `15d2714` 与旧授权76项、组合78项指纹全部相同。原名义sync对象在此clone不可读，使用已逐字核对的等价源码作diff基线；候选HEAD不包括工作区产品修改，因此实际冻结指纹才是受测输入。

原Execution、Host、SessionScope、ApprovalComposition的变量、性质、公平性、有限界限和旧能力探针保持。STOP/RECOVER现在可以逻辑冻结交付并把物理责任移交cleanup；Host投影原本就是旧能力曾走过的最远stage和实际接受启动计数，不把当前父work状态或最终报告正文等同授权。所有后续旧approval/attempt/session/permit探针继续核对真实公开入口拒绝。组合图仅在物理claim前恢复，因此不具备已启动未知效果；新cleanup的业务继续路径不会被本图冒称已验证。

历史LOCAL_REQUEST前缀均省略新增trusted resource plan，仍走Store legacy workspace独占路径；新RW资源计划和LOCAL_PREPARED不在本图字母表，独立资源策略模型/Runtime验收承担。Store新增删除屏障在所有旧前缀无REQUEST时不生效；原BEGIN IMMEDIATE/事务回滚与MemoryStore原子提交继续核对，不能从没有删除事件的旧授权图推导KEJ114删除正确性。

新增宿主receipt/no-start/监督/人类gate事件和窗口配置保守纳入源码门禁，但原驱动不执行WorkRunner、模型HTTP、skillsHTTP、WebService或浏览器。默认窗口夹限在有限时钟0/1/900均未触发；synthetic owner/runCli无读取URL、typed资源义务或sourceItems，新增取得前置为空。LocalRuntime十条绑定变体无owner/resource plan且在started callback主动中止spawn，故新增ownership文件与prepared callback不扩大原OS保证。旧六类授权/四类组合真实源码负控、模型失效变体、所有双存储边及原版恢复后复验都必须保持。

旧式unsafe TOOL没有LOCAL子记录时，Store现在从所有房间持久inflight/uncertain快照形成同事务global物理屏障；可信RECONCILE退休前保留，当前inflight父的合法子frame仍属同一责任边界。Engine新unsafe CLAIM在收费前原子检查资源，不把临时busy变成永久回执。旧有限图没有此unsafe资源申请/核对组合；仅历史unsafe输入探针仍检查不能退休/重放。跨房间实际Engine双存储验证由 `tests/legacy-effects-acceptance.ts` / BT_Z106 承担，未扩大这些TLC域。


KEJ-113/114 最终复验：冻结产品 `36916b5c6e974c11f8e51720189c64facef9269e`，本技能两个完整入口均完成真实源码负对照、原版复验和各自独立读回，结果为 updated。最终原始证据分别为 `reports/kej-113-114-four-formal-36916b5-final-2/authority`、`reports/kej-113-114-four-formal-36916b5-final-2/authority-composition`；汇总与最新独立读回位于 `reports/kej-113-114-four-formal-36916b5-final-3`。精确计数、首轮冗余负控失败与维护理由见[逐文件审查](drift-review-kej-113-114.json)。同步元数据不表示额外完整运行；本技能有限域不证明新宿主、网页、人类门或删除行为的全部组合。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## 跨会话资源等待与协调观察的旧切片审查

本轮受审对象为当前 HEAD 加已审查的工作区补丁，精确字节、旧基线等价证明、逐文件分类、原样漂移阻塞及完整重跑状态见 [资源等待审查](drift-review-workspace-wait.json)。`workspaceWait` 只保存合法 `LOCAL_CLAIM` 被真实资源冲突拒绝的观察，成功领取删除；不授予执行票据、宿主审批或解锁权限。Store 的冲突所有者与租约清单均只读，原冲突谓词和领取/提交边界不变；结算后的通知只唤醒重新校验。新 `coordination-view` 元数据和协调员提示不成为可信命令。

原有限图、性质、公平性、界限、逐边公开回放和真实源码负对照保持。排队等待监督的 `resources` 支路、跨会话核对浮层、释放通知与全局协调观察由 BT_Y114–BT_Y120 的新模型/BDD/服务/浏览器承接，不声称被旧有限图证明。完整运行及独立读回成功前不推进同步提交。
