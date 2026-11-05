# 宿主会话授权验证

基线7e95c0b；BT_L35–BT_L37先写场景及状态图，再完成真实XState纯模型。

实现前门槛：`node node_modules/vitest/vitest.mjs run tests/host-session-model.unit.test.ts tests/host-approval-model.unit.test.ts tests/host-retry-model.unit.test.ts --maxWorkers=1`，47/47通过，完整退出0（2026-11-05）。每步persist/restore，覆盖不同命令、单次授权不扩大、宿主/账号/环境/工作区隔离、停止/结束/目标变化/继续/重启失效、撤权和领取后撤销。模型不启动进程，无HTTP/数据库I/O。

src/host-session.ts SHA256 `9b014549e6b9e6a5f3525a64176da825e539006acceb2265e7a7a928fb586cab`。
src/local-operation.ts SHA256 `3859558e0d1da6a8f3f05395e5c89c0b16bcc12412f1e9b42b462ff247f3c795`。
src/task/reducer.ts SHA256 `ca21662204388f3edfdabfc16337f3fd372eaa52692e8fc4ca65653ecc4386c5`。
src/task/lifecycle.ts SHA256 `ac5536f214f9fc2616bd468d1d65742ba2e1dd2258de61fb8c81385711f10826`。

通过后进入HTTP、网页和真实进程接线。会话授权不证明模型遵从，不代替操作级digest、租约及效果不明的核对。

## 接线与回归

新增后续纯模型3项覆盖同任务跨Bot、已有并行待批操作复用、环境不同仍待批。最终纯模型组合50项通过。HTTP集成6项通过，使用真实SQLite/宿主进程，仅模型HTTP响应为受控夹具。BT_L35–BT_L37直接Gherkin执行10场景/231步骤通过。接口严格接受approveSession，拒绝跨来源、未知decision及伪造grant；撤销同样必须来自同源用户。

构建及服务、网页、测试TypeScript检查通过。全量Vitest600/600通过，48文件，完整退出0。`npm run check`全量Gherkin625场景中623通过、2失败；15206步骤中15199通过、5跳过、2失败。BT_L19/BT_L22在此容器因OS命名空间不可用失败，未删除或排除场景，不宣称完整检查通过，也未实测macOS。

真实Chromium153验收通过，证据 `reports/host-approval/2026-11-05T03-11-13.359Z/`：一次会话选择后两条不同命令各执行一次、无第二审批POST/弹窗；刷新保留；完成清除；新任务要求授权；撤销后下条弹窗；390px三按钮无溢出；宿主命令回执已持久化后受控服务崩溃恢复，同任务下一条须重新批准。实际生产服务、HTTP、SQLite与宿主命令，模型响应为受控夹具，不能证明任意模型遵从。优雅关闭原有行为会停止在途模型任务，崩溃测试只在没有宿主进程运行的受控边界进行。中文实际Noto Sans CJK，人工查看截图按钮可用。

原按次审批浏览器回归通过，证据 `reports/host-approval/2026-11-05T03-11-47.082Z/`。上述开发验收有未提交变更；交付另在干净提交上复验构建、定向测试与真实浏览器，运行记录包含source、dirty及完整清理结果。远端提交通过tree SHA与本地受测源码核对。

## 固定宿主续办批次

构建后运行 `SQUAD_VERIFY_HOST_QUEUE=1 node scripts/verify-host-approval.mjs <新证据目录>`。如需指定已安装的 Chromium，设置 `SQUAD_CHROMIUM`。

真实浏览器从成员的执行记录用键盘提交三条续办请求。检查覆盖当前模型工作继续、刷新后仍显示排队、前两条命令串行复用一次授权、390px 视口键盘撤销、退出审批弹窗、重启后为同一未执行命令重新审批，以及收齐回执后只综合和独立检查一次。用 SQLite 回执和实际进程写入核对已结算命令的执行次数。模型响应由本地 HTTP 夹具提供。
