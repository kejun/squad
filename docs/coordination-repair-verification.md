# 协调自我求助修复与等待原因验收

2026-11-05。受测代码提交：`f48b942afd822b094f02bfb5da63be8e8a17bc12`，最终检查及浏览器验收时工作区干净；随后提交仅补充本记录。基线为 main `53ace12eb7f892f9d398c8f2672110c5213331b4`。

## 修改与保证边界

协调员过去可以返回字段完整但对象无效的 assist 决策。向当前负责人本人求助会在状态机中被 SELF_DEPENDENCY 拒绝并转人工，既不触发重新生成，也不保存明确的新问题。

- 所有 facilitator 意图在创建时保存可信的当前 owner；旧协调意图在 CLAIM 时补齐缺失值，随领取事务提交。负责人交接后以实际负责人为准，不用 defaultBot、协调员身份或消息猜测。
- 适配器校验 assist 目标属于配置成员且不同于当前负责人；无效目标通过既有 invalid_decision 反馈重新生成。初始协议与修正反馈均说明规则。模型可以选择合法 continue 或向其他成员求助，不强行改写其判断。
- 修正继续使用 REGENERATE_MODEL_OUTPUT、CONSUME、原 retries 和 ordinary 预算，不新增状态或事件。状态机仍保留 SELF_DEPENDENCY 最终拒绝。
- 仅当前 coordinating.COORDINATE 的回退分支新增中文等待原因和通知。其它阶段、迟到结果不会覆盖正常人工问题；后续命令即使令 reply 变成 OK，reason 和消息仍保留。
- 普通协调已知安全的最终失败会明确说明自动修正无法继续及处理建议。后台讨论、取消和结果未知的外部操作继续遵守原结算边界；取消工作的范围未扩大。
- 网页使用既有 reason 和消息投影，没有新增瞬态 reply 展示字段。自定义宿主绕过领取且未提供有效 owner 时，适配器在首次模型 HTTP 请求前报告 COORDINATION_OWNER_MISSING；正常旧数据由 CLAIM 补齐。

场景为 `features/20_model_regeneration.feature` 的 BT_M23–BT_M29。状态图和转移/操作边界见 `docs/state-diagrams.md`「协调决策校验与等待原因」及 README「状态模型」。

## 模型先行

场景、状态图完成后，先实现真实 XState 的意图元数据及拒绝/失败动作，再进入适配器接线。新增纯模型测试最初复现缺口，首次门槛 16 项通过；补充边界后为 18 项，覆盖负责人交接、旧意图恢复领取、当前拒绝、非当前结果隔离、修正计费与停止/版本/期限限制、讨论隔离。

```sh
node node_modules/vitest/vitest.mjs run tests/coordination-model.unit.test.ts --maxWorkers=1
```

旧模型冻结 JSON 没有改写。兼容比较先逐工作校验新增 owner 等于创建时负责人且持久不变，再只投影掉这一个已验证字段计算原 digest；其它快照字段、全部历史轨迹及持久化边界保持完整比较。状态图只明确增加当前拒绝分支的一项解释动作。故障注入确认缺 owner、错 owner 及无关 payload 变更仍会失败。契约、actor、诊断相关 61 项通过。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| TypeScript | 产品、网页、测试三组通过 |
| Vitest | 52 个文件、651 项通过 |
| 新增协调集成 | 13 项通过，含真实 HTTP 供应商边界及 SQLite |
| 新增 Gherkin | BT_M23–BT_M29：13 个展开场景、320 步通过 |
| 模型重新生成 Gherkin | 整个 features/20：45 个场景、1098 步通过 |
| 全量 Gherkin | 643 个场景：641 通过、2 失败；16272 步：16265 通过、2 失败、5 因前置失败跳过 |
| 构建 | npm run build 退出 0 |
| 真实浏览器 | 两条用户流程、四组断言通过，退出 0；run.json.status=verified，四项清理均为 true |

全量 `npm run check` 退出 1：两个失败均为 `features/24_local_skills_cli.feature` 的原生沙箱验收，宿主缺少所需 OS namespaces（Required OS namespaces are unavailable / CLI_SANDBOX_UNAVAILABLE）。未改动这些场景、断言或排除名单。`npm run coverage:specs` 因这两个未通过的场景退出 1，不能称全量检查通过。

可重复执行相关场景：

```sh
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/20_model_regeneration.feature --import 'tests/bdd/*.ts' --format summary
```

真实网页验收：

```sh
npm run build
node scripts/verify-coordination-repair.mjs reports/coordination-repair/new-run
```

可通过 SQUAD_CHROMIUM 指定已安装的 Chromium。最终运行使用 Node v24.22.1、Chromium 153.0.8010.0 和实际 Noto CJK 字体；证据位于 `reports/coordination-repair/20261105-f48b942/`（按仓库规则忽略）。包含源码 SHA、干净工作区、操作日志、provider HTTP 记录、截图、ARIA、trace、字体、HTTP 快照及只读 SQLite 核查。

网页操作通过真实生产入口创建群聊并发起任务，只有外部模型 HTTP 返回合成结果。一次自我求助修正为 continue 后自动完成，retries=1、ordinary=4、checks=1，期间没有人工等待或无效协助。持续错误在默认 retries=10 后停止（11 次协调模型请求），中文原因和建议在群聊可见、轮询后仍保留，不再发出请求。真实供应商生成质量与原生 CLI 效果不在本次浏览器保证范围内。
