# KEJ-113 核心任务监督与确定性交付

状态：核心真实 XState 已实现并通过本模块模型门槛与 89 条直接 Gherkin 场景。Engine、Runner 和 UI 由对应实现模块接线验证。`work/fallback-policy-model.ts` 是实施前探索，不作为生产验收或全系统证明。

目标是把“千方百计的完成任务”落实为持续寻找可执行路径、有界修复和可信收敛。技术失败不能仅被挪到 `waitingHuman` 便被认为已经兜底。人类确实需要决定时必须明确等待；允许缺失的内容可以被明确或预先授权跳过。逻辑任务结束与物理操作结算分别拥有持久责任。

## EARS 与核查

完整需求草稿来自本会话 `work/issue-ears-draft.json`。以下是本模块的实施映射，不把读取配置、资源锁和 HTTP/UI 接线工作重复实现到模型层。

| 需求 | 本模块可观察响应 | 场景 |
| --- | --- | --- |
| R01、R09、R10、R39 | 八阶段均有实际工作、有界在途/唤醒、明确人类门或真实终态；pending 数量本身不是证明 | BT_Y02、Y18 |
| R03、R04、R05 | 必需门持久保存并只接受匹配身份的人类回复；未知效果不被当作已结算 | BT_Y04、Y05、Y11 |
| R06 | 内容级 skip 保存对象、理由与授权，允许独立内容继续；不代答授权或核对 | BT_Y07、Y11 |
| R07、R08 | 固定自动窗口与有限修复不被进展/恢复续命，提供方永不返回仍可收敛 | BT_Y01、Y03、Y06 |
| R11 | 已领取但未获启动许可的工作保存未启动事实并建立后继 | BT_Y13 |
| R12、R37 | 继续、换目标、门回复和到期冻结有一致身份与事务边界 | BT_Y14、Y19 |
| R13 | STOP 与恢复、确定回执的先后不丢停止意图 | BT_Y15 |
| R17、R18、R38 | 期限判定不依赖 tick 先后，保存结果的再激活/消费/后继原子一致 | BT_Y16、Y17、Y20 |
| R27、R28 | 逻辑终态持久交出物理责任；cleanup 的核对门可以继续 open | BT_Y11、Y12、Y15 |
| R29、R30、R31、R32 | 无新 LLM 请求即可形成 partial/failed，固定目标/正文/文件并拒绝晚结果改写 | BT_Y08、Y09、Y10、Y12 |
| R36、R40 | 旧快照可读、迁移不续期；固定版本与责任记录按提交边界保存；报告模型和接线验证范围 | BT_Y20 及实施记录 |

核查结论：上述条目与用户持续推进、明确等待人类及可缺失内容跳过的要求一致；不承诺所有外部任务必然成功，不授权无上限调用或重放未知写效果。必需目标/权限门和 cleanup 核对门明确区分，消除“全局期限到达”与“等待人类明确回复”的冲突。期限与修复参数由配置策略确定；讨论中的 30 秒、60 秒、2 分钟、10 分钟均非已确认默认值。

需复用的现有能力包括预算、`Intent`、执行子 actor、审批、局部操作的 session/receipt、来源校验、版本 fence、`cancelWork` 及有界检查。新模块只负责纯状态判断与更新，不调用模型、进程、文件或数据库。WebService 和 UI 只执行/投影已经持久保存的决定。

## 主任务的监督转移

类型：真实 XState 转移细图。所有者：`src/task/lifecycle.ts` 与 `src/task/resilience.ts`；沿用现有八个顶层阶段，不新增所有生命周期的扁平乘积。验收：BT_Y01–Y20。

