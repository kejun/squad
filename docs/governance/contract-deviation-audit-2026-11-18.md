# 契约偏差治理记录（2026-11-18）

审计基线：`main` 的 `17c851fd55890ac9309dd9bc788b31a8b2b43c3d`。治理规则见 [AGENTS.md：契约权威与偏差治理](../../AGENTS.md)。

本记录只记录已核实的偏差与处置状态。CI 全绿不代表语义偏差自动消失。涉及产品行为、测试体系大范围重构或真实浏览器接线扩展的事项，在用户确认前不实施。

## 已完成：无产品行为变化的小修正

| 编号 | 偏差与权威依据 | 处置 | 验证状态 |
| --- | --- | --- | --- |
| GOV-001 | BT_K08 将关闭描述为释放两个数据库连接；`src/web/service.ts` 与 `src/store.ts` 证明 WebService 创建并拥有一个 SQLite connection，`SqliteStore` 借用该连接，不拥有第二个连接。 | 将 `features/41_service_composition.feature` 与步骤绑定改为关闭唯一共享 SQLite 连接；同步 `docs/state-diagrams.md` 生命周期说明。 | 已核对源码与步骤绑定；本次提交后 CI 尚未产生运行记录。 |
| GOV-002 | `docs/state-diagrams.md` 的 KEJ-113/114 删除段落仍标记为“拟建”，并使用当前 `roomDeletionMachine` 不存在的旧事件 `INVENTORY/SETTLED/ITEM_SETTLED`。真实事件为 `REQUEST/PREPARED/ASSET_REMOVED/DATA_ERASED/VERIFIED/FAILED/RETRY/RECOVER/TICK`。 | 删除过时的拟建状态图，改为引用当前强制删除细图，并说明旧确认/清单/人类等待协议仅用于兼容旧快照。 | 已对照 `src/room-deletion.machine.ts` 与当前强制删除文档；静态复核旧事件残留为 0。 |
| GOV-003 | `docs/implementation/kej-113-host.md` 将已存在的 `src/process-supervisor.machine.ts` 描述为“拟建真实 XState”。 | 改为“真实 XState 进程监督模型”。 | 已对照源码及 `scripts/supervise.ts` 接线。 |
| GOV-004 | BT_H 场景的 Given 只比较 Gherkin 参数字符串“执行中”，没有核对真实 taskMachine snapshot。 | 在 `tests/bdd/steps.ts` 增加 `this.h.view().phase === 'running'` 断言。该场景唯一使用的状态参数为“执行中”。 | 已核对场景定义与真实 `Phase`；本次提交后 CI 尚未产生运行记录。 |

相关提交：
- `16e088a`：删除状态图与服务生命周期图纠偏。
- `e7411aa`：宿主监督模型文档状态纠偏。
- `785e817`：BT_K08 场景措辞纠偏。
- `a4a26db`：BT_K08 步骤绑定措辞纠偏。
- `9755e96`：BT_H Given 核对真实状态快照。
- 治理规则：`5f599be`。

## 待处理：需要进一步治理

| 编号 | 位置 | 已核实偏差 | 建议处理 | 规模/状态 |
| --- | --- | --- | --- | --- |
| GOV-005 | `tests/bdd/receipt-projection.steps.ts`，BT_M60–M65 | 多个 When 是空函数；部分 Given 承担了完整执行过程，Then 只检查弱代理值，未逐项核对场景所述的回执字段。底层 `tests/receipt-projection-acceptance.ts` 有真实行为断言，但 Gherkin 步骤并未忠实编排该行为。 | 逐场景重构 Given/When/Then，使 Given 准备数据、When 触发实际请求/检查点组装、Then 直接核对完整结果；保留现有真实验收覆盖，不以弱断言代替。 | **较大测试契约重构；待用户确认**。 |
| GOV-006 | `tests/bdd/hierarchical-summary.steps.ts`，BT_Q50–Q54 | 多个 Given 为空操作；数据规模、顶层摘要超页、固定检查材料等前提没有在 Given 中建立，而由后续辅助函数/When 临时构造或合成。 | 重新设计场景夹具与步骤职责；确认 100/1000 文章、页预算、额度与正文隔离都由场景驱动的可观察路径验证。 | **较大测试契约重构；待用户确认**。 |
| GOV-007 | `tests/bdd/model-and-markdown.steps.ts`，BT_U22 | 目前直接调用 `compactMessage` 与 `MessageText` SSR，未真实渲染 Workspace 时间线和 Details 页面；只能证明纯投影与 Markdown 渲染，不足以证明页面接线。 | 在不改变产品行为的前提下评估最小组件集成或 Chromium 验收，验证真实时间线、详情、链接和旧摘要。 | **增加真实 UI 接线验证；待用户确认**。 |

## 重要边界

- 本次小修正没有改变产品行为、XState 状态/事件、权限、预算、持久化格式或删除语义。
- GOV-005 至 GOV-007 可能改变现有 Gherkin 步骤的执行结构与验收强度，且涉及多个场景/测试夹具；依据治理规则，先向用户提交分项方案并取得确认，不在本记录中自行扩大实施。
- 其他 Gherkin 步骤是否存在同类空操作、虚假前置条件或弱 Then，尚未完成全仓逐步审计；不得将本轮发现外推为全部偏差。
- 最新基线 CI Run #102（提交 `17c851f`）通过 2,073 个 Gherkin 场景和 151,582 步，但它不能证明本次后续修改已通过，也不能消除上述测试表达偏差。
- 本次后续提交尚无新的 CI run/status 记录；在新的验证运行完成前，不宣称这些改动已通过 CI。
