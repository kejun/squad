# squad verification map

先选用户功能，再读配方。一次入口通过不能替代文件列出的其他入口。

## Baseline preconditions

- 独立 checkout，`npm ci` / `npm run build` 完成，Chromium、Playwright 和中文字体可用。
- 使用 `scripts/verify.mjs` 创建隔离实例，每组从自己的空群开始；模型 HTTP 夹具提供合成结果与必要故障。
- 本轮 Doctor 通过，使用独立端口、数据库和浏览器上下文。

## Driving conventions

从仓库根运行 `node .agents/skills/verify-squad/scripts/verify.mjs --feature`，参数取下表。`all` 依次运行五组代表路径。变更经网页；HTTP、SQLite、剪贴板、localStorage 只读观察。等待可观察状态，使用精确 role/name 和区域。重跑使用新证据目录，清理不删除证据。

## Proof and skip reporting

报告区分 `verified`（实际经过入口）、`draft`（只有配方）、`blocked`（尝试后缺少明确前提）。每组通过仅证明其自动化路径，扩展验收逐项单独记录。

| 功能文件 | 参数 | 自动化代表路径 | 仍需另验的扩展 |
| --- | --- | --- | --- |
| [群聊与点名](rooms-routing.md) | `rooms` | 建群按钮/快捷键、默认负责人、菜单/键盘补全、切群、离线、重启保存 | 草稿、Shift+Enter、引用不调度、断网补发/去重 |
| [报告与详情](reports-details.md) | `reports` | 报告入口、复制、下载、返回详情、成员产物页、检查输出修复 | 消息/任务入口、其他详情类型导出、错误反馈 |
| [停止与继续](human-control.md) | `control` | 在途停止、HTTP 取消、明确继续同一任务 | 执行中补充、等待回复、迟到结果、崩溃恢复 |
| [协助与评审](assistance-review.md) | `assistance` | 按钮/文字重试、B 交回 A、四成员评审 | 歧义/版本拒绝、额度耗尽、队列重启 |
| [面板布局](layout.md) | `layout` | 左右拖动、Home、折叠恢复、14px 正文、手机导航 | Escape、其他键盘操作、详情叠层、保存宽度值 |

## Source coverage

| 功能组 | 主要源码 | 规格参考（不宣称全部通过） |
| --- | --- | --- |
| rooms | `web/src/App.tsx`、`web/src/api.ts`、`src/web/http.ts`、`src/web/service.ts`、`src/store.ts` | `01_routing.feature`、`08_interface_and_configuration.feature`，BT_U01/BT_U09 |
| reports | `src/presentation.ts`、`src/model-adapter.ts`、`src/runner.ts`、`web/src/ResultLinks.tsx`、`Details.tsx`、`DetailActions.tsx`、`detail-document.ts` | `17_result_artifacts.feature`、`19_detail_exports.feature`、`20_model_regeneration.feature` |
| control | `src/engine.ts`、`src/task.machine.ts`、`src/runner.ts`、`web/src/App.tsx` | `05_human_control.feature` |
| assistance | `src/assistance-retry.ts`、`src/conversation.ts`、`src/task.machine.ts`、`web/src/AssistanceRetry.tsx` | `10_conversation_review.feature`、`13_assistance_retry.feature`，BT_H11/BT_U16 |
| layout | `web/src/PanelLayout.tsx`、`panel-layout.ts`、`panels.css`、`styles.css` | `18_workspace_panels.feature`，BT_P01–BT_P11 |

规格位于仓库 `features/`；状态图入口为 `README.md`「状态模型」和 `docs/state-diagrams.md`。尚未覆盖真实模型/Cloudflare/技能搜索服务、Pi Durable、供应商金额、全量 Markdown 安全、权限/版本、崩溃恢复和全部预算分支。已有测试用 `npm run check` 补充；`features/acceptance-gaps.json` 的登记保持原状态。