```mermaid
stateDiagram-v2
    state "现有八阶段中的自动处理" as Automatic
    state "明确必需的人类门" as Human
    state "有限修复后的可执行工作" as Repair
    state "固定的逻辑终态" as Terminal
    Automatic --> Repair: SUPERVISE [可安全修复且有预算和时间] / 保存修复次数和后继意图
    Automatic --> Human: WAIT_USER或澄清 [需要人类明确决定] / 保存task门
    Automatic --> Terminal: SUPERVISE [窗口已到期且无必需task门] / 冻结partial或failed并移交cleanup
    Automatic --> Terminal: STOP [当前任务] / 保存stopped并移交cleanup
    Repair --> Automatic: 结果 [身份有效且允许接续] / 结算本次并保存后继
    Repair --> Terminal: SUPERVISE [修复耗尽或全局到期] / 确定性交付
    Human --> Human: SUPERVISE或RECOVER [门未明确回复] / 保留门和原期限
    Human --> Automatic: HUMAN_GATE_DECISION [匹配当前门且原窗口有效] / 记录回复并合法接续
    Human --> Automatic: HUMAN_GATE_DECISION [明确授权新窗口] / 新window并保留历史预算
    Human --> Terminal: HUMAN_GATE_DECISION [原窗口耗尽且无新窗口授权] / 保存回复并如实冻结已有结果
    Terminal --> Terminal: 迟到结果或RECOVER / 仅历史和cleanup结算
```

图中 `Automatic`、`Human`、`Repair`、`Terminal` 是分组说明，不是新增的父状态。实际八阶段处理规则如下。

| 阶段 | 有效工作与等待 | 无路径或到期处理 |
| --- | --- | --- |
| interpreting | 当前解析意图及已领取执行许可 | 有界解析恢复；明确澄清才建 task 门；否则确定性失败/部分交付 |
| running | 当前 owner/tool、可兑现的讨论/交接 | 有界协调或最小后继；窗口到期冻结 |
| waitingAssistance | 当前协助/评审、已保存结果交接 | 统一期限判定，安全结算并续办；不能只释放工作 |
| coordinating | 当前协调意图与有效启动许可 | 有限协调修复；模型不可用不阻挡确定性交付 |
| waitingHuman | 明确 task 门；cleanup 门单独计算 | 必需 task 门不代答；技术故障没有人类决策问题时仍监督修复/降级 |
| checking | 固定候选检查及一次性检查许可 | 沿用检查上界；失败/耗尽可 partial，不申请无限免费检查 |
| stopping | 已保存的停止意图 | 逻辑停止与物理责任移交后得到 stopped；恢复不重开业务 |
| ended | 冻结交付或历史终态 | 不派发业务；独立清理继续，迟到回执不改正文或 activeTask |

监督事件由可信宿主提交。实际 phase 的合法领取分支、当前 epoch/goalVersion、预算/权限、截止时间、成员占用和执行授权必须一致；`pending` 记录不等于可领取。资源租约的真实可用性由 Engine 的全局事务再校验。进程外监督和全局资源扫描属于宿主实现，不在状态机动作中做 I/O。

## 固定处理窗口与有限修复

类型：上下文生命周期；所有者：`src/task/resilience.ts`。验收：BT_Y01、Y03、Y06、Y20。

```mermaid
stateDiagram-v2
    [*] --> Open: 新任务 [策略有效] / 保存openedAt及hardDeadline
    Open --> Repairing: SUPERVISE [无有效路径且可修复] / repairUsed加一并固定repairDeadline
    Repairing --> Open: 有效结果 / 保存结果与唯一后继
    Open --> Open: PROGRESS或RECOVER或普通补消息 / 不延长hardDeadline
    Repairing --> Repairing: PROGRESS或RECOVER / 不重置次数或repairDeadline
    Open --> Exhausted: SUPERVISE [at达到hardDeadline] / 禁止新业务许可
    Repairing --> Exhausted: SUPERVISE [全局到期或有限修复耗尽] / 禁止继续修复
    Exhausted --> WaitingHuman: 存在必需task门 / 保留明确回应义务
    Exhausted --> Frozen: 无必需task门 / 确定性partial或failed
    WaitingHuman --> Frozen: 当前门明确回复 [未授权新窗口] / 保存回复与已有结果
    WaitingHuman --> Open: 当前门明确新窗口授权 / 建立新windowId和期限
```

普通 `CONTINUE` 可以建立新的执行 epoch，但不得自动建立新的处理窗口。`newWindowMs` 必须来自直接用户明确授权并经校验；新窗口保留普通/检查/协助/重试历史用量。新目标和普通补消息仍受本窗口约束，除非用户明确授予新窗口。

旧快照缺少 resilience 字段时仍可读取。对未结束的旧任务，首次需要提交监督状态时从原始创建消息时间推导一次有限窗口，后续恢复复用已保存值；不以恢复时刻为起点。旧历史终稿不因兼容迁移被重新生成或改写。原 budget、stop、session、attempt、目标和已保存结果保持。

