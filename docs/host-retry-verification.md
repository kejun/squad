# 沙箱失败后的宿主申请入口

基线 `0061e4c`，场景BT_L31–BT_L34。先更新Gherkin及README/状态图，再增加真实taskMachine的REQUEST_HOST_RETRY转移。

## 实现前模型门槛

命令：`node node_modules/vitest/vitest.mjs run tests/host-retry-model.unit.test.ts tests/host-approval-model.unit.test.ts --maxWorkers=1 --reporter=default`。

结果：32/32通过，完整退出0。每步持久化/恢复，无进程、HTTP、文件或数据库I/O。覆盖已结束任务显式续办、确定失败命令固定、重复点击、在途安全模型取消、停止、旧目标、撤权、效果不明、部分写入提示及额度。

受测host-retry.ts SHA-256：`e01e9fa746e0a0b6b5ccab207d1ea1e0f9afd4eee2a73922b22fe01d4fd42501`；task/lifecycle.ts：`8361553ad65dea54336d21e3732b6282d053f92859dff9fd28f9b8a43a38538f`。新图结构指纹 `77187119`。

通过该门槛后再接HTTP、网页与执行器。模型层不证明模型必然遵从提示，也不替代真实命令和浏览器验证。

## 接线与界面验证

`node node_modules/vitest/vitest.mjs run tests/host-retry.test.ts tests/host-approval.test.ts tests/task-model-refactor.test.ts tests/host-retry-model.unit.test.ts --maxWorkers=1`：50/50通过。覆盖真实同源HTTP、SQLite、宿主进程、固定参数、跨来源拒绝、重复点击以及真实回执回灌。

`TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/27_host_cli_approval.feature --import 'tests/bdd/*.ts' --format progress`：24场景、536步骤全部通过。BT_L31验证实际发给模型的提示协议；不声称模型必然遵从。BT_L32/33经真实HTTP申请和批准，BT_L34混合真实HTTP入口与真实XState边界；按钮实际点击另由Chromium验收。

`npm run build` 通过。构建后运行 `SQUAD_VERIFY_HOST_RETRY=1 node scripts/verify-host-approval.mjs`，浏览器模块及二进制按文档设置。Chromium153真实点击通过：模型结束且hostApprovals为空后从失败按钮申请、关闭不决定、刷新保留、拒绝不执行、允许一次、真实HOME及命令输出、重启重签、390px移动视窗。模型HTTP响应为受控夹具；服务、HTTP、SQLite和宿主进程为真实实现。当前容器OS沙箱不可用，失败记录来自真实生产后端的拒绝，不把此结果当作macOS/Linux隔离已通过。字体检查确认Noto Sans CJK实际绘制中文。

首次开发验证证据：`reports/host-approval/2026-11-04T10-54-20.774Z/`，含截图、浏览器trace、模型HTTP请求及SQLite回执。该次工作区有未提交修改，不作为已提交版本的执行证明；交付时复验已提交版本。

macOS夹具以realpath规范临时根目录，消除`/var`与`/private/var`别名断言差异。本环境未运行macOS实机测试。

全量回归：Vitest报告576/576通过；全量Gherkin615场景中613通过、2失败（BT_L19、BT_L22，当前容器缺少OS命名空间能力），14360步骤中14353通过、5跳过、2失败。未删除或排除这两项必需场景，`npm run check`及覆盖门槛不记为全绿。
