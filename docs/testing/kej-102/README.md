# KEJ-102 原网页契约的真实浏览器绑定

保留 BT_U01、BT_U02、BT_U03、BT_U09 的原编号和全部要求，补齐真实输入干预、等待原因、停止/继续/协助重试、产物来源与版本、活动刷新、宿主断线重连和回执丢失重试。四项现在由默认 Cucumber 直接执行；仅移除了这四项 `manual_browser` 登记，Pi Durable 与金额缺口继续保留。

复用 `.agents/skills/verify-squad/scripts/verify.mjs` 的隔离宿主、生产 HTTP、SQLite、React、截图、trace 和清理。`tests/bdd/browser.steps.ts` 通过有界 IPC 逐条驱动原 Given/When/Then；每一步都执行真实操作或检查实际观察结果。只在模型提供方 HTTP 返回受控协议，不写入期望数据库状态或修改 React 状态。相较重建浏览器框架，这保留了原助手的现成观察与清理边界，并使原契约真正进入默认门禁。

## 实现前门槛

先扩充原四项场景，再更新 README「状态模型」入口和 `docs/state-diagrams.md` 的「网页原契约的浏览器验收」。这是已有 UI 投影与真实依赖接线验证，没有新增业务状态、事件、权限或调度规则；XState 不需变更。