## 人类门与内容跳过

类型：上下文生命周期；所有者：`src/task/resilience.ts`。UI 为投影，不能自行判定授权。验收：BT_Y04–Y07。

```mermaid
stateDiagram-v2
    [*] --> GateOpen: 需要明确决定 / 保存gateId和scope及fence
    GateOpen --> GateOpen: 沉默或关闭提示或到期或恢复 / 不视作回答
    GateOpen --> GateOpen: HUMAN_GATE_DECISION [身份或版本不匹配] / 拒绝且保留当前门
    GateOpen --> Answered: HUMAN_GATE_DECISION [当前门明确回复] / 保存responseId
    GateOpen --> Answered: USER_INPUT [当前明确补充答复] / 记录回复并重新解释，不授予工具权限
    GateOpen --> Answered: RETRY_ASSISTANCE [明确重试且决策或恢复门适用] / 记录授权并沿原窗口续办
    GateOpen --> Skipped: HUMAN_GATE_DECISION [明确跳过内容] / 保存skip授权及对象
    GateOpen --> Cancelled: STOP或目标替换 [当前门失效] / 保留历史与取消原因
    Answered --> Answered: 重复相同回复 / 返回已保存决定
    Skipped --> Skipped: 重复相同回复 / 不重复跳过或计费
```

`scope=task` 用于必需目标、权限、澄清或直接用户要求先决定的问题；此类门不因超时自动解除。`scope=cleanup` 用于未决物理效果核对，可在逻辑 partial/failed/stopped 后继续 open。内容跳过不能证明操作未执行、不能批准原本未授权的命令，也不能释放未知写效果的资源。

`WAIT_USER`、明确澄清和协调 `askUser` 创建当前 task 门。纯技术故障不凭空制造一个需要用户回答的问题。匹配门的回复可以沿用原 `HUMAN_DECISION` 输入语义；新的 `HUMAN_GATE_DECISION` 额外携带不可混淆的 gateId 与决定。当前任务的直接普通补充也是对当前问题的明确回复，应记录身份并重新解释；它不代表用户已经授予命令权限。明确重试协助可以回应适用的决策或恢复门；配置门只有在原 workId 精确属于本次 requestId 时才由该次明确重试回应。无关权限、目标澄清或独立 cleanup 门保持。上述回复均不延长原窗口；到期后先冻结已有不完整成果，只有明确新窗口授权能续期。UI 的暂时关闭只改变展示，不发送决定。授权类门的具体执行仍受原审批模型约束，`skip` 只取消/省略相应内容而不批准操作。

## 固定交付与独立物理责任

类型：两个独立上下文生命周期及事务边界；所有者：核心模型保存冻结/移交意图，Engine/宿主领取执行。验收：BT_Y08–Y12、Y15、Y19、Y20。

```mermaid
flowchart LR
    Need[自动业务无法继续] --> Decide{有必需task门?}
    Decide -->|是| Human[保留明确待回复]
    Decide -->|否| Snapshot[固定当前目标及来源和文件选择]
    Snapshot --> Tx[同次提交冻结报告和cleanup责任]
    Tx --> Final[partial / failed / stopped]
    Tx --> Cleanup[独立cleanup持久所有者]
    Cleanup --> Unknown[核对未知效果并保留真实冲突资源]
    Unknown --> Legacy[旧unsafe工具无CLI记录：cleanup-work门及全局未知效果屏障]
    Legacy -->|可信RECONCILE| Settled[仅结算原操作和资源]
    Unknown -->|可信确定回执| Settled[仅结算原操作和资源]
    Unknown -->|需要人| CleanupGate[cleanup门保持open]
    Final -->|迟到结果| History[追加历史且不改冻结交付]
```

确定性宿主报告不是把模型草稿改个标题。它固定当前 task/epoch/goalVersion/windowId、宿主正文、当前文件选择、验证状态与 skip/cleanup 清单。当前模型草稿没有独立证据时作为未核实材料列出；旧目标文件不混入当前清单。没有可用业务材料时是 failed，生成的错误报告本身不算完成原任务的成果。存在影响任务完成判定的未知效果时不能 complete。当前 epoch/goalVersion 留有明确跳过记录时，即使模型独立检查全部通过，宿主仍保存 partial 与原跳过清单；新的模型自述不能抹掉缺失。

