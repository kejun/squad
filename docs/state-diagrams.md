# 细化状态图

本文件与 README 的「状态模型」共同描述当前功能。顶层任务状态由 `src/task.machine.ts` 管理；下图分别标明上下文状态、操作状态和界面状态，不能将后两者误认为新增的 XState 顶层状态。

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
- 结果必须先 RECORD_RESULT 持久化，再以 HELP_RESULT 消费；结果 ID 防止重复消费，epoch/goalVersion 隔离迟到结果。配置撤销成员或权限时暂停恢复。初次评审直接进入组织阶段，避免负责人先回答一次才拉人。

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

每个额外模型请求和技能搜索都先经 `scope.authorizeAdditionalRequest` 的 CONSUME 检查。被拒后禁止发起 I/O。模型 HTTP 408、429、5xx 或网络故障可有限重试；协议错误与不可恢复故障按任务图转移。技能搜索不会安装技能。停止首先持久化并派发取消意图，AbortSignal 传入模型和搜索；取消请求发出不等于原操作已结算。外部结果不确定时必须核对，不能直接重放。

OpenCode 会话标识只影响传输：网页使用群 ID，CLI 使用持久任务 ID，适配器哈希后添加请求头，不创建另一条调度路径。HTTP 错误只保留已校验的短代码；MissingSessionID 即使附带参数标识，也应提供缺少会话头的提示，仍沿用 WORK_FAILED 转移。瞬态故障到达重试上限时，等待原因应同时说明原错误和额度限制。执行日志是观察记录，不驱动业务转移。

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
        [*] --> loading
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
        closed --> agentDetails: 点击成员或 Markdown 中成员点名
        closed --> taskDetails: 点击任务状态
        agentDetails --> agentDetails: 选择其他成员 / 展开可观察执行输出
        agentDetails --> closed: 关闭或切群
        taskDetails --> closed: 关闭或切群
      }
    }
```

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
