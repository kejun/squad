# KEJ-103：CLI 效果后的真实宿主崩溃验收

原 `crashAcceptance` 在 `runtime.execute` 返回后同进程重新打开 SQLite，无法证明外部效果已发生而回执尚未持久化时的恢复。本次保留原 BT_L06 编号、其余崩溃窗口和 BT_L14 的核对契约，新增 `日志回执后任务提交前` 对照，并使 `启动后回执前` 与停止核对使用真实被终止的宿主。

这次只增加真实依赖接线验证，不改变生产业务行为、状态、权限或故障点。没有新增单元测试，也没有将 Pi Durable 的 BT_D09/D13 视为已执行。状态图见 [效果后宿主崩溃](../../state-diagrams.md#效果后宿主崩溃kej-103)。

## 顺序与模型门槛

1. 完整读取 AGENTS.md、Uncle Bob Mode 及原场景/恢复夹具，确认可复用 journal、CLI、Store、Runner 与宿主核对接口。
2. 保留 BT_L06 的原行为要求，先增加日志与任务回执之间的实际窗口，再补 README 状态模型入口与恢复处理图。无新增 XState 状态、事件或守卫。
3. 在生产接线夹具之前以基线 `8a2f82b` 的真实 `taskMachine` 复验 BT_L73/BT_L74：14 场景、574 步通过。轨迹覆盖排队/领取/运行后停止、未知效果恢复、notStarted 可信核对、已知回执保留、旧目标与协议阻塞。
4. 随后增加父子进程夹具和直接执行绑定，运行正向验收与隔离负对照。

模型门槛命令（环境的孤立 MODEL_API_KEY 不参与受控验收）：

```sh
env -u MODEL_API_KEY TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/24_local_skills_cli.feature --import 'tests/bdd/*.ts' --tags '@BT_L73 or @BT_L74' --format progress
```

## 实际故障边界与证据

`tests/fixtures/local-effect-crash-host.ts` 在独立进程创建生产 WebService、SqliteStore、WorkRunner、OpenAI 兼容适配器与 LocalRuntime。仅模型响应受控；CLI 后端使用既有 `ControlledProcessBackend → runProcess`，确实启动 Node 子进程，在临时工作区追加 `x` 并 fsync，随后退出。该后端只证明实际进程生命周期，不声称原生 OS 沙箱隔离。

测试仅包装本实例公开的 `journal.write`，不在产品代码增加测试 API：

| 屏障 | SIGKILL 前已完成 | 恢复所见 | 必须满足 |
| --- | --- | --- | --- |
| beforeReceipt | CLI 已写入/fsync 并退出，SQLite 保留 running 与租约；尚未调用 settled 写入 | journal 为 spawned，未知效果 | 连续两次 WebService 启动均保留 uncertain、租约和无候选；不调用模型/CLI；公开 review/acknowledge 的可信摘要核对后原父工作续办 |
| afterJournal | settled 日志写入及目录 fsync 已返回，Runner 尚未获得返回值 | journal 为 settled，DB 仍没有结果 | 启动核对用原回执与检查点续办，模型看见真实输出，账本仍只有一个 x |
| stopped | 同 beforeReceipt，恢复后保存 STOP | 未知效果，任务已停止 | 可信核对可以结算效果及租约，迟到成功回执不得形成候选或模型请求 |

父进程收到屏障后向自己创建的宿主进程组发送 SIGKILL，断言退出为 `code=null, signal=SIGKILL`。每轮保存宿主 PID、故障点、退出结果、journal、SQLite 快照/回执/租约、网页宿主投影、模型检查点、账本和清理结果。已结算任务再次打开后不得重复请求模型、执行 CLI 或丢失结算。所有运行只接触本轮临时文件；清理保留证据并删除临时数据库和会话。

```sh
env -u MODEL_API_KEY node --import tsx scripts/verify-local-crash.ts
env -u MODEL_API_KEY node --import tsx scripts/verify-local-crash.ts --negative-controls
```

负对照在 `work/` 的隔离源代码副本将 journal 对未知效果的判断分别破坏为 `notStarted`（盲重放）和伪造已成功回执（错误结算）。两者都必须因 `Unknown CLI effects must remain uncertain` 业务断言失败，不能以超时、类型错误或模块缺失计作检出。源实现不被改写；副本在 finally 删除。

## 验证

- 类型检查：`env -u MODEL_API_KEY node node_modules/typescript/bin/tsc -p tests/tsconfig.json`。
- Gherkin：BT_L05/L06/L11/L14/L73/L74，包含原场景要求和实际故障窗口。
- 原服务启动接线回归：`env -u MODEL_API_KEY node node_modules/vitest/vitest.mjs run tests/local-tools-durability.test.ts --maxWorkers=1`，2 项通过。
- 正向与两项隔离负对照的机器摘要见 [evidence.json](evidence.json)；完整现场证据写入 `reports/kej-103/`，运行脚本会输出精确路径。

依据：[Node fs.fsyncSync](https://nodejs.org/api/fs.html#fsfsyncsyncfd)、[Node 子进程信号与退出](https://nodejs.org/api/child_process.html#subprocesskillsignal)、源码 `CliJournal` 的 fsync/rename 与 `WebService.recoverLocal` 恢复顺序。本验收针对进程丢失和持久化协议，不覆盖硬件断电、磁盘损坏、任意网络副作用回滚或外部提供商恰好执行一次。
