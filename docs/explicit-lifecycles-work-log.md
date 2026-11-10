# 显式生命周期实施记录

基线：97b7349db41e86a6b3a626f3db3662240c82df2f。用户已确认四项设计并授权实施。

1. 固定并核对最新主分支，保留独立工作分支；先落实服务恢复失败与重复关闭的已复现缺陷。
2. 增加 BT_K08/K09 与服务五态图；宿主资源生命周期不进入持久化任务的业务状态。

后续顺序：同事务宿主批次、显式交付周期、独立分片队列；每项先场景和图，再模型门禁，最后接线。

服务模型门禁：`node --import tsx -e "import('./tests/service-lifecycle-model-fixture.ts').then(m => m.verifyServiceLifecycleModel())"` 通过；验证启动/关闭交错、失败关闭和重复关闭。

接线验证：BT_K09 在原实现因第二次数据库关闭失败而红；BT_K08 的真实恢复异常已在审查探针复现。修复测试工作区与运行时目录重叠后，BT_K08/K09 直接执行 2/2 通过；原 BT_K03–K07 组合 10/10 通过。`tsc -p tests/tsconfig.json --noEmit` 通过。移除布尔写入，以服务模型控制调度；共享 closePromise，启动失败也清理两个连接。

宿主批次：新增 BT_L111/L112，taskMachine 自动微步统一同步 active/uncertain/draining；只有统一退休清除批次。STOP/目标切换保留未知效果屏障，owner 领取收费收敛到 host-retry。旧快照在恢复事件补齐阶段，不新增收费或许可。

门禁：`node --import tsx -e "import('./tests/host-retry-lifecycle-fixture.ts').then(m=>m.verifyHostRetryLifecycleModel())"` 和 TypeScript 通过。使用仓库规定 `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json` 后，`features/27_host_cli_approval.feature` 100/100 直接执行通过；第一次缺该环境变量的 3 个 React 错误属于执行命令配置，未改产品绕过。

交付周期：新增 BT_F63/F64，使用阶段联合载荷，checking 固定 candidateRevision/checkWorkId 并复用原 intent 的冻结材料；技术重试不换材料，业务修订生成新候选。旧快照只补阶段，不生成工作或收费。

门禁：新周期真实 XState 路径通过；`tests/delivery-contract-gate.ts --pure` 91 项通过；TypeScript 通过。交付相关三个 feature 101 个可执行场景通过；既有 BT_F06 费用功能缺口沿用 acceptance-gaps.json 的 requires_cost 排除，不把请求额度冒充金额。

独立分片队列：BT_Q27–Q31 将最多八片与并发人数分开；队列、尝试、分片结果与补位在 taskMachine 原事务中完成。瞬时确定失败最多重试一次且消费共享额度；未知效果保持占用；结果与交付证据按 partitionId/attempt 关联。已有四分组计划仍合法。

模型门禁：`node --import tsx -e "import('./tests/map-queue-fixture.ts').then(m=>m.verifyMapQueueModel())"` 通过五类轨迹；原并行、部分完成、恢复、容量回退模型亦通过。随后接入容量提示与调试投影，`features/26_map_reduce.feature` 52/52 直接通过；新增五例使用真实 SQLite 与公开引擎入口，八片场景由真实 WorkRunner、受控 HTTP 与 web_fetch 分两批执行，每批四个请求在任一返回前均已开始，并在批间重开两次。
