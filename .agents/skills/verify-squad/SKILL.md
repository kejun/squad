---
name: verify-squad
description: "验证 kejun/squad 的真实群聊网页和本地服务。用于改动后的用户流程验收、协助重试或停止恢复回归、报告导出和面板交互检查；隔离运行并保留操作、截图、HTTP 与持久化证据。"
---

# Verify squad

先读仓库 `AGENTS.md` 和[功能地图](features/README.md)，选择与改动对应的功能。网页是主要验收面，HTTP 和 SQLite 用于观察结果；SSR、happy-dom、状态机测试和 demo 提供补充证据。

## Launch

在仓库根目录使用 Node.js 22.18+（22.x）或 24.11+：

```sh
npm ci
npm run build
node .agents/skills/verify-squad/scripts/verify.mjs --help
node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms
```

默认 `rooms` 是最小完整证明。需要运行五组代表流程时，使用 `--feature all`。其他单组参数为 `reports`、`control`、`assistance`、`layout`。

助手每次创建独立临时目录、空 SQLite、随机回环端口和浏览器上下文。将构建目录链接进临时目录后，设置 `WEB_PORT` / `WEB_DATABASE`，启动真实入口 `scripts/web.ts`。ready 日志必须来自本次子进程；随后 Doctor 校验构建与数据库。页面显示「已连接」、新群包含五个成员且 `modelConfigured=true` 后才开始操作。

临时目录没有 `.env`；子进程只收到运行必需的路径变量和本地夹具配置。用户的密钥、数据库和会话不参与。模型仅在生产 OpenAI 兼容 HTTP 边界被替换，真实适配器、预算、状态机、持久化、路由和 React 继续工作。网页工具关闭，夹具不请求技能搜索。供应商质量、认证和真实工具效果需另验。

**浏览器准备。** 优先使用宿主 Playwright：助手依次读取 `SQUAD_PLAYWRIGHT_MODULE`、`CODEX_PRIMARY_RUNTIME_NODE_MODULES/playwright/index.mjs`、项目可解析的 `playwright`。若需安装，把依赖放在仓库外：

```sh
SQUAD_BROWSER_RUNNER=$(mktemp -d)
npm install --prefix "$SQUAD_BROWSER_RUNNER" --no-package-lock --no-save playwright@1.62.1
export SQUAD_PLAYWRIGHT_MODULE="$SQUAD_BROWSER_RUNNER/node_modules/playwright/index.mjs"
node "$SQUAD_BROWSER_RUNNER/node_modules/playwright/cli.js" install chromium
```

默认启动配套 Chromium，已有浏览器时用 `SQUAD_CHROMIUM` 指定绝对可执行路径。先实际启动并记录版本，确认中文可显示。Linux 可检查 `fc-match ':charset=4e2d'`；截图旁的 `*.fonts.json` 记录实际平台字体和 glyphCount。缺中文字形时修复环境再重跑。Google Fonts 请求被阻止并记录，使用系统字体，这不验证远程字体的视觉效果。

## Doctor

助手在启动后、每组流程前和失败后自动运行只读 Doctor：检查拥有的子进程仍存活、ready 日志归属正确、HTTP HTML 与当前 `dist/web/index.html` 一致、只读 SQLite 房间计数与 HTTP 一致。正在运行时，可把实际证据目录的 `instance.json` 路径传给：

```sh
node .agents/skills/verify-squad/scripts/doctor.mjs /absolute/evidence/instance.json
```

用本轮真实清单路径替换该参数。清理后清单过期，Doctor 失败属预期。异常后保留失败证据、清理并重新运行对应组，不附着用户实例。并发运行使用独立 checkout，避免相互替换构建产物。

## Drive

