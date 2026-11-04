# 官方 Inspector 标签页与连接验收

> 本页保留当时实跑的命令和数量。2026-10-30 测试治理后的文件对照、当前入口与数量见[测试治理记录](test-governance.md)；历史结果不代表当前用例数量。

2026-10-30，基于 main `b3502f19f8f6136cb8b818a526bab8885cb9f82e` 及当前工作区。当前版本改为点击入口打开独立标签页，保留原机器注册顺序修复，不改变业务任务、预算或执行器。

## 401调查与处理

真实响应来自官方托管 `machines.getDigraphConfigs`，HTTP 401 / UNAUTHORIZED，消息是 `Sign in to view hosted work`。原iframe与独立顶层匿名标签页均重现该响应，因此已确认需要Stately有效认证，不能把“改成新tab”本身当成认证修复。缺少或失效的登录、以及嵌入环境无法携带有效会话，都可能造成匿名请求；本次未使用用户账号，不能断言用户是否已登录或具体Cookie限制。

推荐操作：在[官方登录页](https://stately.ai/registry/login)完成登录，保持本地调试面板打开，再刷新Inspector标签页；如果浏览器阻止新标签页，允许后再次点击入口。只有实际登录后的官方绘图接口成功，才可确认401已消除。顶层标签页让认证运行在Stately第一方上下文，避免把登录交互放在本地页面的跨站iframe中。

采用官方支持的新标签页接入，继续使用 `@statelyai/inspect@0.7.2` 和实际可用的 `https://stately.ai/inspect`。文档中提到的 `/inspector` 当前实测404，未将运行地址改为该路径。没有增加代理、复制登录Cookie、传入本地模型密钥或升级到另一个SDK。迁移到新SDK或自托管编辑器需要另一套传输与认证，超出此次需求。

依据：[官方Inspector说明](https://stately.ai/docs/inspector)明确支持新标签页或窗口；[SDK浏览器接收器源码](https://github.com/statelyai/inspect/blob/main/src/browser.ts)顶层时使用 `window.opener`、嵌入时使用 `window.parent`；[MDN 401说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/401)说明认证语义；[Window.open说明](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)说明用户激活、默认标签页与弹窗阻止。认证判断的直接证据为本次 `inspector-graph-responses.json`，不是由状态机异常推测。

## 场景、状态图与模型门槛

先更新 `features/22_state_debug.feature` BT_V27–BT_V28 的目标窗口约束，新增BT_V29（新标签页、复用及登录提示）、BT_V30（弹窗阻止与最新选择重试）、BT_V31（身份切换、关闭重开及卸载隔离）。全部默认绑定执行，没有新增排除或延期。

先更新 `README.md`「状态模型」入口及 `docs/state-diagrams.md`「官方Inspector观察通道」，再更新 `src/inspector.machine.ts`。标签页模型closed/opening/open/blocked/disposed，观察连接waiting/connected/closed；窗口副作用只消费纯模型意图，不增加业务任务状态。

实现前命令：`node node_modules/vitest/vitest.mjs run tests/inspector-model.test.ts --maxWorkers=1`，8/8通过、退出0。受测模型SHA256：`0c9ba840dd017b3149dfae33186ea850376c35048eb43da52a57a8618cc000f5`；业务 `src/task.machine.ts` 仍为 `dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`。

轨迹包括closed→opening→blocked→opening→open，重复OPEN只生成focus，WINDOW_CLOSED后重开，DISPOSE吸收迟到事件；SELECT在已连接通道先注册新身份再发送快照，握手来源不符不发送。复验真实STOP→ended，原快照和预算不变。门槛通过后才实现同步点击打开、延迟加载SDK、目标校验和清理。

## 当前集成验收

`npm run build`、`npm run check` 均退出0。三组TypeScript检查、471项回归测试通过；524个Gherkin场景、9676步骤直接执行通过。既有18项场景定义/26个展开实例延期保持不变。

针对BT_V27–BT_V31直接执行：`TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/22_state_debug.feature --import 'tests/bdd/*.ts' --tags '@BT_V27 or @BT_V28 or @BT_V29 or @BT_V30 or @BT_V31' --format progress`，6场景/114步骤通过。真实React交互使用受控窗口测试弹窗被阻止、原点击栈调用open、重试后最新选择、身份切换、旧窗口来源拒绝及卸载前SDK导入竞态；纯协议测试使用真实官方SDK。

实际浏览器命令：

```sh
SQUAD_PLAYWRIGHT_MODULE=/Users/haoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs SQUAD_VERIFY_INSPECTOR=1 npm run test:debug-browser
```

证据：`reports/state-debug/2026-10-30T00-39-31.284Z/`。`run.json.status=verified`，四项清理为true；此状态只代表已列出的本地交互和官方协议检查通过，官方绘图状态另行记录。

- 生产入口、HTTP、React和SQLite全部真实运行在隔离实例；模型HTTP边界使用合成夹具，无用户账号或任务参与。
- 真正的新标签页满足top===self、opener存在，本地没有iframe；重复点击不新增页面或导航，保留本地当前运行视图。
- 官方首包包含真实机器定义，后继快照关联已注册actor；重置后继续更新，刷新新标签页重新注册同一actor。
- 切换沙箱在同一标签页注册新actor，导航次数增量为0；关闭标签页后可以再次打开，关闭本地面板发送disconnected并保留用户标签页。
- 没有额外业务POST，SQLite逐字不变；本地图、历史分叉、STOP自动微步、布局回归通过。官方页面本轮捕获的错误为0。
- `inspector-tabs.json`、`inspector-messages.json`、`inspector-reconnected.json`保留协议证据；`official-inspector-local.png`和`official-inspector-tab.png`已查看，确认本地界面仍可用、匿名官方画布为空。

**未验证范围**：顶层匿名标签页仍返回官方401，`run.json.hostedGraph.status=not_verified`。需要用户在官方页面登录；本次没有假造成功响应、使用用户会话或宣称登录后的图形渲染通过。当前4318端口已提供新构建，刷新本地页面后使用新入口。

React复核依据 `vercel:react-best-practices`：打开动作位于点击处理器，重SDK按需导入，监听与关闭检测可释放，StrictMode挂载不创建窗口，图标有可访问名称，组件不调用真实任务actor。

## 历史：iframe机器注册修复

2026-10-30，基于 main `b3502f19f8f6136cb8b818a526bab8885cb9f82e` 及当前工作区。本次修复 `Cannot read properties of undefined (reading 'config')`，不改变业务调度或任务预算。

### 原因与方案

实测官方 iframe 在 `load` 之前发送 `@statelyai.connected`。当前 `@statelyai/inspect@0.7.2` 的 BrowserAdapter 到 `load` 才设置目标窗口，因此在早握手时丢失队列中的机器注册和首帧。重置后页面只收到 `@xstate.event`、`@xstate.snapshot`，没有对应 actor 的 machine，触发 `.config` 异常。注册消息本身的真实机器定义没有缺失。

复用官方 `createInspector` 手动发送接口和真实 `taskMachine` 定义，替换 iframe 传输层。监听先于导航安装；指定 iframe 和 `https://stately.ai` 来源通过校验后，先注册机器，再发送最新事件与快照。重连重新注册，关闭移除监听，异步加载及旧通道的迟到更新不发送。元数据业务 actor 从不 start 或 send；观察通道仅执行独立纯 XState 模型产生的瞬时发送意图，不接入 WorkRunner 或业务 SQLite。

参考：[官方手动发送与 iframe 接入说明](https://stately.ai/docs/inspector)、[官方 SDK 源码](https://github.com/statelyai/inspect/tree/main/src)。实际判断依据同时包括仓库安装版本的 `node_modules/@statelyai/inspect/dist/index.mjs` 及真实托管页面的收包结果。

### 设计与模型门槛

- 场景：`features/22_state_debug.feature` 的 BT_V27（两种握手时序）、BT_V28（来源拒绝、重连与关闭）。全部绑定默认 Gherkin 执行，没有新增排除或验收缺口。
- 状态图：`README.md`「状态模型」入口、`docs/state-diagrams.md`「官方 Inspector 观察通道」。纯观察状态为 waiting → connected → closed；任务沿用真实业务状态。
- 在具体适配器和 UI 实现之前，执行 `node node_modules/vitest/vitest.mjs run tests/inspector-model.test.ts --maxWorkers=1`，4/4 通过，退出0。
- 受测观察模型 `src/inspector.machine.ts` SHA256：`5d1de84111e5c088ebfe85e77956f6ff731b2b41995001df0e358f631b57a1be`。业务模型 `src/task.machine.ts` SHA256：`dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`，本次未修改。
- 轨迹：握手前 UPDATE 只替换最新选择；可信 CONNECT 产生 register；connected UPDATE 产生 update；来源不符无新意图；重连再次 register；CLOSE 后不再响应迟到更新。复验真实 STOP → ended，原任务快照和预算不变。

### 接入验证

`npm run build`、`npm run check` 均退出0：三组 TypeScript 检查通过，463 项回归测试通过；521 个 Gherkin 场景、9617 个步骤直接执行通过。已有18项场景定义（26个展开实例）仍按仓库原有登记延期，本次未增减。新场景另执行 `node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/22_state_debug.feature --import 'tests/bdd/*.ts' --tags '@BT_V27 or @BT_V28' --format progress`，3场景、55步骤通过。

`tests/inspector-bridge.test.ts` 使用真实官方 SDK 校验首包机器定义、sessionId 与注册顺序，包含导航时立即握手、延迟握手、来源拒绝、重连、身份替换和关闭；对业务 Actor.start/send 的侦测均为零。

实际浏览器命令：

```sh
SQUAD_PLAYWRIGHT_MODULE=/Users/haoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs SQUAD_VERIFY_INSPECTOR=1 npm run test:debug-browser
```

证据：`reports/state-debug/2026-10-30T00-27-27.733Z/`，`run.json.status=verified`，应用、HTTP 模型夹具、浏览器及临时数据清理均为 true。此状态表示已列出的本地交互与官方协议检查通过，官方绘图结果另存于 `hostedGraph`。

- 隔离运行生产入口、真实 HTTP/SQLite/React；只向官方页面传递合成验收数据，没有使用用户账号或用户任务。
- 官方 iframe 实际收到的首包为含真实定义的 `@xstate.actor`，后继事件和快照关联同一 sessionId。重置能够继续更新；iframe 重载重新注册同一 actor；切换现有沙箱注册新的 actor；切回本地视图移除 iframe。未复现原 `.config` 异常。
- 本地图、历史分叉、STOP 自动微步、移动布局继续通过；观察与沙箱没有业务 POST，真实 SQLite 内容逐字保持不变。
- `inspector-messages.json`、`inspector-reconnected.json` 保存收包；`official-inspector*.png` 保存实际页面；`inspector-errors.json` 保留托管页面诊断，导航时可能出现官方捕获的 `Failed to fetch`，未将这些网络日志冒充绘图成功。

**未验证范围**：匿名浏览器的官方 `machines.getDigraphConfigs` 返回 HTTP 401，响应为 `Sign in to view hosted work`。因此 `run.json.hostedGraph.status=not_verified`，未确认登录后的官方图形渲染。具体响应保存在 `inspector-graph-responses.json`；没有伪造官方接口或绕过登录。协议修复已由真实页面收包验证，本地完整状态图可以正常使用。

现有 `127.0.0.1:4318` 服务已读取新构建的前端资源，刷新页面后生效。
