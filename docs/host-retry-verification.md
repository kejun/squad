# 沙箱失败后的宿主申请入口

基线 `0061e4c`，场景BT_L31–BT_L34。先更新Gherkin及README/状态图，再增加真实taskMachine的REQUEST_HOST_RETRY转移。

## 实现前模型门槛

命令：`node node_modules/vitest/vitest.mjs run tests/host-retry-model.unit.test.ts tests/host-approval-model.unit.test.ts --maxWorkers=1 --reporter=default`。

结果：31/31通过，完整退出0。每步持久化/恢复，无进程、HTTP、文件或数据库I/O。覆盖已结束任务显式续办、确定失败命令固定、重复点击、在途安全模型取消、停止、旧目标、撤权、效果不明、部分写入提示及额度。

受测host-retry.ts SHA-256：`7debab21b1aa4ec4fda213278024d81cbd96f2d65b5a870477b83aae8a78936f`；task/lifecycle.ts：`8361553ad65dea54336d21e3732b6282d053f92859dff9b8a43a38538f`。新图结构指纹 `77187119`。

通过该门槛后再接HTTP、网页与执行器。模型层不证明模型必然遵从提示，也不替代真实命令和浏览器验证。