冻结和移交必须在同一持久提交中出现；提交失败不能把前端展示成完成。`CleanupCustody.kind` 区分 `local` 与 `legacyWork`；旧快照省略时按 local 兼容读取。没有 CLI 子操作的旧 unsafe 工作以原 workId 作为 operationId，不制造 CLI 回执；创建明确需要提供方可信核对的 cleanup-work 门。普通回复、通用 SETTLE 或窗口到期均不能结算，只有可信 RECONCILE 能结束该责任；宿主为这类未知效果维持全局资源屏障。未知操作仍保留 workId/operationId/sessionId/实际资源身份，不把 lease 超时当作进程退出证据。清理是否已执行不是发布报告的必要条件，但持久责任必须已建立。清理遍历全部任务，包括非 active、ended 和归档房间；其晚结果不得经通用保存路径重新抢占 activeTask。

## 已复现边界的模型裁决

| 边界 | 事件与响应 |
| --- | --- |
| CLAIM 成功后 EXECUTION_START 到期 | `EXECUTION_NOT_STARTED` 保存确认未启动，不发适配器调用；按工作类别结算并保存后继/有界修复/真实终态，替代没有后继的裸 SETTLE |
| waitingHuman 内 CONTINUE 旧后台讨论 | 开新 epoch 前退休旧 pending，取消旧轮但保留原意见；如果合法接续必须同步全部 fence；不得保留 active 旧轮阻止 owner |
| STOP→RECOVER→核对 | stop 是持久目标；恢复先结算/移交 cleanup，不能退到无门且无后继的 waitingHuman；逻辑结果维持 stopped |
| 保存协助结果→EXHAUSTED→获准重试 | 原子清除不再适用的终态、合法建立新执行身份、消费一次已存结果并建唯一后继；原来源与计费不改 |
| 回调与 tick 先后不同 | 按可信接收/执行边界与同一期限谓词裁决；截止及之后不视作按时成功。迟到原文保留历史，业务结果只交接一次 |
| 冻结与新输入同时发生 | 同一事务序列及 task/goal/window/gate 身份裁决；先接受输入则快照必须反映，冻结后输入只能明确新窗口/新任务或被明确拒绝 |
| 冻结后 LOCAL_RESULT/LOCAL_RECONCILE | 原物理记录可结算；禁止把逻辑工作恢复成 pending 或生成 owner；保持 frozen 正文和文件清单 |

R13-RECEIPT（已复现恢复回归的细化）：当可信核对已把当前负责人工作中的未知操作结算，并且协调员在同一目标和原处理窗口内决定继续时，系统应接续该安全待领工作的原检查点和可信回执，不得取消唯一回执持有者而让新负责人丢失回执，亦不得重跑原外部操作。核查：仅适用当前 epoch/goal、原负责人、安全 pending、子操作全部确定结算、检查点无未决操作的续办；新目标、重规划和旧工作到期不获得该复用许可。BT_Y113 直接承接。

```mermaid
stateDiagram-v2
    Unknown --> Repair: SUPERVISE [尚在原窗口] / 保存有限协调修复及cleanup责任
    Repair --> ReceiptReady: LOCAL_RECONCILE [可信回执且当前目标] / 原owner pending并保留原操作回执和时间
    ReceiptReady --> SameOwner: COORDINATE.continue [安全检查点且原期限有效] / 复用原work并仅收紧到修复期限
    SameOwner --> Running: CLAIM [原权限额度和期限允许] / 领取后续模型请求且不重放已结算操作
```

图型：现有 taskMachine 内的恢复处理流程；所有者 `task/operations.ts`。原 operation/session/parentAttempt/finishedAt 保留，下一次模型领取的 attempt 不改写历史执行身份。

直接输入和保存结果恢复的回归细化（BT_G02、BT_H17）：无活跃后台讨论或在途主工作时，用户在原窗口内直接请求评审已有材料，应回应普通材料询问并按原评审边界推进；未知命令授权仍不由评审请求回答。明确重试已 partial 的成员评审时，原固定交付移入不可变历史，当前新 epoch 的真实结果能够保存并恢复汇总，原窗口不被重置。

