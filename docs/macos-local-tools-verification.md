# macOS 本地工具适配验证

> 本页保留当时实跑的命令和数量。2026-10-30 测试治理后的文件对照、当前入口与数量见[测试治理记录](test-governance.md)；历史结果不代表当前用例数量。

需求：在本机 macOS 开启本地技能和 CLI，继续使用原生沙箱、持久化领取、最小环境、停止和不确定效果核对；不迁移 Linux，不提供无沙箱回退。复用固定 SRT 的 macOS 后端，比新增容器或另一套执行框架更小；进程身份采用系统 libproc，避免秒级 ps 时间的 PID 复用误判。macOS 需 `/usr/bin/python3`、sandbox-exec 及 SRT 依赖，Linux 原后端保留。

先补 BT_L19–BT_L22 场景、README 状态入口和 `docs/state-diagrams.md#本地工具宿主启动与平台边界`，再复验真实 XState，无需新增业务事件或状态。

## 实现前模型门槛

- 版本：`b3502f19f8f6136cb8b818a526bab8885cb9f82e`。
- task.machine.ts SHA-256：`dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`。
- local-operation.ts SHA-256：`57a5f88c8a8640d99dfe98166cdf40e371d30717e9ba1ddcbe38658f6ce39fce`。
- 命令：`node node_modules/vitest/vitest.mjs run tests/local-operation-model.test.ts --maxWorkers=1 --reporter=verbose`。
- 结果：15/15 通过。逐步运行真实 taskMachine 并持久化/恢复快照；无模型、CLI 或网页 I/O。覆盖保存→领取→启动→成功、沙箱不可用失败回执、额度/权限/版本拒绝、停止及迟到结果、崩溃各窗口、不确定效果与可信回执、技能版本绑定和检查复核。

宿主锁与系统路径是 I/O 契约，不引入伪业务状态；其原生集成验证在上述门槛通过后进行。

## 集成结果

| 层级 | 命令与证据 | 结果 |
| --- | --- | --- |
| 原有本地工具集成 | `node node_modules/vitest/vitest.mjs run tests/local-tools.test.ts tests/local-tools-durability.test.ts --maxWorkers=1` | 59/59通过，原先 macOS 的 `/proc` 与目录别名失败消除 |
| 新原生宿主集成 | `node node_modules/vitest/vitest.mjs run tests/native-local-tools.test.ts --maxWorkers=1 --reporter=verbose` | 4/4通过；真实 WebService、SQLite、生产沙箱和 Node 技能脚本，一次写入、三项成功回执与最终交付；进程身份、活跃/旧/未知锁、探测失败不留空锁、别名和逃逸拒绝 |
| 新 Gherkin 直接执行 | `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features --import 'tests/bdd/*.ts' --tags '@BT_L19 or @BT_L20 or @BT_L21 or @BT_L22' --format progress` | 4/4用例、69/69步骤通过；仍默认进入完整 Gherkin 执行，不增加排除标签 |
| 真实原生沙箱 | `npm run verify:local-sandbox` | 通过：工作区写入，包外和 `.env` 读取拒绝、技能快照写入拒绝、宿主环境不继承、确定可达的本地监听端口在沙箱中连接被拒、check源文件只读且输出可写、取消长命令和子进程并保留 effectsKnown=false |
| 全量门禁 | `npm run check`，完整终端日志 `/tmp/squad-macos-check.log` | 三项TypeScript检查、456/456 Vitest、518/518直接Gherkin（9044步骤）全部通过，生成覆盖报告；26个已有待验收用例保持原登记 |
| 构建 | `npm run build`，`/tmp/squad-macos-build.log` | 通过，保留既有第三方注释警告 |
| 隔离网页 | `SQUAD_PLAYWRIGHT_MODULE=/Users/haoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms` | verified；建群、点名/默认路由、切群、离线和真实进程重启持久化；Doctor全部通过，四项清理全部true |

浏览器证据：`reports/verify-squad/2026-10-30T00-03-03.288Z-19210/`，Chromium `151.0.7922.34`。已目视检查 `rooms-after-restart.png`，中文显示正常。网页验收使用隔离模型HTTP夹具；真实CLI和OS边界由上述原生服务与沙箱集成执行，未宣称浏览器夹具调用了CLI。未运行其余四组网页流程。实际平台为 macOS；Linux 保留既有分支，本轮没有Linux真实沙箱执行证据。

## 本机开启与重启

`.env` 将现有 `SQUAD_LOCAL_TOOLS_ENABLED=false` 改为 `true`，持久生效；进程继续使用 `SQUAD_DEBUG=1`。优雅重启 PID `16894` → `19529`，首页、调试和群列表返回200，原有3个群聊保留。

启动日志为 `Local skills: 3 on first page; CLI sandbox: ready`，服务锁为当前 macOS 进程的有效原生身份。原 `.squad-local/service.lock` 是2026-10-29遗留的0字节文件，没有文件持有者且旧服务未启用本地运行时；原样归档为 `.squad-local/service.lock.legacy-empty-20261030T000400Z` 后启动，不删除历史回执或任务。

当前全局配置与所有成员默认开启；已结束任务仍保留当时的权限快照，不重写历史，也不替用户发送消息或启动模型请求。后续任务继承开启配置。默认每群/任务使用隔离工作目录，未扩大为读取整个宿主工程。
