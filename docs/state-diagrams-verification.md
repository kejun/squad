# 状态图重构核对记录

> 本页保留当时实跑的命令和数量。2026-10-30 测试治理后的文件对照、当前入口与数量见[测试治理记录](test-governance.md)；历史结果不代表当前用例数量。

2026-10-30，依据 [XState 设计原则](xstate-design.md)整理 [README 总览](../README.md#状态模型)和[分层状态图](state-diagrams.md)。本次是文档与规则重构，产品源码和 Gherkin 契约未改变，因此没有新建场景、虚构业务状态或迁移已有快照。

## 重构结果

- 总览分为成功路径与控制路径；共用八个真实任务状态，公共事件规则单列。
- 细化图按任务上下文、执行适配器、房间命令、网页观察与验收流程组织，每图标明类型与所有者。
- 输入、协助、评审、讨论、意图和本地操作的生命周期使用真实枚举值；协议校验、HTTP、事务和宿主启动使用流程图。
- 修正协助重试的记录身份、取消与实际结算、业务 ended 与 final 的区别，以及两个 Inspector 模型的边界。内部更新和全局释放规则移入事件表。
- 原细化章节锚点全部保留，旧「页面侧栏与字号」链接通过兼容锚点指向「页面面板交互」。

## 已执行验证

模型与边界回归命令：

```sh
node node_modules/vitest/vitest.mjs run tests/core.test.ts tests/control-and-delivery.test.ts tests/task-inspection.test.ts tests/discussion-simulation.test.ts tests/local-operation-model.test.ts tests/room-archive-model.test.ts tests/inspector-model.test.ts tests/panel-layout.test.ts --maxWorkers=1
```

8 个文件、117 项通过。覆盖真实任务转移、停止自动微步、局部守卫回退根分支、重试分支顺序、讨论的 144 种因果合法返回顺序、额度、版本、恢复、本地操作、归档和 Inspector 模型。该有限范围不代表任意事件序列的形式证明。

文档核对报告与脚本保存于 `reports/state-diagrams/2026-10-30-refactor/`：

| 核对 | 结果与范围 |
| --- | --- |
| 真实机器 | 对照本地 XState 5.33.3 的四个真实模型，核对已画出的事件目标、初始值、节点和 final；两张任务总览合并覆盖全部八个状态 |
| 上下文生命周期 | TypeScript AST 读取六类 status 联合类型，与图中节点逐项一致 |
| 来源完整性 | 本次开始时的 75 个产品源码及 `.feature` 文件 SHA-256 全部保持一致 |
| 链接 | 修改文档中的本地链接与旧章节锚点有效；校验不覆盖外站实时可用性 |
| Mermaid | 35 个图全部通过 Mermaid 12.2.0 语法解析与 Chromium SVG 渲染；总览及 Inspector 图另有截图供目视核对 |

本机可重复运行 `node --import tsx reports/state-diagrams/2026-10-30-refactor/check-state-docs.ts`。渲染脚本 `render-state-docs.mjs` 使用已安装的 Playwright，Mermaid bundle 可由 `SQUAD_MERMAID_BUNDLE` 指定；本次 bundle 来自官方 npm 包 `mermaid@12.2.0`，没有加入应用依赖。

源码比对检查的是图中声明的节点、状态枚举与已有转移目标，不自动证明所有守卫描述等价或所有分支完备。公共边界与身份语义另结合源码审阅及上述回归核对。此次没有重跑产品浏览器、直接 Gherkin 或真实供应商/CLI 集成；静态图的浏览器渲染不冒充产品流程验收。

## 受核对的模型版本

| 文件 | SHA-256 |
| --- | --- |
| `src/task.machine.ts` | `dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9` |
| `src/types.ts` | `9c1b3801b9ec8e890909fde106a0de26a8dd30a3c85397cb5fd9461ab4f46482` |
| `src/local-operation.ts` | `57a5f88c8a8640d99dfe98166cdf40e371d30717e9ba1ddcbe38658f6ce39fce` |
| `src/room.machine.ts` | `1f2acd3d217731acd39b4258e0148b65b600f2b8cd7ae8cdcee8f047d8b696ab` |
| `src/inspector.machine.ts` | `0c9ba840dd017b3149dfae33186ea850376c35048eb43da52a57a8618cc000f5` |
| `web/src/panel-layout.ts` | `02af47b5386c914e0f0f966998e14c3fb5e1ca115854355721f18be17708bba9` |