```mermaid
stateDiagram-v2
    MaterialGate --> ReviewPending: USER_INPUT.review [无在途主工作或后台讨论且非命令授权] / 回应普通材料门并沿原窗口组织
    Partial --> AuthorizedRetry: RETRY_ASSISTANCE [原权限额度版本和期限允许] / 归档原冻结交付并建新请求
    AuthorizedRetry --> Summarizing: RECORD_RESULT及HELP_RESULT [当前身份匹配] / 保存本次结果并保留其他成员旧结果
```

## 已实现接口

正式类型由 `src/task/resilience.ts` 导出，公共 `src/types.ts` 引用。

- `TeamConfig.resilience?: ResiliencePolicy`：固定自动窗口、修复/取消参数和内容缺失策略；root 统一默认策略，不把功能仅限 opt-in。
- `TaskContext.resilience?: TaskResilience`：持久 window、gates、skips、cleanup、frozen 和下次监督时间；optional 用于读兼容。
- `SUPERVISE`：可信宿主触发，基于当前真实阶段作纯判断，不授权模型自行发监督事件。
- `EXECUTION_NOT_STARTED`：可信 Runner 在领取已提交、启动许可被拒后确认未启动；原 intent/attempt/fence 仍校验。
- `HUMAN_GATE_DECISION`：匹配当前门的 `reply/skip/stop/newWindow`；`newWindowMs` 只接受直接明确授权。
- `CONTINUE.newWindowMs?`：明确的新窗口输入；缺省继续不改变原期限。

核心纯接口为 `processingWindow(c)`、`ensureResilience(c)`、`supervisionDecision(c, phase, at)`、`applySupervision(c, event, phase)`、`openHumanGate(c, event, options)`、`decideHumanGate(c, event)`、`freezeIncomplete(c, event, reason)`、`adoptCleanup(c, at)`、`settleCleanup(c, at)`。变更行为仍需先回到场景与细图。

## 实施前门槛与验证记录

场景与细图完成后，root 将 README 和状态细图入口接通并发出 `MODEL_GO`，再修改真实模型。模型驱动必须调用真实 `initialTask/stepTask/persistTask/restoreTask`，覆盖上述八阶段、时钟/顺序/重复/版本矩阵及每步持久化；探索模型不能当作完成此门槛。

模型门槛通过后才接 Engine、WorkRunner、适配器与 UI。需要双存储、真实 HTTP、异步取消/进程重启和真实人类门/导出行为验收。不得以 `waitingHuman`、仅存在 feature 文本、规格覆盖关联或探针退出 0 扩大成完整验收。

本次默认策略由实现选定，可经 `TeamConfig.resilience` 配置：自动窗口 15 分钟、修复窗口 30 秒、最多 2 次修复、取消宽限 5 秒、默认允许内容缺失。它们不是用户给定的时间指标。原窗口从初始用户消息时间建立；旧快照缺少字段时也从原创建记录推导，不从 RECOVER 当前时刻重开。

实际命令与证据：

- `env -u MODEL_API_KEY node --import tsx tests/task-resilience-model-fixture.ts`：真实模型每次公共事件均持久化往返；八阶段、固定期限、必需人类门、到期回复与显式新窗口、物理责任/晚回执、四种旧讨论继续、保存结果重用、18 个业务回执期限边界、6 个冻结后物理恢复、4 个直接人工答复边界和 skip 后全通过仍 partial。摘要保存在 `work/task-resilience-model-gate-current.json`。
- `env -u MODEL_API_KEY TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/54_task_resilience.feature --import 'tests/bdd/*.ts' --format summary`：BT_Y01–Y20、Y111、Y113 展开 89 场景全部通过；`work/task-resilience-bdd-only.log`。步骤数含公共 hook，不表示相同数量的独立性质。
- `env -u MODEL_API_KEY node --import tsx tests/compatibility-model-gate.ts`：原冻结契约 55 条通过。保留旧 golden；仅对已明确改变的宿主 failed 报告进行逐字段检验后的局部投影，并保留故障检出对照，不把新增模型 hash 当作兼容证明。
- `env -u MODEL_API_KEY node --import tsx tests/core-model-gate.ts`：真实核心模型 80 路径通过。
- `env -u MODEL_API_KEY npx vitest run tests/input-intent.test.ts tests/web.test.ts --maxWorkers=1`：实际 Engine/Runner/HTTP 回复与明确重试回归 34 测试通过；`work/core-human-response-vitest.log`。