2026-11-09 在基线 `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 上复验真实任务机器的 BT_C01–C08、BT_H10–H15，覆盖输入边界、停止、继续、协助重试与结果交接。未启动网页或请求真实模型/CLI。`src/task.machine.ts` SHA-256 为 `24e1a16651b085a7ba677b366a51a9c29d901860ee707a054d7f4a434390c80e`。

```sh
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features --import 'tests/bdd/*.ts' --tags '@BT_C01 or @BT_C02 or @BT_C03 or @BT_C04 or @BT_C05 or @BT_C06 or @BT_C07 or @BT_C08 or @BT_H10 or @BT_H11 or @BT_H12 or @BT_H13 or @BT_H14 or @BT_H15' --format progress
```

结果：30 场景、1319 步全部通过。原四项在绑定前直接选择执行有 24 个 undefined 步骤，保留红灯证据。新增检查属于真实浏览器、网络和数据库接线检查，没有新增单元测试。

## 直接执行范围

| 场景 | 真实浏览器与持久化断言 |
| --- | --- |
| BT_U01 | 建群、快捷键建群、点名列表与键盘补全、发送、切群、执行中提示、Stop 造成 HTTP 取消、原任务继续、真实输入解析后交接补充及等待回复、从原求助按钮重试 B 并只交回 A 一次 |
| BT_U02 | 运行→等待协助→完成持续更新同一个 DOM 状态行；精确五条实际消息的种类、作者、正文和顺序；生产本地 `listSkills` 的原始记录不泄露到时间线，默认折叠且可展开来源 |
| BT_U03 | A 实际拥有工具开始/结果、格式修复错误、输出和产物；任务/成员共用详情区域；调度原因、来源可查；隐藏推理不是必需字段；原产物与引用修订产物经任务/成员及来源入口往返，固定源 task/artifact/revision，原文保持不变 |
| BT_U09 | 活动任务刷新保持身份；对本轮宿主 PID 发 SIGKILL；页面经历至少两次真实失败轮询且不新增进展或假装仍工作；原页面自动重连同库恢复同一工作；真实提交响应被丢弃后，通过浏览器原请求 ID 重试，消息/任务/负责人工作各保存一次 |

回执丢失检查先用 `route.fetch()` 让生产服务实际提交，再丢弃该响应，不伪造 API 成功。恢复检查重新启动本轮隔离宿主，不附着用户实例。`listSkills` 只用于实际本地工具接线与记录，不执行外部 CLI。

## 可复跑门禁与构建证明

```sh
npm run check
# 或只执行默认 Gherkin（入口会构建当前源码）
npm run test:bdd
# 独立复跑四项时先构建，再按原编号选择
npm run build
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features --import 'tests/bdd/*.ts' --tags '@BT_U01 or @BT_U02 or @BT_U03 or @BT_U09' --format progress
# 对实际产品作隔离故障检出，最后恢复并重跑四项
node .agents/skills/verify-squad/scripts/negative.mjs
```

需要 Playwright 与 Chromium；系统浏览器可用 `SQUAD_CHROMIUM` 指定，模块可用 `SQUAD_PLAYWRIGHT_MODULE` 指定。CI 固定 Ubuntu 22.04、Node 24.22.1、Playwright 1.62.1、其配套 Chromium 和 fonts-noto-cjk。浏览器契约在默认 BDD 中执行，未另加排除标签。CI 保存 Cucumber、覆盖报告、HTTP/SQLite、截图、trace 与清理记录。

构建前后 HEAD 和所有构建输入摘要必须一致，才生成 `dist/web/build-proof.json`。启动验收时再次比较 HEAD、源码输入和实际资源摘要；Doctor 再比较真实 HTTP 页面与当前 bundle、当前拥有的 PID 和 SQLite/HTTP 房间数。`run.json` 记录源码 SHA、工作区差异、脚本摘要、Node/Chromium 版本、原场景及逐步通过记录。每张截图有实际中文字体 glyphCount 检查，不能用空字体或旧 bundle 证明当前源码。

## 已执行证据

实现提交 `06f0e383f5a6ba78b715af6f19f5dfd2435ba87f`；严格负对照收尾提交 `443476a`。以下是本分支执行记录，集成分支还需以其最终 SHA 运行完整门禁。

- 模型门槛：30 场景、1319 步通过；测试 TypeScript 配置通过。原始日志与绑定红灯保存在 `reports/kej-102/`。
- 四项正向：4 场景、180 步通过，34.7 秒。随后在已提交实现的隔离工作树恢复后再次四项全绿，包含同 SHA 的构建证明。
- 原五组代表流程：`--feature all` 完整退出 0；rooms/reports/control/assistance/layout 全部 completed，`run.status=verified`。证据：`reports/verify-squad/2026-11-09T02-34-36.830Z-14487/`。
- 8 项故障检出：`reports/verify-squad-negative/2026-11-09T02-33-55.840Z-13253/negative.json`。八项均成功构建、正常退出 1、signal=null，由目标原 Gherkin 的第一个失败步骤检出；不是编译失败或外层进程超时。逐份读回八个负向 manifest，均 failed 且清理全 true；恢复后四份均 verified 且清理全 true，故障工作树已移除。
- 严格入口追加烟测：`reports/verify-squad-negative/2026-11-09T02-38-02.459Z-19719/`，状态行破坏被正常业务失败检出；该入口强制检查进程正常退出和全部负向清理，再恢复原四项全绿。
- 执行环境：Node v24.22.1、Playwright 1.62.1、Chromium 155.0.8059.79，截图实际使用 Noto Sans CJK 字形。每次运行保留截图/trace、服务日志、模型 HTTP、快照和只读 SQLite 证据。上述早期清理字段只覆盖当时已登记的检查，后代进程保证由下方补验取代。

| 隔离产品故障 | 被原契约检出的行为 |
| --- | --- |
| 去掉活动输入提示 | BT_U01 无法观察到「补充当前工作」 |
| 活动任务禁用输入框 | BT_U01 无法真正提交中途补充 |
| 以 phase 为状态行 key | BT_U02 更新时更换原 DOM 状态行 |
| 将状态另渲染为群消息 | BT_U02 时间线多出非实际发言 |
| 工具记录默认展开 | BT_U02 折叠契约失败 |
| 来源链接指向错误任务 | BT_U03 无法回到原报告版本 |
| 离线仍显示工作动画 | BT_U09 宿主离线投影错误 |
| 每次重试生成新消息 ID | BT_U09 原请求去重身份丢失 |

本票不验证真实供应方的回答质量、Pi Durable、金额、硬件断电或外部 CLI 恰好执行一次，也不把五组代表流程扩大为全部网页功能验收。

## 宿主后代进程清理补验

最终交叉审查发现，早期 `tsx` 启动方式可能留下独立编译服务，单看父 PID 退出不足以证明清理完成。改用 Node `--experimental-transform-types` 和共享的绝对路径 `tests/fixtures/typescript-loader.mjs` 后，新增进程组检查又实际检出了本环境沙箱探测留下的 `bwrap` 孤儿僵尸。因此没有将「父退出」放宽成「清理成功」。

实现提交 `5d7990c1791e604a99da54b83c97b09d6194d151` 使用一个专用 Python 3 监督器：监督器与真实 Node app 分别拥有独立进程组，Linux 监督器设置 subreaper；只等待和回收它创建的应用及其后代。停止/离线 SIGKILL 只发送到本轮登记的应用组，监督器留在组外完成 `waitpid`。所属验证器丢失或关闭输出管道时触发有界清理；后代若另建会话，最后的有界回退也只处理监督器自己收养的直接后代。无需改变生产沙箱、能力探测或工具权限。

Doctor、ready 和 `instance.json` 使用真实 Node PID；`run.appProcesses` 分别保存实际 app PID/PGID、实际退出码/信号、supervisor PID/PGID、监督器正常退出及已回收 PID。Node app 和监督器的实际 PGID 均须等于各自 PID，所有登记组都完全消失后才记录 `cleanup.processGroupGone=true`。loader 与监督器源码摘要也随运行记录；loader 读取在受保护的启动阶段内，缺失时仍进入清理。

补验结果：

- 原四场景直接执行 4/4、180/180 通过；随后在已提交 `5d7990c` 的隔离工作树再次完整恢复重跑四项全绿。
- 同一已提交 SHA 的原五组 `rooms/reports/control/assistance/layout` 全部通过，证据为 `reports/verify-squad/2026-11-09T02-54-23.869Z-29168/`。三次实际应用启动和各自监督器均退出并回收，最终 `processGroupGone=true`。
- 离线故障检出及恢复：`reports/verify-squad-negative/2026-11-09T02-53-41.776Z-28677/negative.json`。`offline-working-spinner` 被 BT_U09 的原业务断言检出，正常退出 1；负向 app 28780 实际 SIGKILL，supervisor 28779 正常退出并回收 28794/28780，负向清理全部通过。恢复原实现后四项全部 verified。
- 恢复后的 U09 中，真实 Node app 30526 实际因 SIGKILL 退出，supervisor 30525 回收 app 与探测后代 30541 后正常退出；重连后的 Node 30853 与 supervisor 30852 同样清理完成。逐份读回负向、恢复四项和五组回归的所有清单，并向其登记 PGID 作只读存活检查，均确认进程组已经不存在。
- 外层失败检查故意提供不存在的浏览器模块。验收正确失败，但 Node 28632、探测后代 28646 由 supervisor 28631 回收，监督器正常退出，全部清理字段为 true；证据 `reports/verify-squad-supervisor-failure/1794192801560/`。这项仅证明外层启动失败的清理，不计为产品场景通过。
- 异常收尾控制：在全部后代已回收后故意令监督器退出 17，再触发外层浏览器导入失败。验证器正常退出 1并保留 failed 与明确的监督器错误，但仍关闭模型夹具、确认 owned 组消失后删除临时目录；`fixtureClosed/processGroupGone/stateRemoved` 均 true。证据 `reports/verify-squad-supervisor-failure/1794193150388/`。若组退出无法证明，则保留可能仍活动的数据库，不伪造清理完成。故障脚本随后恢复。
- 日志、Cucumber 与跨清单读回结果：`reports/kej-102/native-process-cleanup/`。本地监督器使用 Python 3.12.14；Linux CI 显式准备 Python 3。

早期无 subreaper 的失败轮留下了已由 PID 1 收养的僵尸；当前父进程不能对这些历史进程调用 `waitpid`，它们没有计入新运行的清理保证。没有操作 PID 1 或无关进程，也不声称整个执行环境全局零残留。本票的新保证严格限定为每次清单登记的 app、supervisor 及其后代；这些补验均已完成回收。

## 操作与判断记录

1. 阅读四项原契约、现有助手/夹具、生产网页与服务、仓库工作流和 Uncle Bob 规则；确认已有助手只覆盖代表流程，不能直接撤销登记。
2. 保留原要求并补充缺失边界，先写交互图和复验真实任务模型，再实现逐步浏览器接线。
3. 以实际失败定位夹具问题：工作区与服务目录必须分离；补充中的「必须」应经过真实输入解析；HTTP 完成后要等待 React 当前任务投影再点击详情。保持生产保护和原验收标准。
4. 运行四项完整正向、原五组回归、八项隔离产品破坏与恢复；保留各次失败和清理证据。
5. 只在完整直接执行通过后移除四项登记，更新覆盖范围、构建绑定、字体断言、CI 环境和原始证据保留；按审查补强外层退出、目标失败与负向清理校验。

依据：[Cucumber 行为表达](https://cucumber.io/docs/bdd/better-gherkin/)、[Gherkin 步骤语义](https://cucumber.io/docs/gherkin/reference/)、[Playwright 浏览器安装](https://playwright.dev/docs/browsers)、[Playwright tracing](https://playwright.dev/docs/trace-viewer)。
