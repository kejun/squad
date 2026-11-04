# 按次宿主 CLI 授权验证

基线：`3695dc6673b4a10f321f395f156eef3a9b13d966`，2026-11-04。场景 BT_L23–BT_L30，状态图见 [宿主命令按次授权](state-diagrams.md#宿主命令按次授权)。

## 实现前模型门槛

在接入进程、HTTP 或网页之前运行真实 taskMachine，每步 persistTask / restoreTask；无真实文件、进程、数据库、网络或模型 I/O。

命令：`node node_modules/vitest/vitest.mjs run tests/host-approval-model.unit.test.ts tests/local-operation-model.unit.test.ts --maxWorkers=1 --reporter=verbose`。

结果：55/55 通过（新增16项、原有39项），完整退出0。轨迹：请求→预备领取→awaitingApproval→批准→重新领取→running→succeeded；拒绝直接失败并保存模型回执；停止/过期/错标识/旧目标拒绝；RECOVER 使未消费批准重新等待并更换标识，已领取命令保持 uncertain 待核对。

受测 SHA-256：

- task.machine.ts：`24e1a16651b085a7ba677b366a51a9c29d901860ee707a054d7f4a434390c80e`
- local-operation.ts：`b3b31894755fb6f8d0ffa6350a9353e74477ec9913d040416c0b517ec41b7384`
- task/lifecycle.ts：`bc45b38da77fefdaf156aeaebdd4e19b49a0eaf602c07c137e51f67b1a10cdcf`

工作区与可执行文件变化属于后续 I/O 接线验收，不把模型测试当作真实宿主执行证据。

新增三类事件共六条有序规则，图结构指纹从 `c757a33d` 变为 `5011474c`。历史契约文件不修改：兼容断言显式列出这六条新增规则及新指纹，仍逐项核对全部旧规则与诊断轨迹、守卫、微步和持久快照，不重新生成基线或过滤未知差异。

后续核查崩溃窗口时补充“确认未启动也重新批准”场景，先修订 Gherkin 和图，再修订纯模型并复跑同一模型门槛：56/56通过（新增17项、原有39项），local-operation.ts SHA-256 为 `358d692692d48240840592b7b9225da2f21105396e3bd079483d136441e8f11c`；通过后接入相应恢复路径验收。

## 集成验收

| 检查 | 结果与边界 |
| --- | --- |
| 三项 TypeScript（服务、网页、tests） | 全部通过 |
| 全量 Vitest | 43个文件、555/555通过；含真实HTTP、SQLite、模型动作协议、真实宿主子进程、跨输出块的凭据脱敏及React操作 |
| 专项直接 Gherkin | BT_L23–BT_L30，共13个场景展开用例、279/279步骤通过；未登记或跳过新场景 |
| `npm run build` | 通过；保留依赖已有的Rollup注释提示 |
| 全量 `npm run check` | 未通过：全量Gherkin执行604个用例，602通过，BT_L19/BT_L22因当前Linux宿主缺少OS命名空间能力失败；原生沙箱检查退出78。保持必需检查和原断言，不修改排除登记、不回退宿主伪装沙箱通过 |
| 真实浏览器 | Chromium 153.0.8010.0，实际中文字体Noto Sans CJK SC；完整生产入口、模型HTTP夹具、React、HTTP授权、真实宿主命令及SQLite证据；桌面和390px手机宽度均检查 |

浏览器命令：`SQUAD_PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs SQUAD_CHROMIUM=/absolute/path/chromium node scripts/verify-host-approval.mjs`。省略二进制参数时使用Playwright配套Chromium。

浏览器逐项验证：自动弹窗；完整参数和目录；Escape仅关闭并可重开；刷新不触发模型重试；拒绝不产生写入；允许本次后真实命令只执行一次；优雅重启保留等待并更换批准标识；重新点击后才执行；手机无横向溢出。运行报告为 `verified`，浏览器、生产服务子进程、模型夹具和临时状态四项清理均为true。截图已目视核对。

这次实际平台为Linux；host模式的真实执行不依赖不可用的Linux沙箱。没有在macOS实机重测新的宿主模式、钥匙串或TCC授权；这些仍使用服务账号及其系统权限，不能以夹具验证替代。