模型测试不执行提供方或进程；它证明受控事件和时钟下的业务裁决。真实执行、双存储、HTTP、取消/重启、UI 门与文件导出由对应 KEJ-113/114 接线验收负责。版本仍处于本次共享工作区迭代；最终源码冻结、完整回归与形式化入口独立读回由交付记录固定。


## 最终核心增量

固定源码记录在 `work/core-resilience-freeze.json`（初次 05:30:50Z；最后三项真实反例修复后的最终时间以 JSON 为准）。BT_Y11 增补旧 unsafe 工具在 partial 与 stopped 后的可信 RECONCILE 结算；普通 SETTLE、晚失败和普通门回复不能改变其未知责任。清理资源使用 `heldLocalResourceLeases`，包括实际 copy/global/shared key；准备前后分别保存仍持有的资源，旧记录回退 workspace。

必需宿主授权由 [宿主授权门细图](host-approval-gates.md) 与 BT_Y102–Y106 独立验收：HumanGate 精确绑定 work/op/approval，多门并行不会互相取消，恢复与可信未启动核对可以重建同一待批准责任；跳过会产生持久取消意图，让真实 Runner 结束原批准等待。该门不接受普通文本作为命令批准。

不兼容执行配置的 [恢复门](configuration-recovery-gate.md) 由 BT_Y108–Y110 的 9 条直接场景承接；每条同时验证真实模型和 MemoryStore/SQLite 事务/重开。只允许 skip/stop；当前必需门不能吞掉独立 cleanup 的有限检查时间。最后加入 BT_Y113 后，54+62 合计 98 场景；与旧评审/协助重试回归 10/13 一起实际执行 143 场景、8623 步全部通过，日志 `work/core-final-resilience-review-bdd.log`。形式化旧 handoff 的有限范围另行维护，不能以旧证明替代这些新增状态与 IO 验收。


检查提供方的 401 等必需配置失败必须在 WORK_FAILED 选择目标阶段之前识别；不能先进入 ended 再在 reducer 建立一个 outcome=null 的必需门。BT_Y04 的检查权限缺失前缀及五种实际工作角色的模型矩阵承接此交叉；仅当前操作和自动窗口仍有效的配置失败建立新门，已到期且没有既存门的失败按原期限收敛。既存必需门在期限后继续保留。


BT_Y111 追加 CLAIM 与实际 START 之间停止，以及 partial/complete 后未启动事实的裁决：未启动凭证可以退休原许可，不能把停止改成重试或改写既有交付。BT_Y10 追加同窗口 CONTINUE 后第二次 partial：宿主报告与原始未核实正文各自使用版次唯一身份，旧版本保持不可变，按当前 publication ID 读到的是当前正文。


前轮增量验证：54+62 共 97 场景、5886 步通过；5 角色权限失败在自身期限内/到期的 10 条轨迹、三条未启动停止/终态轨迹、同窗口重复 partial 的 ID/正文读回均通过。权限与审批回归 `model-adapter`、`host-approval`、`input-intent` 三文件共 62 测试通过。源码/测试 TypeScript 检查通过；核心 80 与原兼容 55 仍通过。最终 source hash 由上述 freeze JSON 和完整形式化证据分别固定，旧 golden 未改。


澄清门的普通回复沿既有 `recordInput` 路径取消旧 clarification 并保存当前答复，真实 input analysis 必须可领取，不能在 unresolvedInput 尚在时只调用 owner。当前答复需要替换旧语义时，未执行的旧协助会明确记为待重新评估并保留原请求历史；明确 skip 只取消对应澄清内容，已授权的独立待领协助仍按 waitingAssistance 接续。BT_Y05 的三条澄清门路径通过真实 CLAIM/结果交接验证，原期限保持。


最后澄清断点的定向验收：四条 reply/skip/待授权协助交错均先在真实 taskMachine 验证，再经实际 TeamEngine、WorkRunner、兼容模型协议与 MemoryStore/SQLite 执行；SQLite 在回复后重开。可观察序列为新的 interpretation 或已授权 assistance，再到真实 owner 模型请求；已保存协助结果先由 Runner flush，再发下一次请求。repairUsed=0，原窗口逐字段不变，无孤立待领 assistance。提供方 HTTP 由夹具返回受控协议，不声称浏览器或真实供应商运行。该轮 54+62 97 场景全通过，core80/compat55 保持。
