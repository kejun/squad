# KEJ-104：SQLite 写事务内的真实进程终止

报告结果或本地领取已经写入 SQLite，但宿主还未完成 COMMIT 时，重开不能看到半份快照、请求回执或租约。本票补充真实进程和依赖验收；生产 `SqliteStore`、状态机和执行协议没有改变。

## 范围与取舍

复用 `tests/durability.test.ts`、`tests/fixtures/crash.ts`、真实 `SqliteStore` / `TeamEngine` 和现有报告夹具。`BT_A66` 明确两种事务、两个边界，承接原 `BT_A03` 的候选/报告回滚、`BT_A36` 的请求去重与 `BT_C02` 的版本保护；不更改 Pi Durable 背景下的 `BT_D06`，也不把关联编号当成其直接验收。

SQLite 官方说明，[独立连接只能看到已经提交的数据](https://www.sqlite.org/isolation.html)，[原子提交](https://www.sqlite.org/atomiccommit.html)则依赖实际事务和存储边界。已有 `failNextCommit` 的显式回滚、提交后 `process.exit` 和形式模型中的原子性假设，都不能证明 COMMIT 前进程丢失的真实接线。

为避免给生产存储增加测试钩子，仅在隔离写者中包装公开 `node:sqlite` 语句：实际执行 `INSERT INTO rooms` 后才阻塞，此时请求回执和适用的工作区租约也已经实际写入。父进程先用独立只读连接观察当前提交边界，再向自己拥有的写者进程组发送 SIGKILL，等待退出，重开数据库核查三类记录。COMMIT 后对照在实际 `COMMIT` 返回后、Engine 尚未得到响应前阻塞。两个位置都不会调用 close、抛异常或执行 catch/ROLLBACK。

写者使用 Node 24 原生 TypeScript 转换和一个最小相对 `.js`→`.ts` 解析钩子。这样 SIGKILL 不会留下 tsx 的外部 esbuild 编译服务；清理必须同时满足 writerGone、processGroupGone 和 temporaryDatabaseRemoved。每个写者有 10 秒期限，父进程仅终止自己创建的进程组。

## 场景、状态图与模型门槛

先修改 `features/17_result_artifacts.feature` 的 `BT_A66`，再补充 [状态模型入口](../../../README.md#状态模型)和[事务处理图](../../state-diagrams.md#sqlite-写事务的进程丢失边界kej-104)，之后才编写依赖夹具。沿用真实 XState 的 `DELIVER → checking`、本地请求/领取、身份/版本/停止守卫；没有新增业务状态、调度或外部副作用。

实现前门槛基线为 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da`。设置 `MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture`，运行：

```sh
node --import tsx tests/core-model-gate.ts
node --import tsx tests/delivery-contract-gate.ts --pure
```

分别退出 0，80 条 core 和 91 条 delivery 纯真实 XState 轨迹通过。没有模型网络调用、文件或进程 I/O 混入这些模型门槛。

## 可重复验收

在仓库根目录、Node 24.22.1 下运行；模型配置只满足现有模块加载，受测流程不会调用提供方。

```sh
MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture node --import tsx scripts/verify-sqlite-crash.ts

MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture \
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json \
node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features \
  --import 'tests/bdd/*.ts' --tags '@BT_A03 or @BT_A36 or @BT_C02 or @BT_A66' --format progress

MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture \
node node_modules/vitest/vitest.mjs run tests/durability.test.ts tests/artifact-output.test.ts \
  tests/artifact-reference.test.ts tests/control-and-delivery.test.ts --maxWorkers=1

node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tests/tsconfig.json
```

结果：目标直接 Gherkin 7 个展开场景、303 步通过（其中 BT_A66 四个展开场景、172 步）；关联 Vitest 四文件、97 例通过，含两个真实依赖负对照。改为原生 writer 启动后再跑 durability 文件，18 例通过。两套 TypeScript 检查通过。Vitest 入口中的真实 SQLite/进程检查属于依赖集成证据，没有新增孤立单元测试。

独立 suite 运行四个原边界用例、两个故障检出后恢复原路径的用例，共六次正向通过。另在隔离子进程把回执提前独立 COMMIT，再启动新事务写快照。原快照仍未提交，而回执（本地领取时还有租约）已经泄漏；两种操作都被具体 `ATOMICITY_RECEIPT` 断言检出，并保存实际 AssertionError 的 code/message/stack/expected/actual。破坏只存在于该子进程，生产文件不被改写；随后原路径再次通过。

`npm run check` 会运行 BT_A66 正向和 durability 负对照，并产生完整覆盖报告。本票单独运行 `coverage:specs` 时因尚未生成全量 `test-results/vitest.json` 退出失败；这不表示覆盖报告已通过，最终集成全量检查由总任务执行。

## 证据与边界

独立入口打印本轮证据目录 `reports/verify-sqlite-crash/<timestamp>-<pid>/suite`。`run.json` 包含代码 SHA、工作区差异、Node 和源文件哈希；每例保留：

- `case.json`：准备时三表基线、实际写入清单和屏障记录、SQLite 版本/WAL/FULL 设置、PID、SIGKILL 退出、杀进程前只读观察、重开记录和清理结果。
- `replayed.json`：同一请求两次重放后的快照、回执和租约；只存在一份报告/候选、一个待执行检查或一个本地领取，原请求回执保持唯一。
- `negative-control.json`：实际目标断言失败及原始预期/观察值；`child.stdout.log` / `child.stderr.log` 保留写者屏障和启动信息。

[本次结果快照](evidence.json)保存可审阅摘要，完整数据库快照留在上述 ignored reports 目录供 CI artifact 保留。该证据限定实际运行的 Linux、Node 内置 SQLite 和当前生产事务实现；不证明硬件断电、磁盘损坏、任意多宿主压力或外部副作用恰好一次。

开发阶段曾先修正 SQLite null-prototype 行与 JSON 证据的比较形态，再发现并去掉被 SIGKILL 写者的外部编译子进程；旧失败尝试保留，旧失败轮临时数据库已核对 prepared.json 所属后移除。最终结果只引用修正后整轮通过的证据。
