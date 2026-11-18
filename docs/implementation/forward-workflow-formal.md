# 正向推进的形式化对应审查

PR #69 的 `91e07aa973c9a201783858248512bacb6c78c7b0` 是本次产品变更的基线。该提交的九份覆盖清单逐项匹配基线字节，GitHub Actions 的生产器与证据读回均通过。[基线 CI](https://github.com/kejun/squad/actions/runs/44285640965)

| 需求 | 覆盖源码审查 | 对应关系 |
|---|---|---|
| FW-01 | `task/discussion.ts`、`task/hierarchical-summary.ts`、`task/map-queue.ts`、`task/map-reduce-capacity.ts`、`task/budget.ts`。 | 仅在建立 `summaryLayer` 后移除模型结算，并少预留一次归并请求。Shards、DiscussionBudget 和 ReservedRequests 的普通分片与后继预留仍按原路径。分层及旧快照走 BT_Q55–Q56。 |
| FW-02 | `runner.ts`、`task/tool-recovery.ts`、`task/guards.ts`、`task/lifecycle.ts`、`task/reducer.ts`。 | ToolRecovery 的两次反馈上限、请求身份、时限、后继预留、失败回执收费均沿原模型。新分支处理执行器结算时的结构化失败，沿用安全协调与部分交付。该分支由 BT_M66–M67 按真实模型及执行器验证。原失败上限负对照跟随命名常量。 |
| FW-03 | `task/delivery.ts`、`task/reducer.ts`、`task/evidence.ts`、`delivery-acceptance.ts`、`delivery-check-delta.ts`、`resource-acquisition.ts`、`model-adapter.ts`、`runner.ts`。 | 有必需资源缺口也可提交候选。原接受条件、固定证据指纹及宿主获取判据继续约束 `CHECK_RESULT`。新增引用只来自同一个已领取检查的实际回执。现有交付有限图的候选无这类资源获取要求。BT_E128–E129 在状态机和真实 HTTP、SQLite、Runner 核对缺口与补证。 |
| FW-04 | `engine.ts`、`task/guards.ts`、`task/resilience.ts`。 | DeferredCoordination 增加 `TickClaimable` 与可达见证。回放在进展期限验证原负责人仍可领取，在原工作到期验证 `Tick` 可协调。两个存储都用移除有效工作守卫的源码负对照验证故障检出。 |

授权、租约和未知效果沿用各自模型和原子事务。形式化结论限定在各模型声明的有限域和代表路径。真实分层、失败接续和下游补证的验收见 [FW-01–04](../requirements/forward-workflow.md)。

## 运行结果

在 `cc4db5c18340fd8f7498e294eb5be036b47868c1` 的产品源码上运行了[九个入口](../formal-verification.md#六个技能与完整入口)及对应的独立证据读回。九个生产器均报告 `verified`，九个读回命令均退出 0。DeferredCoordination 的图包含 438 个不同状态和 1,071 条边，队列清空。移除有效工作判据后，MemoryStore 与 SQLite 均在 `RetainClaimableWork` 断言处失败，原版复验通过。
