# 细化状态图

本文件与 README 的「状态模型」共同描述当前功能。顶层任务状态由 `src/task.machine.ts` 管理；下图分别标明上下文状态、操作状态和界面状态，不能将后两者误认为新增的 XState 顶层状态。

## 工作期间的后台讨论

对应 BT_T01–BT_T17。沿用任务顶层状态，在 src/task.machine.ts 增加持久化 discussion 上下文和带 discussionId 的操作；主工作与讨论分别推进，讨论不能变更负责人或主目标。需求依据和替代方案见 [评估](background-discussion.md)。

```mermaid
stateDiagram-v2
    [*] --> planning: 直接用户邀请且有空闲成员和预留预算 / 保存轮次和协调员意图
    [*] --> delivered: 无空闲成员或预算不足 / 明确说明原因，无模型请求
    planning --> collecting: DISCUSSION_PLAN校验通过 / 保存受授权成员意图
    collecting --> collecting: DISCUSSION_RESULT / 原子保存意见和成员状态
    collecting --> summarizing: 全部成员结算 / 保存协调员汇总意图
    summarizing --> ready: DISCUSSION_RESULT / 保存汇总和完整来源
    planning --> ready: 安排失败或超时 / 保存失败交接
    summarizing --> ready: 汇总失败或超时 / 保存原意见清单与失败说明
    ready --> ready: 主请求仍在途或等待用户 / 不重开负责人
    ready --> delivered: 主工作安全边界 / 原负责人收到草稿、汇总及全部意见
    planning --> planning: 重复直接邀请 / 说明复用当前轮次
    collecting --> collecting: 重复直接邀请 / 不重复派发
    planning --> cancelled: STOP或目标版本改变
    collecting --> cancelled: STOP或目标版本改变
    summarizing --> cancelled: STOP或目标版本改变
    ready --> cancelled: STOP或目标版本改变
```

每次外部请求都先保存意图，再经 CLAIM 检查轮次、epoch、goalVersion、期限、成员互斥和预算，之后 CONSUME 才调用适配器。成员复用 assistance 协议但不进入主流程单一 assists 等待关系；协调员安排复用 facilitator 协议，汇总使用 discussionSummary 的只读 answer 协议。结果携带已领取 workId 与 discussionId，保存原文、报告、状态和下一步意图同事务提交，重复或旧结果拒绝。讨论无权重新邀请、修改目标、发起嵌套协助或提前发布最终交付。

主流程 running 的 DELIVER 在讨论尚未交接时只保存候选草稿，不进入 checking；其他需要负责人接续的结果也等待讨论。ready 且无主请求、无未结算主协助和待解析输入时交接一次，恢复原 running 工作，最后沿用 checking。等待用户不会被后台结果擅自解除。讨论失败和跳过原因进入交接，最终交付如实标为部分完成。

主请求在讨论期间报告 BLOCKED 或达到重复失败阈值时，保持 running 并保存阻塞原因和延后协调标记，等待正在收集的新依据；不另发可能提前结束任务的监督请求。讨论交接清除延后协调标记，将原阻塞与意见一起交给负责人。

取消、结束与硬约束变化覆盖全部操作，普通主工作切换只取消主操作。重启重新校验成员、权限、版本和模型绑定，仅恢复未完成安全意图；已提交意见不重放。网页执行器按具体工作启动有界异步请求，不再按整个群阻塞；调度资格始终来自状态机和事务领取，宿主不自行选择成员或修改讨论状态。

宿主中的在途工作以群 ID 与工作 ID 共同标识，避免不同群的相同输入编号互相阻塞。没有成功领取或消费结果时让出执行，等待已有请求结算、下一条命令或定时检查，不递归空转领取。宿主或存储故障暂停该群本进程中的后续派发，沿用 waitingHuman 与存储故障保护；这些是执行器互斥与生命周期规则，不新增业务 XState 状态。

讨论结果的拒绝边界对应 BT_V14：缺少 fence、错误讨论轮次、过期版本或将讨论结果关联到主工作时，只保存拒绝记录，不能结算当前有效在途工作。只有工作 ID、讨论轮次和工作自身版本边界完整匹配的真实完成事件，才可结算该工作；当前轮次内的协议错误按原失败分支结算，旧轮次的有效迟到完成只结算自身并留存历史。

```mermaid
stateDiagram-v2
    inflight --> inflight: 结果缺少版本边界或身份不匹配 / 拒绝并保留有效工作
    inflight --> consumed: 有效身份与结果 / 保存意见及推进讨论
    inflight --> failed: 当前工作身份有效但协议错误 / 保存失败并结算
    inflight --> retired: 旧工作身份有效且结果迟到 / 只结算自身，不能推进新轮次
```

## 输入意图解析

