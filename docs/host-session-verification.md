# 宿主会话授权验证

基线7e95c0b；BT_L35–BT_L37先写场景及状态图，再完成真实XState纯模型。

实现前门槛：`node node_modules/vitest/vitest.mjs run tests/host-session-model.unit.test.ts tests/host-approval-model.unit.test.ts tests/host-retry-model.unit.test.ts --maxWorkers=1`，47/47通过，完整退出0（2026-11-05）。每步persist/restore，覆盖不同命令、单次授权不扩大、宿主/账号/环境/工作区隔离、停止/结束/目标变化/继续/重启失效、撤权和领取后撤销。模型不启动进程，无HTTP/数据库I/O。

src/host-session.ts SHA256 `9b014549e6b9e6a5f3525a64176da825e539006acceb2265e7a7a928fb586cab`。
src/local-operation.ts SHA256 `3859558e0d1da6a8f3f05395e5c89c0b16bcc12412f1e9b42b462ff247f3c795`。
src/task/reducer.ts SHA256 `ca21662204388f3edfdabfc16337f3fd372eaa52692e8fc4ca65653ecc4386c5`。
src/task/lifecycle.ts SHA256 `ac5536f214f9fc2616bd468d1d65742ba2e1dd2258de61fb8c81385711f10826`。

通过后进入HTTP、网页和真实进程接线。会话授权不证明模型遵从，不代替操作级digest、租约及效果不明的核对。
