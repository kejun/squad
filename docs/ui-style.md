# 界面样式规范与检查

Gherkin 负责行为验收；本文件承接静态视觉约定。调整这些约定时同步样式与相关检查，无需为颜色、字号、装饰或等高要求新增场景和状态。涉及操作可用性、可访问名称、键盘、焦点、响应式遮挡或状态变化时，仍按 `AGENTS.md` 的行为工作流处理。

| 约定 | 实现来源 | 自动检查 |
| --- | --- | --- |
| 普通及用户消息正文基础字号为 16px，基础色为 `#273142`；保留 Markdown 自身的语义样式 | `web/src/styles.css` | `tests/ui-style.test.ts`；`verify-squad` 的 `layout` 浏览器流程读取桌面与手机计算样式 |
| 各区域文字的声明字号不低于 14px，覆盖媒体查询、代码、脚注及浏览器默认小字；不通过整体缩放缩小文字 | `web/src/*.css` | `tests/ui-style.test.ts` 调用全样式表审计 `tests/typography-audit.ts` |
| 聊天与详情标题栏高度为 64px，不随内容区压缩 | `web/src/styles.css` | `tests/ui-style.test.ts` 在四种窗口样本下读取计算样式 |
| 品牌 SVG 使用正方形视口，侧栏保留 squad. 文字、欢迎区只显示图标；导航收起时品牌图形位于顶栏导航按钮之前 | `web/public/logo.svg`、`web/src/Logo.tsx`、`web/src/App.tsx` | `tests/ui-style.test.ts`；品牌可识别、入口可用另由 BT_U14、BT_P14 验收 |

这些检查验证当前样式约定，不代表完整的无障碍合规或所有浏览器视觉验收。模拟 DOM 的计算样式也不等同于真实浏览器几何。

面板宽度与断点的实现参数由 `web/src/panel-layout.ts` 维护，具体边界样本放在 `tests/panel-layout.unit.test.ts`、`tests/panel-layout-simulation.ts` 和 `tests/bdd/panels.steps.ts` 中。Gherkin 描述可拖拽、聊天空间保护、临时限幅、偏好恢复和取消等行为，不绑定某一组像素值。

运行专门样式检查：

```sh
node node_modules/vitest/vitest.mjs run tests/ui-style.test.ts --maxWorkers=1
```

需要真实浏览器样式验收时，按仓库 `verify-squad` 技能运行 `layout` 流程。既有证据 `reports/verify-squad/2026-10-30T00-29-05.067Z-24012/` 在桌面与手机读取普通及用户消息 16px、`rgb(35, 35, 35)`，状态 verified，清理项全部为 true；这是原 BT_U15 迁移前的历史证据，此次规格清理不声称重新运行浏览器。

原场景 BT_U15、BT_P10、BT_P20 的退出原因与检查映射登记在 [features/README.md](../features/README.md)。Markdown 的换行、语义和安全约束仍由 BT_U10–BT_U13 验收。