运行 `node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms` 或地图中的对应组。动作和断言维护在 [verify.mjs](scripts/verify.mjs) 的同名函数内，前置条件和入口见地图。只读观察 DOM、剪贴板、localStorage、HTTP 和 SQLite；变更必须经网页。使用 role/name，重复名称限定所在区域，如侧栏 `complementary / 群聊和成员`、时间线 `log / 群聊消息`。点名候选为 option，移动端关闭导航限定侧栏。拖拽坐标只从当次分隔条边界框获取。

仅在本技能目录扩展助手和地图；产品变更另按 `AGENTS.md` 的 Gherkin → 状态图 → XState → 实现 → 验证推进。夹具缺少前提时记录失败与原因，保持原验收标准。

## Evidence

默认保存在 `reports/verify-squad/<UTC时间>-<进程ID>/`；`--evidence` 可指定新的绝对目录，拒绝覆盖已有目录。通过要求：完整退出 0，`run.json.status=verified`，所有选定组进入 `completed`，清理项全部为 true。

- `run.json`：源码 SHA、工作区差异、Node/Chromium 版本、所选流程、Doctor 和清理结果。
- `actions.jsonl` / `trace.zip`：动作、浏览器 POST、DOM 和截图；用对应 Playwright CLI 的 `show-trace` 打开。
- `*.png` / `*.aria.txt` / `*.fonts.json`：操作前后与故障中间态；仅最终截图不足以证明流程。
- `*.snapshot.json` / `rooms.sqlite-proof.json`：用户操作形成的消息、任务、负责人和产物；rooms 比较真实进程重启前后的结果并只读核查数据库。
- `model-http.jsonl` / `server.log`：本地模型请求和应用日志；reports 要求无效 check 输出被重新生成、最终通过且检查额度为 2。
- `clipboard.txt` / `verification-report.md`：真实复制、下载后的逐字读回，必须等于持久化产物源文。

使用合成输入。只模拟模型服务边界；不得拦截 `/api` 伪造成功、直接设置 React 状态、向数据库写预期结果或用内部事件跳过用户流程。证据可能含内容和本地路径，分享前检查。

## Cleanup

助手在成功、失败、SIGINT、SIGTERM 和 180 秒浏览器驱动期限后关闭自己创建的浏览器、应用子进程及模型夹具。应用先 SIGTERM，5 秒后仍未退出才对同一子进程 SIGKILL。移除临时数据库与构建链接，保留证据，并再次检查 `run.json` / `actions.jsonl` 存在。强制 SIGKILL 无法运行清理；残留只按本轮日志确认归属后处置，禁止按进程名批量杀进程。

若创建了 `SQUAD_BROWSER_RUNNER`，最后删除该变量指向的安装目录并 unset；保留证据。浏览器和系统字体安装属于执行环境，助手不删除它们。

## Helpers

- `node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms`：启动 → Doctor → 驱动 → 证据 → 清理。
- `node .agents/skills/verify-squad/scripts/doctor.mjs /absolute/evidence/instance.json`：传入本轮真实清单路径，只读检查正在运行的实例。
- [model-fixture.mjs](scripts/model-fixture.mjs) 由主助手导入启动和关闭，不单独运行；提供故障、取消和格式修复前提。

## Coverage and maintenance

源码覆盖见[地图索引](features/README.md#source-coverage)。`all` 通过仍不等于全部子功能、Gherkin 或真实供应商验收通过。报告实际经过的入口、未执行分支、夹具/执行环境和证据位置。补充检查使用 `npm run check`，分别引用 Vitest、直接执行的 Gherkin 与待验收项；本技能不改 `features/acceptance-gaps.json`，浏览器运行也不是 Cucumber 绑定。

维护时请求 `$create-verification-skill 维护 kejun/squad 的 verify-squad`，遵循[维护流程](references/maintenance.md)，逐文件核对源码并执行所有功能组。

## Source

结构与维护流程改编自 [cursor/plugins pstack](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill)，保留 [MIT LICENSE](LICENSE)。squad 专用助手与断言依据本仓库源码编写。
