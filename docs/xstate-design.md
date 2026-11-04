# XState 设计原则

## 调研结论

[Sandro Maglione 的文章](https://www.sandromaglione.com/newsletter/xstate-at-its-extreme)（2025-12-10）给出的经验是：简单流程用小机器；当状态、上下文和转移集中膨胀时，按职责提取子机器，通过关键事件协作，让各自状态由各自管理。

这提供了拆分方向，不能仅按文件行数决定拆分。[官方并行状态说明](https://stately.ai/docs/parallel-states)指出，并行区域适合同一生命周期内同时活跃的正交行为；它本身不是坏设计。[Actor 文档](https://stately.ai/docs/actors)强调独立状态与消息边界；有独立生命周期才考虑独立 actor。需要原子提交的数据不能仅为了缩小图就拆成异步消息。

调研日期为 2026-10-30。仓库固定 `xstate@5.33.3`；在线文档部分页面已出现 v6 alpha 导航，本次只采用与本地 v5 源码、类型及测试核对一致的概念和 API，不迁移版本。

## 八条原则

1. **一个模型，一个明确的状态所有者。** 先说清职责、输入事件、输出和生命周期，再决定是否需要机器。简单值和纯展示无需强造状态机。
2. **state 表示行为模式，context 保存事实。** 模式决定允许什么事件；计数、版本、结果和标识放 context。context 中决定行为的生命周期也须画图，标明字段与所有者，不能伪装成顶层状态。
3. **按生命周期组合。** 共享进入、退出及事件规则用层级；同时活跃且共享生命周期用 parallel；独立创建、停止和恢复的实体才考虑 actor。`invoke` 随所属状态进入/退出，`spawn` 适合动态实体，均须明确消息和停止契约。
4. **事件明确，守卫纯且有序。** 统一写 `事件 [守卫] / 更新或意图`；分支按源码优先级解释，补清默认拒绝、父级回退和 `always`。无 target 的更新不画成退出再进入。
5. **状态决策与外部执行分开。** 本仓库的机器只纯更新 context 和可持久化意图；事务提交、领取与授权成功后，执行器才做 I/O，结果校验后回传。取消请求、进程退出与效果确认是不同事实。
6. **恢复是正常路径，终态语义要准确。** 显式覆盖失败、重试、额度、停止、迟到、重复、版本及恢复；业务 `ended` 能继续，不能画成 XState `final`。未知写入先核对，不能直接重放。
7. **每张图只解释一个层次。** 真实机器画 statechart，持久化子生命周期标字段，处理步骤用 flowchart，UI 标为投影。总览只保留主路径，公共边界放表，细节通过链接展开；不把设想的 actor 画成已实现结构。
8. **模型先可验证，再接 I/O。** 用真实模型、受控事件和时钟检查关键轨迹与不变量；图、场景、源码互相核对。文档重构验证来源与语法，行为改变仍执行仓库完整变更流程。

这些原则是仓库的设计选择，不是 XState 对所有应用的限制。特别是 [XState actions](https://stately.ai/docs/actions) 本身支持副作用；本项目为事务、重启和可重放仿真采用更严格的纯模型边界。

## 在当前仓库如何落地

| 所有者 | 当前职责与边界 | 组合取舍 |
| --- | --- | --- |
| `taskMachine` | 任务阶段及同一任务内的评审、讨论、协助、输入、操作意图和预算 | 根 actor 保留业务原子更新；已领取的执行尝试是独立子 actor，父子深度快照一起提交 |
| `roomMachine` | 房间归档元数据 | 与任务生命周期独立；归档不停止执行、不更改预算 |
| `inspectorWindowMachine`、`inspectorMachine` | 标签页和观察连接 | 两个独立观察模型，由浏览器控制器协调；不属于任务机器的 parallel 区域 |
| `TeamEngine` / `WorkRunner` | 可信命令与事务 / 领取后的外部执行 | 它们是执行边界，不以图中的处理节点冒充 XState 状态 |
| React、本地布局转换 | 连接、草稿、详情、复制、拖拽和选择 | 按 UI 投影记录，视觉参数归样式规范 |

实际多 actor 边界、启动许可、取消与恢复协议见[任务与执行 actor](task-actors.md)。讨论与协助的任务级预算及原子交接留在根 actor；按领取尝试创建的执行实体独立推进并深度持久化。

## 图的阅读约定

- **真实 XState**：节点 ID 与源码一致；无 target 的动作列为内部更新，只有 `type: 'final'` 才连终止标记。总览允许省略边，必须链接完整边界说明。
- **上下文生命周期**：节点是指定字段的枚举值；创建、消费和跨记录重试需说明身份。新建一个 `retryOf` 关联记录不等于旧记录回到 pending。
- **处理流程**：使用 flowchart 描述事务、协议校验和适配器步骤；节点名不声称是可恢复的业务状态。
- **界面投影**：说明 React 字段、派生条件和生命周期；可以并列展示独立维度，但不暗示实际使用了 XState parallel。
- 事件名沿用源码；方括号是条件，斜线后是状态更新或保存的意图。外部执行必须注明执行器。全局规则用表展开，避免为每个状态复制同一组停止和恢复箭头。

## 一手依据

| 主题 | 官方资料 | 本仓库采用的结论 |
| --- | --- | --- |
| 有限状态与数据 | [Context](https://stately.ai/docs/context)、[Parent states](https://stately.ai/docs/parent-states) | context 不可原地修改；层级表达共享生命周期，简单模型可以没有子状态 |
| 并发与组合 | [Parallel states](https://stately.ai/docs/parallel-states)、[Actors](https://stately.ai/docs/actors)、[Invoke](https://stately.ai/docs/invoke) | 区分正交区域与独立实体，按生命周期选择边界 |
| 选择转移 | [Guards](https://stately.ai/docs/guards)、[Transitions](https://stately.ai/docs/transitions) | 纯同步守卫；按序选择；内部更新与有目标转移分开 |
| 结束与恢复 | [Final states](https://stately.ai/docs/final-states)、[Persistence](https://stately.ai/docs/persistence) | 真正 final 不再处理事件；持久化不等于外部请求恰好执行一次，恢复 invocation 可能重新启动 |
| 纯仿真 | [Pure transitions](https://stately.ai/docs/pure-transitions) | `initialTransition` / `transition` 计算快照与动作，不直接执行外部动作 |

当前模型入口见 [README](../README.md#状态模型)，按所有者索引见[细化状态图](state-diagrams.md)。

本次文档重构的来源核对、模型回归、渲染结果与验证范围见[核对记录](state-diagrams-verification.md)。
