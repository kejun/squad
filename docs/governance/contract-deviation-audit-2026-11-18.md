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
| GOV-005 | `tests/bdd/receipt-projection.steps.ts`，BT_M60–M65 | 原空 When 和弱 Then 已修复：When 现在执行真实回执验收，Then 核对正文隔离、操作号、退出码、截断状态、SHA-256、偏移、证据引用、固定输入完整性及失败代码。 | 已增强验收函数返回的可观察证据，并由 Gherkin 逐字段断言。Given 目前只选择场景类型，真实数据仍由 When 调用的验收函数内部构造；严格 Given/When/Then 数据准备分离尚未完成。 | **部分完成；待进一步重构 Given 夹具**。 |
| GOV-006 | `tests/bdd/hierarchical-summary.steps.ts`，BT_Q50–Q54 | 空 Given 已替换为场景选择状态，When 执行对应模型验收；但 Given 仍未真实保存文章、构造摘要或固定检查材料，场景数据在 When 的辅助函数内部创建。 | 下一步将 SummaryModel 的准备与执行拆开：Given 建立并持有真实模型/文章/额度前置状态，When 只触发归并、分页读取、超页拒绝或检查组装，Then 断言真实结果。 | **部分完成；待 Given/When 数据边界重构**。 |
| GOV-007 | `tests/bdd/model-and-markdown.steps.ts`，BT_U22 | 目前直接调用 `compactMessage` 与 `MessageText` SSR，未真实渲染 Workspace 时间线和 Details 页面；只能证明纯投影与 Markdown 渲染，不足以证明页面接线。现有 Chromium BDD 驱动只允许 BT_U01/U02/U03/U09，尚无 BT_U22 浏览器命令链。 | 需扩展真实 Chromium contract driver，准备已持久化的协调报告、历史单行摘要和成员标题，再从实际页面时间线及 Details 面板核对普通正文、可打开链接和标题保留。 | **尚未实施；待 UI fixture 与 Chromium contract 接线**。 |

## 重要边界

- 本次小修正没有改变产品行为、XState 状态/事件、权限、预算、持久化格式或删除语义。
- GOV-005 至 GOV-007 可能改变现有 Gherkin 步骤的执行结构与验收强度，且涉及多个场景/测试夹具；依据治理规则，先向用户提交分项方案并取得确认，不在本记录中自行扩大实施。
- 其他 Gherkin 步骤是否存在同类空操作、虚假前置条件或弱 Then，尚未完成全仓逐步审计；不得将本轮发现外推为全部偏差。
- 最新基线 CI Run #102（提交 `17c851f`）通过 2,073 个 Gherkin 场景和 151,582 步，但它不能证明本次后续修改已通过，也不能消除上述测试表达偏差。
- 本次后续提交尚无新的 CI run/status 记录；在新的验证运行完成前，不宣称这些改动已通过 CI。


## 2026-11-18 后续进展（提交 `eb64483` 及其前置提交）

- GOV-005：`tests/receipt-projection-acceptance.ts` 现在向步骤层返回具体回执字段；`tests/bdd/receipt-projection.steps.ts` 不再以计数或字段存在性代替主要结果断言。静态核对确认这些步骤文件没有空函数或 `return undefined`。仍未完成 Given 真正准备数据、When 单独执行请求的分离，因此仅标记部分完成。
- GOV-006：空 Given 已去掉，但目前 Given 只选择场景类型；When 内的模型夹具仍同时创建文章、建立前提并执行场景。不可将其视为完整 Given/When/Then 语义修复。
- GOV-007：已核实当前 Chromium 驱动只接受 BT_U01、BT_U02、BT_U03、BT_U09；尚未接入 BT_U22，因此没有宣称页面级验证完成。
- 本次提交尚未取得新的 CI 运行证据。