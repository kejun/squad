# 显式生命周期实施记录

基线：97b7349db41e86a6b3a626f3db3662240c82df2f。用户已确认四项设计并授权实施。

1. 固定并核对最新主分支，保留独立工作分支；先落实服务恢复失败与重复关闭的已复现缺陷。
2. 增加 BT_K08/K09 与服务五态图；宿主资源生命周期不进入持久化任务的业务状态。

后续顺序：同事务宿主批次、显式交付周期、独立分片队列；每项先场景和图，再模型门禁，最后接线。

服务模型门禁：`node --import tsx -e "import('./tests/service-lifecycle-model-fixture.ts').then(m => m.verifyServiceLifecycleModel())"` 通过；验证启动/关闭交错、失败关闭和重复关闭。

接线验证：BT_K09 在原实现因第二次数据库关闭失败而红；BT_K08 的真实恢复异常已在审查探针复现。修复测试工作区与运行时目录重叠后，BT_K08/K09 直接执行 2/2 通过；原 BT_K03–K07 组合 10/10 通过。`tsc -p tests/tsconfig.json --noEmit` 通过。移除布尔写入，以服务模型控制调度；共享 closePromise，启动失败也清理两个连接。

宿主批次：新增 BT_L111/L112，taskMachine 自动微步统一同步 active/uncertain/draining；只有统一退休清除批次。STOP/目标切换保留未知效果屏障，owner 领取收费收敛到 host-retry。旧快照在恢复事件补齐阶段，不新增收费或许可。

门禁：`node --import tsx -e "import('./tests/host-retry-lifecycle-fixture.ts').then(m=>m.verifyHostRetryLifecycleModel())"` 和 TypeScript 通过。使用仓库规定 `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json` 后，`features/27_host_cli_approval.feature` 100/100 直接执行通过；第一次缺该环境变量的 3 个 React 错误属于执行命令配置，未改产品绕过。
