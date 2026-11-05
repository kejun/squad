# 状态机调试图优化与验收

2026-11-05。受测代码提交：`a08e0512846b3e7133df6258a75b328ad413f694`，执行最终检查时工作区干净；后续提交仅补充本记录。基线为 main `7e95c0b4ceb6c5226cc8f74f2987ddb78e558a5a`。

## 行为与边界

参考 [pstack Statechart](https://github.com/backnotprop/pstack/blob/main/skills/statechart/SKILL.md)，采用读者用语、条件展开、稀疏概览和真实路径解释。沿用真实 XState 任务机器，不引入 TLC 或额外调度模型，不声称形式证明或最短反例路径。

- 阶段概览包含八个真实状态、18 条聚合局部跨状态连线。节点用中文并保留源码标识；全部分支可分别查看，不再只选择首条。
- 全局 58 条和局部内部处理 36 条不画成跨状态线，明确说明并保留入口。全局进入输入解析的 `analysisReady` 条件、局部重复 STOP 的空处理与结束后 CONTINUE 均可定位。
- 所选步骤路径只接受结构指纹相同的诊断证据，保留自动微步和同状态更新。候选概览一律不标实际命中，避免把全局 RETRY_ASSISTANCE 的真实路径误画成局部 HELP_RESULT 或 WORK_FAILED。
- 步骤身份变化会清除旧的分支选择；历史查看不移动执行头。源码中的 `ended` 可继续，未画成 final。

场景：`features/22_state_debug.feature` 的 BT_V32–BT_V35。交互图和不适用新增 XState 状态的依据：`docs/state-diagrams.md`「调试图的结构与所选步骤」。

## 先行模型门槛

具体 UI 实现前，在原任务模型上执行纯投影及真实沙箱验证：

```sh
node node_modules/vitest/vitest.mjs run tests/task-chart.unit.test.ts --maxWorkers=1
```

12 项通过。覆盖聚合分支与顺序、聚焦范围、真实求助、停止自动微步、拒绝保持当前阶段、重复停止空处理、结束后继续，以及无证据和不同结构版本。随后与既有诊断回归联合执行 17 项通过。`src/task.machine.ts` 本次未改动。

## 最终提交验证

| 检查 | 结果 |
| --- | --- |
| 三组 TypeScript 检查 | `npm run check` 的产品、网页、测试检查通过 |
| 完整 Vitest | 47 文件、595 项通过 |
| 调试 Gherkin | 43 个展开场景、974 步通过，包含 BT_V32–BT_V35 的五个展开场景 |
| 完整 Gherkin | 620 个场景：618 通过、2 失败；14471 步：14464 通过、2 失败、5 因前置失败跳过 |
| 构建 | `npm run build` 退出 0 |
| 真实网页 | 最终提交运行浏览器助手退出 0，`run.json.status=verified`，七组断言通过，四项清理均为 true |

全量 `npm run check` 退出 1，两个失败均来自 `features/24_local_skills_cli.feature` 的原生 CLI 沙箱要求：当前宿主报告 `Required OS namespaces are unavailable` / `CLI_SANDBOX_UNAVAILABLE`。未改动这些场景、要求或排除名单。`npm run coverage:specs` 因这两个未通过的 Gherkin 场景退出 1，不能声称全量覆盖检查通过。

调试场景的可重复命令：

```sh
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/22_state_debug.feature --import 'tests/bdd/*.ts' --format summary
```

浏览器：Chromium `153.0.8010.0`，实际中文字体由 CDP 验证为 Noto CJK。浏览器助手运行真实生产入口、HTTP、SQLite 和 React，仅模型供应商 HTTP 使用既有合成夹具；未验证真实供应商、托管 Inspector 登录或原生 CLI。此次未修改这些接线。

```sh
npm run build
npm run test:debug-browser -- reports/state-debug/new-statechart-run
```

可用 `SQUAD_CHROMIUM` 指向已安装的 Chromium。最终运行证据位于 `reports/state-debug/statechart-20261105-a08e051/`（按仓库规则忽略）：包含 run.json、操作日志、trace、截图、ARIA、中文字体及只读数据库核查。验证了后序分支的键盘选择、全局及内部规则入口、真实停止自动路径、坐标稳定、缩放最小有效字号、390px 窄屏操作、无业务 POST 和 SQLite 保持不变。
