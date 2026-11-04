# 技能搜索域名来源兼容验证

> 本页保留当时实跑的命令和数量。2026-10-30 测试治理后的文件对照、当前入口与数量见[测试治理记录](test-governance.md)；历史结果不代表当前用例数量。

后续 macOS 本地工具适配已使全量检查和隔离网页验收通过，最新结果见 [macOS 验证记录](macos-local-tools-verification.md)；下文保留技能搜索修复时的分阶段结果。

2026-10-30，BT_M21、BT_M22。真实日志在 07:41:48 搜索 `general purpose assistant skills`，07:41:50 因 `Invalid skill search result` 结束。修复前用相同查询直接调用 `findSkills` 复现：HTTP 200 的七项结果中含 `source=skills.volces.com`，旧正则只接受 `owner/repo`。

按功能变更工作流，先完成 `features/11_model_protocol.feature` 场景和 README 状态模型入口、`docs/state-diagrams.md#技能搜索结果解析`，再于具体解析修复之前运行下述模型验证。数据格式不产生新的业务状态，沿用既有 XState，不修改 `src/task.machine.ts`。

## 实现前模型门槛

- 受测版本：`b3502f19f8f6136cb8b818a526bab8885cb9f82e`。
- `src/task.machine.ts` SHA-256：`dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`。
- 命令：`node node_modules/vitest/vitest.mjs run tests/skill-search-model.test.ts --maxWorkers=1 --reporter=verbose`。
- 结果：7/7 通过；测试直接运行真实 `initialTask` / `stepTask`，每一步经过 `persistTask` / `restoreTask`，无网页、执行器、模型或工具 I/O。

关键轨迹：

| 分支 | 事件与断言 |
| --- | --- |
| 仓库、域名成功 | CLAIM → CONSUME（初次模型预占）→ CONSUME（搜索）→ CONSUME（续答）→ DELIVER；普通额度 1→1→2→3，checking 且只有一个待领检查，无安装意图 |
| 畸形结果 | 搜索获准后 WORK_FAILED；waitingHuman、普通额度2、重试0、无候选；重复失败不能再次结算 |
| 额度 | 普通额度上限1，搜索 CONSUME 被 BUDGET_EXHAUSTED 拒绝，不增加 requestCount |
| 停止 | 搜索获准后 STOP；保存取消意图，后续请求被拒，迟到交付不生成候选 |
| 版本隔离 | 旧 goalVersion 的 DELIVER 被 STALE_FENCE 拒绝 |
| 恢复 | RECOVER 将原安全意图回到 pending；重新 CLAIM 前拒绝 CONSUME，领取后普通额度3、attempt2、没有重复 owner 意图 |

## 集成验证

| 层级 | 可重复命令或证据 | 结果 |
| --- | --- | --- |
| 技能解析与模型执行器 | `node node_modules/vitest/vitest.mjs run tests/skills.test.ts --maxWorkers=1 --reporter=verbose` | 11/11；混合来源成功，三种畸形项失败，既有额度、停止及撤销恢复测试通过 |
| 模型适配器回归 | `node node_modules/vitest/vitest.mjs run tests/model-adapter.test.ts --maxWorkers=1 --reporter=verbose` | 28/28；在首次针对性运行中通过 |
| HTTP、真实执行器与 SQLite 日志 | `node node_modules/vitest/vitest.mjs run tests/skill-search-web.test.ts --maxWorkers=1 --reporter=verbose` | 1/1；真实 HTTP 建群和发消息，边界替换模型及技能 API，持久日志出现两类技能且无错误，任务 complete，普通额度3、检查额度1 |
| 新场景直接 Gherkin | `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features --import 'tests/bdd/*.ts' --tags '@BT_M21 or @BT_M22' --format progress` | 4/4 展开用例、69/69 步骤通过；标签仅用于定向复验，新增场景仍默认进入完整执行 |
| 真实公网技能 API | 用原查询调用真实 `findSkills`，20秒超时 | 返回7项，含域名来源，安装量排序正确；没有调用付费模型或更改用户任务 |
| 构建 | `npm run build` | 通过；只有既有第三方注释警告 |
| 完整检查 | `npm run check`，终端日志 `/tmp/squad-skill-search-check.log` | 三项 TypeScript 检查通过；Vitest 450项中412通过、38失败，失败集中在既有 local-tools 两个文件，与初次调研看到的38项失败一致；失败阻止脚本继续执行 Gherkin 和覆盖报告 |
| 单独完整 Gherkin | `npm run test:bdd`，终端日志 `/tmp/squad-skill-search-bdd.log` | 514用例中482通过、32失败；BT_M21/M22全部直接通过，无新排除或 acceptance gap |
| 隔离网页 | `SQUAD_PLAYWRIGHT_MODULE=/Users/haoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms` | 未完成；隔离实例默认启用本地CLI，macOS启动阶段因 `/proc/self/ns/pid` 缺失退出，尚未操作浏览器 |

全量失败都报告 `SKILL_PATH_ESCAPE` 或 Linux 进程命名空间 `/proc/self/ns/pid` 缺失。本次不修改本地 CLI 或验收排除规则，不能宣称全量检查或浏览器通过。HTTP 集成测试在隔离 SQLite 中执行，不操作用户实例。浏览器失败及完整清理证据保留于 `reports/verify-squad/2026-10-29T23-47-41.305Z-16778/run.json`，四项清理均为 true。

上游限制：搜索记录中的域名来源详情链接沿用 CLI 的 skills.sh 路径规则，实测该域名技能详情页返回404。搜索解析成功不代表上游详情页可用，也不表示已安装或执行该技能。

## 本机服务

修复后以 `SQUAD_DEBUG=1` 优雅重启，PID `15790` → `16894`。原 `.env` 的 `localTools.enabled=false` 保持生效。首页、`/api/debug`、群列表和原群快照均返回200，调试为true，原有3个群聊保留。

失败任务 `task:524f13ac-d2aa-4fc8-a953-328d68fec762` 仍处于 waitingHuman，历史错误和已用额度保留；本次未冒充用户提交继续命令。用户可在原群明确发送“继续”后按现有状态机重试。