对应 BT_I01–BT_I21。保留原执行内核，以 [Zod 运行时契约](https://zod.dev/basics)校验规则与模型结果；按 [XState 持久化](https://stately.ai/docs/persistence)的快照边界保存解析工作。结构化生成仍需宿主校验，参考 [AI SDK 结构化数据说明](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)，不引入该 SDK。项目继续固定 XState 5，不升级执行框架。

```mermaid
stateDiagram-v2
    [*] --> received: 直接用户输入 / 原文和回执同事务保存
    received --> resolved: 明确命令或简单请求 / 规则规范化
    received --> pending: 复杂要求或指代 / 保存解析记录
    pending --> interpreting: 无在途工作及未消费协助 / 保存解析操作
    interpreting --> inflight: CLAIM及CONSUME通过 / 复用模型传输
    inflight --> resolved: Schema和引用校验通过 / 原子保存结果
    inflight --> clarification: 信息不足或置信度低 / 保存具体问题
    clarification --> pending: 用户补充或明确继续
    inflight --> pending: 可重试故障 / 共享有限重试
    inflight --> failed: 格式修正耗尽或永久故障 / 等待用户
    inflight --> failed: 自定义执行器绕过协议校验 / 状态机拒绝并保存原因
    failed --> pending: 明确继续 / 重查预算配置与版本
    resolved --> executing: 无其他待解析输入 / 原状态机规划与执行
    resolved --> pending: 解析期间收到新输入 / 先完成后续解析
    pending --> cancelled: STOP或目标版本更新
    inflight --> cancelled: STOP或版本过期 / 取消并归档迟到结果
```

新增 interpreting 顶层状态、interpretation 操作种类、INTERPRETATION_RESULT 事件和可选 inputAnalyses 上下文。旧快照缺少该字段视为空，不强制迁移。每条记录保留输入 ID、原文、可信动作、来源、状态、epoch、goalVersion、解析结果与工作 ID；工作沿用 pending/inflight/done/cancelled、deadline、模型绑定、requestCount 和既有回执。所有模型 I/O 均在已提交并领取的操作上发起，解析禁用技能与网页工具，不获得新的调度权限。

规则只匹配直接输入的完整停止、继续和重试命令，点名只接受配置中的成员。引用、代码、否定句、历史和 Bot 内容不触发控制命令。模型仅解释 request/supplement/decision/review 中已由可信入口确定的动作，不能返回 stop/continue/retry、修改负责人或扩大直接用户指定的评审范围。Zod 契约严格拒绝额外字段；动作须与解析输入一致；每个引用须同时匹配实际提供的类型、ID 和 taskId。低置信度必须带澄清问题。原始 Goal、显式约束及完整消息始终独立保留，不能被模型摘要替换。

复杂补充先持久化为待应用输入，到没有在途工作且协助结果已消费的安全边界再解析；解析优先于后继负责人和旧交付检查，未解析或需澄清时不得发布完成结果。所有待解析输入处理完后，按原 review 队列或负责人流程继续，全部角色收到同一组已校验意图及原始输入。澄清和最终失败进入 waitingHuman，不执行猜测结果；用户补充或明确继续后重试未完成解析。

首次解析领取扣 ordinary，后续请求及格式修正继续通过 CONSUME 与 REGENERATE_MODEL_OUTPUT，重试共享 usage.retries；额度不足不得请求。STOP 保存取消意图并经原 AbortSignal 传递；停止、过期工作、epoch/goalVersion 不一致、已结算或重复结果都不能调度后继工作。目标改变取消旧解析；重启只恢复安全未完成工作，并重新检查模型绑定、配置和预算，已提交结果不重放。事务失败同时回滚输入、解析、后继操作和回执，并阻止本引擎继续请求。网页投影 interpreting 和 inputAnalyses，过程记录显示真实解析请求与结果，不展示隐藏推理。

当前产物与黑板正文同引用目录一起提供给解析模型，避免只有 ID 而缺少指代依据。自定义执行器即使绕过适配器仍须经状态机复核，非法当前结果进入 waitingHuman；未关联已领取解析工作的伪造事件不能改变阶段，迟到结果只结算自己的旧工作。澄清或失败后 CONTINUE 先重建解析操作，不直接安排负责人。解析期间追加的输入按顺序解释，全部完成后再规划；旧结果不得抢先发布。明确控制消息也随 STOP、CONTINUE 或 RETRY_ASSISTANCE 保存原文和回执。

网页等待用户时自动附加的 decision 分类不能盖过完整的直接停止或继续命令；显式 new、retry 等专用入口仍保留原语义。即使补充走规则路径，CHECK_RESULT 也不能在存在未应用输入时发布完成，必须先回到原安全边界应用补充。

## 模型输出格式修正

对应 BT_M10–BT_M20。现有适配器将 JSON/角色协议错误抛为永久失败，无法自动重新生成。采用[校验反馈回路](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)：保留原任务和已取得的工具资料，指出字段校验问题后请求新结果；不把格式错误转为用户信息不足，也不放宽验证。兼容第三方服务，继续使用原响应格式配置，不强制供应商支持新的严格 schema 参数。

```mermaid
stateDiagram-v2
    [*] --> inflight: 已持久化意图通过领取校验
    inflight --> validating: 收到完整文本返回
    validating --> applied: JSON与当前角色协议均有效 / 回传原有结果事件
    validating --> repairSaved: REGENERATE_MODEL_OUTPUT / 当前工作、版本、截止、请求预算与重试额度守卫通过 / 保存安全问题代码与计数
    repairSaved --> inflight: CONSUME另扣请求额度 / 带原上下文和修正要求调用同一模型
    validating --> waitingHuman: 修正额度不足或不可恢复故障 / 原有失败处理
    repairSaved --> stopped: 停止、版本改变、超时或存储失败 / 不发出新请求
    repairSaved --> inflight: 重启恢复 / 保留已用次数与问题代码，再次领取校验
```

保留 running、waitingAssistance、coordinating、checking 等既有业务顶层状态；新增 REGENERATE_MODEL_OUTPUT 事件及操作上下文 outputRepair。状态机只保存修正次数与受控校验代码，使用现有 usage.retries/config.limits.retries，不新增独立预算。后续模型请求仍通过 CONSUME，扣所属 ordinary 或 checks 额度；修正不重置本次工作截止时间，也不重新执行已完成的工具。停止、旧轮次/目标版本、非在途或非模型工作、额度耗尽时拒绝。重复事件回执不重复计数；重启保留修正信息，不绕过恢复和模型绑定校验。

错误 type、passed 类型、gaps 缺失/null/非字符串数组、无效 JSON、其他角色协议及已获准工具的参数格式错误触发重新生成；不自动将字符串转换为布尔、不补空数组、不发布无效返回中的产物或动作。反馈仅包含宿主生成的问题代码和允许的协议，不回显原始错误返回或凭据。合法 passed:false 按普通检查不通过推进。工具权限拒绝、HTTP 鉴权/网络故障、响应截断和供应商响应损坏沿用原处理，不走格式回路。网页执行器透传授权钩子并记录格式修正；群消息不因一次格式修正而发布长篇报错。存储事务失败后禁止继续请求。

## 详情复制与导出

对应 BT_A12–BT_A21。现有详情只提供产物下载，消息全文、依据和折叠过程缺少便捷的带走入口。采用常规的浏览器[剪贴板写入](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)与[Blob文件下载](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a#download)，不引入导出服务或格式选择菜单。Clipboard API可能因非安全上下文或浏览器权限失败，必须等待写入确认；[对象URL](https://developer.mozilla.org/en-US/docs/Web/API/URL/revokeObjectURL_static)使用后回收。

```mermaid
stateDiagram-v2
    [*] --> unavailable: 没有内容或指定目标已不存在
    [*] --> ready: 解析当前详情范围并生成完整文档
    unavailable --> ready: 有效内容加载
    ready --> copying: 用户点击复制 / 捕获本次文档，拒绝重复点击
    copying --> copied: 剪贴板确认且文档身份与内容仍相同
    copying --> copyFailed: API不可用或拒绝 / 提示失败，保留导出入口
    copying --> ready: 切换目标、页签或内容变化 / 隔离迟到回执
    ready --> ready: 用户导出 / 创建UTF8文件并发起下载，回收临时资源
    ready --> exportFailed: 创建下载失败 / 清理并允许重试
    exportFailed --> ready: 重试导出成功发起
    copied --> ready: 当前详情变化
    copied --> ready: 提示到期
    copyFailed --> copying: 重试复制
    copying --> disposed: 关闭或卸载 / 丢弃回执反馈
```

复制与导出共用一个纯文档选择器，读取当前已加载快照，禁止从 DOM.innerText 截取可见摘要而遗漏折叠记录。消息详情包含原始全文、该消息关联的真实报告、该任务的依据与来源、执行事件完整内容及调度记录；不混入其他任务或未关联报告正文。任务详情带任务资料和同任务记录；成员执行过程与产物页签分别按成员筛选。缺失指定任务、消息或产物时返回不可用，禁止回退新任务；只有成员资料但暂无工作记录时仍可导出当前资料。普通详情使用 Markdown，产物预览复制原文并保留原文件格式，顶栏复用导出入口，不重复放置同一文件下载按钮；产物列表仍可单独下载各文件。建议文件名清理路径及控制字符，保留合法点文件名；浏览器仍可能调整实际下载名称。正文不截断、不改写。

本次浏览器 I/O 仅由用户点击触发，不发送模型、工具或任务命令，不生成新的黑板产物，也不修改额度。读取快照期间不会执行新的业务，因此沿用现有任务 XState，无需修改 src/task.machine.ts。文档身份、复制等待、反馈和资源清理均为页面状态。导出提示只确认已发起下载，不声称文件已保存到磁盘。反馈短暂显示且至少14px，窄面板保留原关闭入口与可访问按钮。

## 页面侧栏与字号

对应 BT_P01–BT_P11。需求评估：现有左右面板使用固定宽度，桌面没有左侧收起入口；大量辅助文字低于14px。采用常规可调整分隔条，提供键盘和可访问尺寸；参考 [WAI Window Splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)。保留现有 Grid 与窄屏抽屉，只增加本地布局状态，无需额外布局依赖或业务 XState 状态。

```mermaid
stateDiagram-v2
    [*] --> idle: 加载有效偏好 / 存储异常回退默认
    idle --> dragging: 按下已展开面板分隔条 / 捕获指针并保存起始偏好
    dragging --> dragging: 指针移动 / 在可用宽度内临时调整
    dragging --> idle: 松开 / 提交偏好并释放捕获与样式
    dragging --> idle: Escape、取消、失焦、关闭或断点变化 / 回退临时调整并清理
    dragging --> disposed: 卸载 / 释放捕获与全局样式
    idle --> idle: 方向键或Home、End / 限幅并保存偏好
    idle --> collapsed: 收起导航 / 释放桌面列并保留展开入口
    collapsed --> idle: 展开导航 / 恢复保存宽度
    idle --> idle: 关闭再开详情 / 恢复保存宽度
    idle --> idle: 窗口变化 / 仅计算有效宽度，不覆盖偏好
```

布局模型区分保存偏好与当前有效宽度：左侧默认252px、范围220–420px；右侧默认352px、范围300–680px。大于990px时左右占列且聊天区至少360px，调整时不得挤掉另一侧最小宽度；721–990px时右侧覆盖，720px及以下左右均沿用覆盖层，最大宽度保留32px外部空间，必要时降低面板最小值以适应窗口。尺寸与模式均依据工作区实测可用宽度，模式通过页面类名传给样式；即使滚动条等导致视窗与工作区宽度不同，也不得混用两个断点依据。拖拽和键盘操作共用边界计算；右面板的左方向键增宽，右方向键缩窄。分隔条带可聚焦的 separator 语义、垂直方向、尺寸和目标面板引用。

桌面收起偏好与移动导航打开状态独立；移动端选群或遮罩点击关闭导航，不修改桌面偏好。详情打开状态沿用原页面状态，不因记住宽度而自动打开历史报告。拖拽、键盘和收起不会发出模型、工具、任务或取消请求，也不修改群聊、草稿、任务状态和预算，因此沿用所有已有业务 XState 状态，无需修改 src/task.machine.ts。localStorage 拒绝访问或数据无效时不阻止交互。

字号直接在样式规则中保证最小14px，包括媒体查询、代码、表格、时间、状态、提示和下标脚注；更大的标题保留。随字号调整卡片最小高度、必要换行和长内容溢出，不以缩放容器或缩小文字解决拥挤。自动化直接绑定布局模型、DOM交互与样式规则；真实浏览器布局验证与模拟DOM结果分别报告。

## 简短结果与产物发布

对应 BT_A01–BT_A11。复用 running、waitingAssistance、checking、ended 和既有操作状态；摘要、报告和引用是同一结果的上下文，不增加顶层状态。新增行为先经以下结果事件事务，再由网页展示。

```mermaid
stateDiagram-v2
    [*] --> inflight: 已保存意图经 CLAIM 领取
    inflight --> committed: DELIVER 或 RECORD_RESULT / 校验身份、版本和报告草稿 / 原子保存全文、摘要及产物
    inflight --> rejected: 停止、旧版本、无效草稿或重复结果 / 不创建产物
    inflight --> inflight: 事务提交失败 / 回滚且停止新增派发
    committed --> checking: 负责人候选和报告已保存 / 检查获准后执行
    committed --> handoff: 核查报告已保存 / HELP_RESULT 原子消费并接续负责人
    committed --> handoff: 重启 / 补消费已保存核查结果
    checking --> published: 检查通过或按原规则部分结束 / 消息关联已保存产物
    handoff --> published: 群中显示核查结论和报告入口
    rejected --> [*]
```

检查与负责人接续使用完整候选、核查文本和产物，不使用展示摘要替代。报告按事件和工作确定身份，重复回执不重复保存。旧协议长结果可在同一结果事务中生成报告；旧快照新增字段均可省略。未生成报告的短答不创建空文档。首次与后续外部请求沿用现有预算，生成本地产物不调用额外模型。

```mermaid
stateDiagram-v2
    [*] --> feed: 展示短结论与真实产物入口
    feed --> messageDetails: 点击详情 / 固定 taskId 和 messageId
    feed --> artifactPreview: 点击报告 / 固定 taskId 和 artifactId
    messageDetails --> artifactPreview: 选择关联报告
    artifactPreview --> messageDetails: 返回结果详情
    messageDetails --> feed: 关闭或切群
    artifactPreview --> feed: 关闭或切群
```

网页仅读取对应任务的全文、来源和可观察执行记录。报告预览复用安全 Markdown 渲染，下载使用相同持久内容。历史消息不能回退到当前任务的报告；不存在的引用显示不可用，不创建产物或调度。旧长消息只缩短主视图显示，其原文仍能在详情查看。

## 协助重试与结果交接

对应 BT_H10–BT_H20、BT_U16；复用 running、waitingAssistance、waitingHuman、ended 顶层状态。以下为协助上下文及提交边界。原负责人保持任务所有权；网页仅提交命令，不直接调用成员。

```mermaid
stateDiagram-v2
    [*] --> pending: HELP / 保存问题、预期、权限和负责人
    pending --> running: CLAIM / 预算及版本有效
    running --> answered: RECORD_RESULT / 保存结果并释放执行操作
    answered --> settled: HELP_RESULT / 原子消费、合并补充、安排负责人
    running --> interrupted: 失败、超时或停止 / 保留原尝试
    interrupted --> pending: 明确 RETRY_ASSISTANCE / 新 ID 关联 retryOf
    answered --> settled: 明确重试 / 复用已保存有效结果
    interrupted --> interrupted: 目标过期、额度不足、在途或未知结果 / 拒绝
    answered --> archived: STOP 或版本过期 / 禁止推进
    pending --> pending: 安全恢复 / 接续已保存意图
    answered --> settled: 重启 / 补消费并只安排一次负责人
```

- 未结算的协助及有效待消费结果阻止用户补充抢先触发 BOUNDARY。读取和消费结果使用同一事务；普通结果消费、输入应用、负责人意图和“结果已交给负责人”的提示一起持久化。临时状态不允许消费时保留结果，不写永久拒绝回执；只有已停止、版本过期、已结算或重复结果可归档。
- 手动重试创建新协助 ID 和独立执行意图，记录 `retryOf`、原负责人和所需权限；保留失败记录，消耗重试及求助额度，并为负责人保留一次普通请求。核查额外请求、自动重试和恢复领取都不能使用该保留额度，触限按失败结算并交回负责人。停止或结束的任务在明确重试时才开启新 epoch；目标版本变化拒绝沿用旧问题。未结算的外部请求必须先结算，不能并发重放。
- 成员评审重试保留同轮其他成员结果，只重试选中成员；结果返回后接续未完成队列或负责人汇总，并重新计算失败缺口。属于旧评审轮次的协助不能用于恢复当前评审。
- WorkRunner 只执行通过 CLAIM 的持久化意图；重试与结果交接均由 XState 产生。失败和超时仍回到原负责人；停止、旧请求迟到及重复提交不能产生额外推进。

```mermaid
stateDiagram-v2
    [*] --> available: 快照提供可重试协助
    available --> submitting: 点击原协助重试 / taskId + requestId
    submitting --> available: 请求拒绝 / 显示具体原因
    submitting --> waiting: 保存成功 / 等待成员结果
    waiting --> resumed: 结果已交接 / 展示负责人续办提示
    available --> disabled: 在途、断线、过期或预算不足
    disabled --> available: 快照更新且守卫允许
```

“B 重试”只解析直接用户的完整重试指令；引用、历史、模型输出和任意包含该词的句子均不获得重试权限。路由保留原协助的成员身份，成员撤销后仍识别命令并由权限守卫拒绝。只有一个候选时提交同一命令；多个候选或没有候选时给出明确原因，用户可使用关联原协助的入口。事务保存失败回滚消息、意图和回执，禁止宣称重试成功或发起外部操作。

## 成员评审

对应 `TaskContext.review.status`。目标成员只由直接用户请求确定，促进者不能替换名单，也不能用 continue、assist、replan 或 finish 跳过待组织的评审。

```mermaid
stateDiagram-v2
    [*] --> pending: 直接用户请求评审 / 固定成员与轮次版本
    pending --> pending: 关键材料缺失或判断无效 / 等待用户后重组
    pending --> reviewing: COORDINATE review / 可为成员和汇总分配额度
    pending --> summarizing: COORDINATE review / 无可派发成员
    reviewing --> reviewing: 成员结果保存并消费 / 派发下一位
    reviewing --> reviewing: 安全重启 / 接续未消费结果和剩余队列
    reviewing --> summarizing: 全部收齐 / 协助额度不足 / 仅剩汇总额度
    reviewing --> summarizing: 后续请求或恢复领取触及汇总保留额度 / 记录失败
    summarizing --> complete: 负责人汇总并经检查 / 记录实际完成结果
    summarizing --> summarizing: 检查有缺口且可修正 / 促进者协调修正
    reviewing --> pending: 用户补充在安全边界生效 / 取消旧协助并重组
    summarizing --> pending: 用户补充在安全边界生效 / 重组
    pending --> cancelled: STOP
    reviewing --> cancelled: STOP
    summarizing --> cancelled: STOP
    cancelled --> pending: 明确 CONTINUE / 新 epoch
    complete --> pending: 未完成项经明确 CONTINUE 重试 / 新 epoch
```

- `complete` 表示评审轮次结算，任务是否成功仍以 `outcome` 为准；成员失败、超时或队列未收齐会标记缺口，最终为 partial。
- 评审组织与收集阶段必须保留一次普通请求供负责人汇总。首次领取、额外模型请求、技能搜索、重试与恢复重新领取都检查这条限制；首次模型请求已由领取预占，不重复扣款。触及保留额度的成员操作按失败结算，推进汇总，不能直接耗尽该额度或继续重试。
- 完成检查使用独立 checks 额度；若用户配置的总额度连组织和汇总都不足，或停止、故障、检查额度不足，则可直接结束或等待用户，不能承诺完成汇总。
- 结果必须先 RECORD_RESULT 持久化，再以 HELP_RESULT 消费；结果 ID 防止重复消费，epoch/goalVersion 隔离迟到结果。用户补充在 HELP_RESULT 消费边界应用，已保存的成员意见保留为重新组织的上下文。配置撤销成员或权限时暂停恢复。初次评审直接进入组织阶段，避免负责人先回答一次才拉人。

## 外部执行操作

对应 `Intent.status`。网页只提交用户命令；状态机产生操作意图，事务保存后由 `WorkRunner` 领取，只有领取成功的操作才可调用模型或工具。

```mermaid
stateDiagram-v2
    [*] --> pending: 状态机生成意图并持久化
    pending --> inflight: CLAIM / 状态与成员权限有效 / 预算允许
    pending --> done: 评审汇总额度保留导致领取被拒 / WORK_FAILED 结算
    pending --> cancelled: STOP / 目标变更 / 操作被替代
    inflight --> inflight: CONSUME / 初次已预占或额外请求获准
    inflight --> done: 合法模型输出转成状态机事件
    inflight --> done: 非重试故障 / 额外请求触及保留额度
    inflight --> done: 迟到或过期输出 / 只结算自身并留历史
    inflight --> pending: 瞬态故障且重试额度与执行额度允许
    inflight --> pending: RECOVER / 可安全重新请求
    inflight --> uncertain: 外部操作结果不确定
    uncertain --> done: RECONCILE / 等待明确继续
    inflight --> done: STOP 生成取消意图 / 执行器确认结算
```

每个额外模型请求、技能搜索和网页工具调用都先经 CONSUME 检查。被拒后禁止发起 I/O。模型 HTTP 408、429、5xx 或网络故障可有限重试；协议错误与不可恢复故障按任务图转移。技能搜索不会安装技能。停止首先持久化并派发取消意图，AbortSignal 传入模型和工具；取消请求发出不等于原操作已结算。外部结果不确定时必须核对，不能直接重放。

OpenCode 会话标识只影响传输：网页使用群 ID，CLI 使用持久任务 ID，适配器哈希后添加请求头，不创建另一条调度路径。HTTP 错误只保留已校验的短代码；MissingSessionID 即使附带参数标识，也应提供缺少会话头的提示，仍沿用 WORK_FAILED 转移。瞬态故障到达重试上限时，等待原因应同时说明原错误和额度限制。执行日志是观察记录，不驱动业务转移。

## 模型消息风格

对应 BT_M07–BT_M09。以下是 `OpenAICompatibleAdapter` 内部的请求阶段，不是新增的 XState 状态。owner、assistance、facilitator 和 check 均沿用状态机已持久化的意图；只有 WorkRunner 领取成功后才构造并发送请求。

```mermaid
stateDiagram-v2
    [*] --> requesting: CLAIM 成功 / 角色协议与统一风格进入系统提示词
    requesting --> tool: 合法工具动作且 CONSUME 获准 / 执行工具
    tool --> requesting: 后续模型请求获准 / 保留系统提示词并附工具资料
    requesting --> validated: 合法 JSON 动作 / 保留可读文本原样
    validated --> settled: WorkRunner 回传事件 / 原版本与状态守卫校验
    requesting --> settled: 协议错误、请求失败或停止 / 沿用故障与取消结算
    tool --> settled: 工具失败、额度耗尽或停止 / 沿用故障与取消结算
```

风格只约束可读文本：默认用简洁自然段落，短回复无需标题，减少装饰性排版；用户要求或内容确有需要时保留列表、表格、代码与来源链接。JSON 外层结构、动作枚举、工具参数和角色权限由现有协议决定，不受风格偏好覆盖。工具资料不能改写系统风格或取得调度权限；完成检查仍不开工具。

不增加状态、事件或调度入口。首次请求与后续模型/工具请求沿用原预算；失败、停止、迟到结果、目标版本隔离和恢复均使用「外部执行操作」的守卫与转移，安全重放时重新构造同一风格提示。可执行场景使用注入的模型传输核对各角色请求、工具后续请求及格式保留，不把预设响应当成真实模型的风格质量验收。

## 默认网页工具

对应 `BT_W01`–`BT_W14`，以下是已领取意图内部的一次请求循环，不是新增的任务顶层状态。状态机在 owner / assistance / facilitator 的 payload 中持久化 `capabilities.webSearch`、`capabilities.webFetch`。最终 check 不开放联网，保留原有 checks 预算语义。

```mermaid
stateDiagram-v2
    [*] --> claimed: CLAIM 成功且首次请求已预占
    claimed --> requested: 模型返回 web_search 或 web_fetch
    requested --> rejected: 参数无效 / 关闭 / 过期 / 版本不匹配 / 已停止
    requested --> rejected: 普通额度耗尽 / 评审汇总保留额度
    requested --> configuring: CONSUME capability 成功并持久化
    configuring --> fetching: 重载环境文件 / 固定本次配置
    configuring --> failed: 文件读取失败 / 不发出 HTTP 请求
    fetching --> evidence: SDK 返回来源与有界内容
    evidence --> claimed: 下次模型请求经 CONSUME / 资料不获得调度权限
    fetching --> failed: HTTP / 超时 / 转换 / 凭据错误
    failed --> [*]: WORK_FAILED / 有限重试或既有失败转移
    rejected --> [*]: 无外部 I/O / 既有失败结算
    fetching --> cancelled: STOP 的取消意图 / AbortSignal
    cancelled --> [*]: SETTLE / 迟到结果只结算旧工作
    fetching --> recoverable: 进程退出且工作可安全重放
    recoverable --> claimed: RECOVER 后重新 CLAIM / 再次计入预算
```

- 两种工具每次各消耗一次普通额度；分页续读是新的抓取。后续模型请求另外计费，评审汇总的保留额度同样适用。CONSUME 校验 inflight、epoch/goalVersion、期限、工具开关与工作类型，不能由适配器绕过。
- 使用 `agents/websearch` 的 HTTP source 和 `agents/webfetch` 的抓取、分页与渲染函数。Node 宿主用 Workers AI REST API 适配 Markdown 转换；密钥仅在运行时从环境读取，不写入任务配置、模型上下文或执行日志。
- BT_W11–BT_W14 沿用现有意图、CONSUME、WORK_FAILED、STOP 和 RECOVER，不修改 XState。每次工具调用前重载 `.env`，更新或删除仅由文件管理的值，保留进程环境和显式注入的优先级；文件不存在时清除旧文件值，其他读取错误使本次调用失败。单次调用的搜索选项、账号、令牌与错误脱敏共用开始时的快照，HTML/PDF 转换不得中途换用另一账号；下一次请求及恢复后的请求重新读取。
- 抓取沿用 SDK 的公共 URL、重定向、响应字节数与超时限制；正文使用 SDK 的不可信内容标记。搜索和网页内容不能改变评审名单或授予新调度权限。
- 只有工作被领取后才能发出工具请求；失败保留安全代码，不伪装为零条结果。工具暂时失败可按原 WORK_FAILED 规则重试整个只读工作，受原预算限制。未配置账号不会阻止普通聊天启动。
- 恢复时更新当前开关，并刷新 pending 和重新入队的 inflight 意图能力。途中尚未提交的模型循环可能重新搜索或抓取，重新调用可能收费；不承诺缓存或恰好一次外部请求。已结算意图不重放。
- 网页只观察工具开始、来源结果、失败与完成，不另建调度路径。

## 群历史与消息路由

以下是 `TeamEngine.submit` 的单次事务处理路径，节点是处理阶段，不另行持久化为任务状态。

```mermaid
stateDiagram-v2
    [*] --> receipt: 用户命令
    receipt --> returned: 相同 ID 与内容 / 返回已保存回执
    receipt --> rejected: 相同 ID 但内容不同
    receipt --> route: 新请求
    route --> created: 群空闲 / 创建新任务并附同群历史
    route --> supplemented: 活动任务 / USER_INPUT 或 HUMAN_DECISION
    route --> continued: 明确 CONTINUE / 现有任务与轮次守卫通过
    route --> rejected: 群忙却要求新建 / 已结束任务缺少明确继续
    created --> committed: 初始化任务状态与操作意图
    supplemented --> committed: 补齐群历史 / 等安全边界应用输入
    continued --> committed: 新 epoch / 按任务图接续
    committed --> returned: 原子保存任务与回执
    returned --> [*]
    rejected --> [*]
```

历史仅来自同群其他任务，保留来源 taskId，限制消息、产物、黑板和目标摘要数量及总文本量。历史只作为模型上下文，不计为本轮交付产物，不复活已结束任务，不从历史中的指令发起调度。成员评审识别仅处理直接用户文本及编辑器实际选中的点名；代码、引用和 Bot 消息不触发全员评审。

HANDOFF 沿用 running 的状态内转移：先确认边界和新成员权限，再记录原负责人、新负责人、目标版本及产物/黑板引用，取消旧待执行意图并准备新负责人输入。群提示与持久记录必须能还原交接双方，不能只保存接任者。

## 网页交互

对应 React 状态和服务器快照的投影，不直接修改业务状态或调用模型。连接、发送与详情面板分别变化。

```mermaid
stateDiagram-v2
    state "网页" as Web {
      state "连接" as Connection {
        [*] --> loading: 展示本地品牌资源
        loading --> connected: 群列表或快照读取成功
        loading --> disconnected: 读取失败
        connected --> disconnected: 快照轮询失败
        disconnected --> connected: 自动重试成功
      }
      --
      state "消息" as Composer {
        [*] --> drafting
        drafting --> sending: 已连接且提交 / 必要时先创建群
        sending --> drafting: 成功清空草稿 / 失败保留草稿与请求 ID
        drafting --> drafting: 切群 / 使用各群独立草稿和实际点名
      }
      --
      state "详情" as Details {
        [*] --> closed
        closed --> agentDetails: 点击成员、消息作者或头像、Markdown 中成员点名
        closed --> taskDetails: 点击任务状态
        agentDetails --> agentDetails: 选择其他成员 / 展开可观察执行输出
        agentDetails --> closed: 关闭或切群
        taskDetails --> closed: 关闭或切群
      }
    }
```

品牌展示对应 BT_U14：侧栏保留 squad. 文字，欢迎区仅显示图标，浏览器图标引用同一份本地 SVG。资源使用正方形视口等比缩放，不依赖外部图片服务。展示沿用 loading / connected / disconnected 及原有消息、详情状态，不产生业务事件或外部操作意图，因此无需新增 XState 状态或转移。

消息正文对应 BT_U15：在原有消息展示中以 14px 基础字号渲染 Markdown，各布局均沿用该字号，保留段内换行与语义结构。仅调整现有状态下的样式，不产生事件或 XState 转移。

界面精简对应 BT_U17–BT_U19：导航、成员、消息和输入区通过分组、间距与明确的操作名称区分；欢迎区只保留品牌、主标题和快捷提问。消息作者使用展开图标并保留可访问名称，替代每条消息底部重复的过程按钮；侧栏与头像入口继续可用。详情空状态只显示简短状态，正常连接不重复解释自动同步，离线时保留提示。连接状态、等待回复、发送失败、停止与继续、协助重试原因、执行身份和预算等影响操作的信息仍然显示。

上述调整只改变原有 loading / connected / disconnected、drafting / sending 和详情状态的渲染，不新增 XState 状态或转移，也不改变 HTTP 命令与副作用边界。测试直接渲染视图和详情组件，验证内容、可访问入口与禁用状态；完整浏览器交互仍按原有待验收项单列。

快照提供群消息、任务状态、评审进度和成员执行日志。消息经 Markdown/GFM 渲染，跳过原始 HTML，代码和已有链接不转成成员按钮。等待用户时发送消息映射 HUMAN_DECISION；继续按钮提交 CONTINUE，停止按钮提交 STOP，均通过 HTTP 服务进入 TeamEngine。HTTP 不接受客户端任意状态机事件。产物下载只读取实际持久化内容。

## 验收执行与覆盖报告

这是测试宿主的处理流程，不增加业务 XState 状态。群历史与评审对应 BT_G01–BT_G14，模型传输对应 BT_M01–BT_M06，Markdown 对应 BT_U10–BT_U13；前述业务状态和交互状态继续复用。协调判断应在转移时保留选择原因及所依据记录，供 BT_O02 核查；监督输入及负责人接续输入应携带已保存的重复失败记录，供 BT_O01、BT_E02 核查。上述修正沿用既有状态转移，仅补齐上下文和记录。

```mermaid
stateDiagram-v2
    [*] --> discovered: 读取全部 feature
    discovered --> invalid: 场景身份重复或排除登记不一致
    discovered --> deferred: 标签与登记匹配 / 保留待验收原因
    discovered --> executing: 其余场景默认执行
    executing --> failed: 步骤未定义 / 断言失败
    executing --> passed: 每个展开用例全部通过
    passed --> reported: 汇总直接执行和回归关联
    deferred --> reported: 单列未执行数量与原因
    reported --> [*]
```

## 浏览器状态机调试

对应 BT_V01–BT_V15。这是观察与沙箱界面，沿用 src/task.machine.ts 的全部业务状态、守卫、意图和拒绝边界，包括 interpreting、协助、额度、停止、版本隔离与恢复；不新增正式业务调度状态。默认使用本地 SVG 从真实机器结构生成状态图，点击状态查看其转移，点击事件填写载荷；可选官方 Inspector iframe 仅负责渲染观测。官方资料：https://stately.ai/docs/inspector 。

```mermaid
stateDiagram-v2
    [*] --> 不可用
    不可用 --> 关闭: 宿主显式开启调试
    关闭 --> 实时观测: 打开面板 / 选择群任务
    关闭 --> 沙箱: 无真实任务 / 创建初始输入
    实时观测 --> 实时观测: 已提交的有序事件与快照
    实时观测 --> 重新同步: 会话变化或历史被裁剪
    重新同步 --> 实时观测: 加载当前基线和可用历史
    实时观测 --> 沙箱: 复制当前快照到独立内存
    沙箱 --> 沙箱: 合法事件 / 真实纯转换并保存历史
    沙箱 --> 沙箱: 参数错误 / 保留当前快照和显示错误
    沙箱 --> 沙箱: 历史定位 / 分叉 / 重置
    沙箱 --> 实时观测: 切换观测模式
    实时观测 --> 关闭: 关闭或Escape
    沙箱 --> 关闭: 关闭或Escape
```

```mermaid
flowchart TD
    A["可信命令或执行结果"] --> B["事务内计算状态与暂存观测"]
    B --> C{"SQLite提交"}
    C -->|失败| D["丢弃观测 / 沿用存储故障处理"]
    C -->|成功| E["发布到有界调试日志"]
    E --> F["网页读取事件顺序和当前快照"]
    E --> G["原有意图领取及执行器"]
```

调试回调在提交后执行，抛错不得让已提交命令失败或令引擎进入存储故障；未保存的暂时拒绝不发布。一个事务内多次纯转换逐项保留，并与最终提交对应。日志只保留当前进程的最近记录，达到数量或字节上限时裁剪；游标失效及进程会话变化明确标记重新同步，历史不是跨重启的完整审计日志。状态同名但上下文变化也需记录，重复命令不产生新观测。

调试读取端点只在宿主开启时提供完整快照，客户端不能向真实任务发送任意机器事件。沙箱只使用同一台机器的 initialTask/stepTask、独立快照、受控时钟与合成结果，不连接 SQLite、WorkRunner、模型或网页工具。外部操作仍只能由正式引擎在事务中保存意图，执行器领取校验后执行并回传；状态图中的虚线或候选事件不表示守卫已通过。停止、错误、额度耗尽及恢复的结果均由原状态机决定，界面不补造通过结果。

后台讨论仿真对应 BT_V10–BT_V14。DISCUSSION_PLAN 模板绑定已领取的讨论协调员工作；DISCUSSION_RESULT 模板绑定本轮在途成员或协调员汇总工作，携带 workId、discussionId、工作自身的 fence 和角色协议。DELIVER、HELP 等主工作模板从主执行流程选取工作，不会因较新的并行成员工作而串错身份。CLAIM 模板只优先选择当前可领取的工作；未经过领取的结果仍受真实守卫限制。缺少必要字段时先报告参数错误，保留沙箱快照与历史。沿用现有业务状态；仅修正模板与事件形状校验，不增加另一套调度规则。

批量仿真枚举主草稿、四位成员结果和协调员汇总的全部144种因果合法返回顺序，逐步检查成员互斥、预算、交接唯一性以及最终检查；另外覆盖在各讨论阶段停止、版本变更、错误身份、失败、超时和恢复。该有限枚举检查明确边界内的执行结果，不构成任意事件序列或真实模型输出质量的证明。

BT_V15 校验图的守卫分支投影：局部事件只有带守卫的分支时，失败后仍可能由父级全局转移处理，状态详情必须保留这些全局分支，例如 running 的 CLAIM 还可领取讨论和取消工作。局部存在无条件分支时才完全遮蔽同名全局事件，例如 stopping 的 STOP。该修正只读取真实机器结构，沿用 XState 的原有事件冒泡语义，不改变业务转移。
