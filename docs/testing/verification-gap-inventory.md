# Squad 验证缺口清单（KEJ-101）

审计日期：2026-11-07（UTC）。唯一产品基线为执行时最新 main：`1d7dc6e048b3927b6e2b51c7f7803dafd09217d5`，tree `eb568bca348806c3919d65d7d9a5f6b23dcba8fd`。开始和拆票后均通过 GitHub `branches/main` 读回同一 SHA；本地 HEAD 与其一致。本文只增加审计文档、证据快照和后续工单，不修改产品、测试、场景、状态模型或排除登记，适用 AGENTS.md 的文档变更豁免。

结论：当前 Linux 原生沙箱的历史验收缺口已被最新主线 CI 关闭；四套有限形式化检查无需重建。确认五项独立后续工作：完整浏览器绑定、两个真实进程故障窗口、成功模型响应的资源上限、取消分片恢复后的成员占用缺陷。后两项分别是产品可靠性加固和已复现行为缺陷，不能称为只补测试。Pi Durable、提供方金额以及真实模型语义质量仍有明确边界。

## 证据来源与判读规则

- [主线 CI run 42321996074](https://github.com/kejun/squad/actions/runs/42321996074)：push，head 为上述 SHA，2026-11-07 01:04:27–01:12:56 UTC，completed/success。
- [Complete verification job 128248476951](https://github.com/kejun/squad/actions/runs/42321996074/job/128248476951)：真实 Ubuntu 22.04.5、Node 24.22.1，安装 bubblewrap/socat/ripgrep，`npm ci`、`npm run verify:local-sandbox`、`npm run check`、`npm run build` 均 success。
- [Formal verification job 128248476776](https://github.com/kejun/squad/actions/runs/42321996074/job/128248476776)：四个真实检查入口均运行并通过，含实现回放和预期失败的源码负对照。
- [审计证据快照](kej-101/evidence.json)：远端 job/step 终态、采集时间、原始日志 SHA-256 与带行号的未改写摘录、四套源码指纹核对、工单状态、本地命令退出结果、448 个已执行 BDD 定义的逐项结果。完整 CI 原始日志已读取；快照摘录不是完整日志。形式化 artifact 上传摘要见同文件；本次没有下载 ZIP 后逐文件独立读回，不冒充完成了该项验证。
- [取消分片恢复诊断结果](kej-101/cancelled-map-recovery.json)：本次在真实 Engine/Runner/SQLite 上复现的缺陷；诊断退出 0 表示观察到坏行为，**不是新增验收通过**。

| 当前主线检查 | 实际结果 | 保证边界 |
| --- | --- | --- |
| Vitest | 43 文件、435 用例通过 | 回归、真实集成、DOM、样式及仿真混合入口；不能统称单测或浏览器 |
| Gherkin 直接执行 | 1157 展开用例、47458 步通过，448 定义完整执行 | `run-bdd.mjs` 仅排除明确登记项；不能把步骤数当独立断言数 |
| 场景全集 | 31 feature、466 定义、1183 展开用例 | 18 定义/26 用例仍待验收 |
| 回归关联 | 241 定义关联回归 | 与直接执行集合重叠，不能相加或据此宣布其余场景通过 |
| 真实沙箱 | 独立门槛及 BT_L19/L22 均通过 | 当前 Linux runner 与脚本实际断言的路径/进程边界 |
| 形式化 | 四套 TLA+/TLC 检查通过 | 逐套有限切片及代表具体历史；不是整个 TypeScript 系统证明 |
| 真实浏览器 | 本次未运行，当前 CI 无完整浏览器入口 | 旧记录与 DOM/SSR 不能成为本基线完整浏览器通过证据 |

本地复核使用同一产品 SHA、当前 checkout 锁定依赖和固定无外部调用的测试模型配置。外层执行沙箱首次使 Vitest 无输出超时、Host 门槛 spawnSync EPERM；取得所需进程权限后完整检查退出 1：435 回归通过，1155 Gherkin 通过，BT_L19/L22 因缺少 `socat` 失败（其余 8 步 skipped 是失败后的步骤，不是新增排除项）。没有放宽断言或把同基线失败记为通过。沙箱“已覆盖”的依据是同 SHA 的真实主线 CI，本地受限环境结论另列。

### 可重复入口与本次纯模型结果

在仓库根目录运行；模型门槛前设置 `MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture`，不访问供应商。Host 包装器内部使用固定 example.test 配置，但所选场景不做产品 I/O。

| 命令 | 本次结果及范围 |
| --- | --- |
| `npm run check` | 本地退出 1，原因及统计见上；主线 CI 同 SHA 退出成功 |
| `npm run verify:local-sandbox` / `npm run build` | 本次引用主线 CI 实跑结果，未另称本地执行通过 |
| `node --import tsx tests/core-model-gate.ts` | 退出 0，80 条纯真实 XState 驱动轨迹 |
| `node --import tsx tests/delivery-contract-gate.ts --pure` | 退出 0，91 条纯交付/引用轨迹 |
| `node --import tsx tests/host-model-gate.ts` | 首次 EPERM；所需权限下退出 0，54 个纯模型展开场景，源码哈希及事件断言留存 |
| `node --import tsx docs/testing/kej-100/map-model-gate.mjs` | 退出 0，33 个原纯模型契约 |
| `python3 docs/testing/kej-100/verify-ledger.py` | 退出 1；这是冻结到 KEJ-100 的历史清理账本，不是当前 main 通用门槛。PR41 修改了 delivery-acceptance/model-adapter/task-delivery 三个产品文件，故触发其“产品未改”历史断言；本次未改这三个文件，也未改脚本绕过检查 |

定向直接 BDD 的统一命令为：`TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features --import 'tests/bdd/*.ts' --tags '场景标签表达式' --format progress`。下文注明的非登记场景由本次全量直接运行承接，逐项结果见证据 JSON；这不表示另跑了所有定向命令。待验收 BT_D*、U01/U02/U03/U09、F06 不在已直接运行集合。

## 集中审计台账

以下每项的证据均限定上述 SHA 和时间。形式化入口 F1–F4 在下一节定义；模型门槛复用上表，不为本次文档新增模型或业务场景。

### VG-P0-01：当前 Linux 原生沙箱——已覆盖，关闭历史缺口

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 沙箱不能创建、外部/凭据可读、检查源文件可写、取消后进程存活，造成无法执行或越界效果 |
| 实现 | `src/local-cli.ts` 的 sandboxPolicy、SandboxCliBackend.create/execute/processIdentity/identityAlive/runProcess；`src/local-runtime.ts` 的 create/acquireLock/execute；SRT 0.0.81 与 `scripts/patch-sandbox-runtime.mjs` |
| BDD | BT_L19/L22 直接执行；`native-local-tools.steps.ts` 实调 `nativeStartupAcceptance/nativeSandboxAcceptance`。BT_L20/L21 补充锁和目录别名；非豁免项 |
| 模型 | BT_L70–L76 的保存→领取→开始→结果→续办及停止/迟到/恢复模型；本次 core/host 门槛通过。F3 只覆盖授权/租约，不证明 namespace |
| 真实集成 | CI `verify:local-sandbox` 日志 274 行明确 boundaries passed；L19 启动真实 WebService/SQLite/LocalRuntime，执行技能命令后交付；L22 实跑独立沙箱脚本 |
| 负对照 | 脚本实际尝试拒绝的文件/网络/写入操作；依赖 mount-order/production-deny/patch 回归 3+1+5 项同 CI 通过。历史 core-evidence 的 namespace 源码变异另有检出记录，但未在本次重跑，不称当前完整 OS 变异证明 |
| 去重/动作 | 不再创建“Linux 沙箱进入 CI”或同例测试。旧 exit78 环境记录保留为历史；本地缺 socat 如实保留 |

实际 OS 断言覆盖工作区可写、包外/private/.env/宿主包及 SRT 安装目录不可读、技能快照与可信 helper 不可写、helper 可读可执行、凭据不继承、可达监听端口被沙箱网络拒绝、check 源文件只读而 dist 可写、dist/.env 与根 `.git/hooks` 拒写、长命令及后代取消并确认 identityAlive=false/effectsKnown=false。

边界见 [sandbox-runtime-patch.md](../sandbox-runtime-patch.md)：SRT 残留 glob denyWrite 不生效，当前根目录 literal 与已存在 denyRead 掩蔽之外，未来嵌套敏感同名文件/嵌套 hooks 不在保证内。没有 cgroup CPU/RAM 配额断言，不证明所有部署、最新 macOS、OS 锁或断电。真实拒绝尝试证明具体边界，不扩大为所有模式的安全证明。

### VG-P0-02：完整浏览器交互——部分覆盖，KEJ-102

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 真实输入、任务更新、中途干预、详情导航或断线恢复失效；SSR/模拟 DOM 仍可能通过 |
| 实现 | `web/src/App.tsx:Workspace`、`api.ts:useWorkspace`（轮询/abort/连接恢复）、Details/Artifacts/SourceArtifactLink/ResultLinks、PanelLayout、AssistanceRetry；服务 `src/web/http.ts/service.ts` |
| BDD | BT_U01/U02/U03/U09 未直接执行，仍在 manual_browser。U17–U19 等 SSR/DOM 内容场景不能替代完整原要求 |
| 模型 | 沿用 taskMachine 的 running/waitingAssistance/waitingHuman/stopping/ended 和 `docs/state-diagrams.md` 的网页/面板投影；本次相关纯模型通过。F1–F4 不适用于浏览器焦点/网络/几何 |
| 现有 E2E | `.agents/skills/verify-squad/scripts/verify.mjs` 已有 rooms/reports/control/assistance/layout 五组真实生产 HTTP/SQLite/React/Chromium 助手，provider 为受控夹具；当前 CI 没有该浏览器门禁，本次未运行 |
| 负对照 | 未找到四项完整浏览器契约的当前 main 行为破坏检出证据；DOM/状态机变异不替代它 |
| 去重/动作 | [KEJ-102](https://linear.app/kejunz/issue/KEJ-102)：复用已有助手，完整绑定原四项；不新造浏览器框架、不复制 KEJ-98 产品能力 |

已可复用的代表路径包括建切群/点名键盘补全、宿主退出后禁发与同库重启刷新、在途停止后继续同任务、按钮/文本重试、预览复制下载逐字读回、拖拽与折叠偏好刷新恢复及手机导航。仍需明确检验：执行中补充与等待回复、同一状态行连续更新而不污染时间线/明细默认折叠、任务和成员所有详情入口及来源/理由、活动任务刷新/断线重连不重复提交、产物来源与版本切换。面板 Escape/其他键盘及详情叠层等覆盖边界按既有助手地图保留。完整绑定通过前不删登记。

### VG-P0-03：Pi Durable 原契约——产品能力未实现

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 把当前 SQLite 宿主的恢复能力当成承诺的 Pi Durable 接入，用户依赖了未交付的运行/唤醒保证 |
| 实现 | 当前是 TeamEngine/taskMachine/SqliteStore/WorkRunner/WebService；README 明示 Pi 适配器未实现，依赖中无 Pi Durable |
| BDD | `features/06_durability.feature` 背景仍要求锁定版本 Pi Durable。D01–D13 共 13 定义/21 展开未直接执行；durability 回归只关联编号 |
| 模型/形式化 | 复用当前纯恢复门槛与 F1/F3/F4。均不运行 Pi、不证明 Pi 接入；不能作为替代决策 |
| 集成/负对照 | 真实 SQLite 子进程及受控恢复测试有价值，但没有 Pi 运行或负对照证据；CI 不执行 Pi |
| 去重/动作 | 未找到取消承诺或确认等价替代的产品决策。保持要求与登记，先补决策依据，再由产品实施承接；不拆“给 D01–D13 加测试”票，不静默豁免 |

### VG-P1-01A/B：故障注入与崩溃恢复——部分覆盖，KEJ-103/104

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 不可幂等效果被重复、已确认结果丢失、半提交候选/回执泄露、孤儿租约长期阻塞 |
| 实现 | `src/store.ts:SqliteStore.transact`（BEGIN IMMEDIATE/WAL/FULL）；engine claim/beginExecution/flushResults/recover、runner runOne、LocalRuntime journal/reconcile、task lifecycle/guards/local-operation |
| BDD | C04–C06/C09/C11、E02、L04–L07/L10–L16/L20/L70–L75、A03/A36 等直接执行；`recovery.steps.ts` 使用真实 SQLite 重开。D01–D13 的编号关联不是直接 Pi 验收 |
| 模型 | core/host 门槛本次通过；F1 原子结果交接、F3 执行授权与停止恢复、F4 持久预算通过。共同假设事务与可信宿主边界，不能证明任意杀进程窗口 |
| 负对照 | F1/F3/F4 当前 CI 真实源码变异；历史 core/host 故障驱动另有记录。未发现下面两个真实进程窗口的目标负对照 |
| 去重/动作 | 仅补两个独立物理边界：[KEJ-103](https://linear.app/kejunz/issue/KEJ-103) 外部效果后宿主丢失；[KEJ-104](https://linear.app/kejunz/issue/KEJ-104) SQLite 写事务中终止。不重做授权/审批/预算模型 |

| 时点/性质 | 已有实际保护 | 剩余边界 |
| --- | --- | --- |
| HELP 保存后、CLAIM 后、结果保存后 | `tests/durability.test.ts` 启动 `tests/fixtures/crash.ts`，三点 process.exit(23)，不 close，重开真实 SQLite 并恢复；本次三项通过 | 均在提交后退出；非事务内丢失 |
| 事务提交失败 | failNextCommit 在写入后抛异常，catch 显式 ROLLBACK；D06 回归、A03/A36 直接场景覆盖结果/候选/新任务/回执原子性 | 非 COMMIT 前真实终止；缺少半提交不可见与已提交对照的物理证据，归 KEJ-104 |
| 保存前/领取前/启动前/启动后回执前/回执后模型前 | `local-tools-acceptance.ts:crashAcceptance` 五窗口、真实 CLI 与 SQLite，但使用受控 backend 和同进程 close/reopen；serviceRecoveryAcceptance 真服务/journal核对 | 非宿主真正丢失；外部效果已发生且无回执时不盲重放，以及 journal 已结算但 DB 未结算时原样续办，归 KEJ-103 |
| 停止与领取、迟到/重复/乱序 | C11 拒绝 stale claim，beginExecution 一次性许可；C09/A04/A05/A24/A41/Q04/Q05 与 F2/F3/F4 提供隔离 | 不等于多宿主同库压力、无限故障或外部恰好一次；实际取消恢复组合缺陷另见下项 |

两个窗口可以用业务场景清楚表达，缺的是**真实进程与依赖证据**，无需新增单元测试框架。KEJ-103 最小验收：隔离不可幂等效果账本、确定 checkpoint、真实终止宿主、unknown 不二次执行、known 用原回执仅一次续办、核对/租约最终可结算。KEJ-104 最小验收：COMMIT 前退出全部写入不可见，COMMIT 后退出完整保留，同请求只产生一个逻辑结果；破坏跨记录原子性的负对照被检出。两票均要求外层 deadline、进程组清理，不能声称撤回外部效果或证明硬件断电。

### VG-P1-02：产物版本与证据链——已覆盖代表契约，复用 KEJ-93/98

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 旧判断发布新候选、历史报告被覆盖、来源/任务串线、未保留原文却宣称修订成功 |
| 实现 | `task/delivery.ts:deliveryVersionProblem/boundCheckProblem/publicationIds/artifactForWork`；delivery-acceptance；task/evidence；`source-artifact.ts:resolveArtifactSource`；task/context 克隆固定来源；engine.submit 房间事务；artifact-request 直接修订指令 |
| BDD | B01–B09、A01–A06/A22–A26/A41、F14–F31；KEJ-98 的 A29–A39/A44–A48 已独立直接执行，artifact-reference/artifact-ui-contract/delivery-contract 步骤承接。A36 真 HTTP+SQLite 并发同 ID 去重、不同 ID 一 200 一 409、回滚与恢复 |
| 模型 | 本次 delivery 91/map 33 条门槛通过；真实 replacement/sameName/stale/unbound/legacy 与固定原文轨迹。F2 验证有限候选/冻结证据/发布切片，明确不覆盖 KEJ-98 全部跨任务来源 |
| 真实集成 | Memory/SQLite、真实 HTTP/Runner、受控 provider 已执行；A34 超历史原文、源任务更新/重启仍固定，A35 旧ID/空/非Markdown拒绝，A37 停止迟到，A39 旧清单兼容。composer 的 happy-dom 是 DOM 接线，不是真浏览器 |
| 负对照 | F2 当前 CI drop-final/accept-stale/skip-snapshot 双存储均因目标 AssertionError 失败、恢复原实现通过；KEJ-100 delivery-regression 9 类含共享可变原文等属历史证据，未在本次重跑 |
| 去重/动作 | 不新建“产物版本证据链”或跨任务修订实现票。界面/刷新证据归 KEJ-102，发布事务物理崩溃归 KEJ-104；语义真实性另列未验证 |

### VG-P1-03A/B：Agent 协作组合——现有保护广泛，但发现一个恢复缺陷

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 部分结果假装完整、旧目标答复触发新归并、重复扣费/交接，或取消后的成员被永久误判忙碌 |
| 实现 | `task/discussion.ts:startDiscussion/planDiscussion/acceptDiscussion/discussionFailed`、map-reduce、map-reduce-capacity、assistance、engine.flushResults、task/actions lateResults、task/reducer RECOVER |
| BDD | H01–H09、促进者、C停止/版本、T01–T15、Q01–Q18 直接执行。原 issue 的 BT_03/23/26 不是当前唯一 tag 的可靠定位，按实际 H/T/Q/C 场景核查 |
| 模型 | `scripts/simulate-discussion.ts` 用真实 XState 枚举 144 合法完成顺序和超过180条生命周期轨迹；本次 discussion-simulation 回归通过；F1/F4 另有有限交接/两片模型，不能拼成任意组合证明 |
| 集成 | Q01 真并发两请求先在途、Q03 失败/部分仍partial、Q04 停止/改目标迟到、Q05 SQLite 两次重开不重跑完成片；background-discussion 31项覆盖超时/成员占用/两种完成顺序/监督竞争/预算与恢复；Q07–Q18 容量/完整回退复用 KEJ-99 |
| 负对照 | F4 当前 CI 16 类变异含丢partial、重复handoff、旧attempt、提前reduce、容量/额度；现有保护未检出下面的取消→恢复→新协作组合，本次定向诊断观察到坏行为 |
| 结论/动作 | 03A 代表交错已覆盖，不新建泛化组合验证票；03B **部分覆盖且已复现产品缺陷**，独立 [KEJ-106](https://linear.app/kejunz/issue/KEJ-106)，不并入 CLI/事务窗口 |

03B 复现完全使用现有 `MapReduceFixture(undefined, true)` 的真实 Engine/Runner/SQLite，无手改快照：两 map 领取 → 用户改目标取消讨论 → reopen/RECOVER → 真实 Runner 处理两项 cancel → 领取新 owner → 邀请原两成员。旧 map 从 inflight 变为 pending，旧轮仍 cancelled；新讨论 targets=[]、两人 skipped“正在工作”、incomplete“暂无空闲成员参与讨论。”。旧回执虽以 STALE_FENCE 拒绝，但只释放对应单项，不能依赖重启前丢失的请求将来返回来清除占用。

可重复诊断（需允许本地夹具进程/SQLite 的环境；输出坏状态而非验收成功）：

```sh
MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture node --import tsx --input-type=module <<'JS'
import { MapReduceFixture } from './tests/map-reduce-fixture.ts';
const f = new MapReduceFixture(undefined, true);
try {
  await f.recognize();
  const maps = f.claimMaps();
  f.event({ type: 'USER_INPUT', text: '新目标', goal: { ...f.context().goal, text: '新目标' } });
  f.reopen();
  await f.run(); await f.run();
  const owner = f.pending('owner')[0];
  f.engine.claim(f.room, f.task, owner.id);
  f.event({ type: 'USER_INPUT', text: '请大家再讨论', reviewTargets: maps.map(x => x.target) });
  console.log(JSON.stringify(f.context().discussion, null, 2));
} finally { f.close(); }
JS
```

受测 task.machine.ts SHA-256：`24e1a16651b085a7ba677b366a51a9c29d901860ee707a054d7f4a434390c80e`。本次较完整诊断输出保存在链接 JSON，含取消消费后、后续讨论、旧回执和残留工作。KEJ-106 须先扩充 Q04/Q05 的组合契约和状态图、模型门槛，再修实现；释放不再合法派发的逻辑成员占用，同时保留真实未决物理效果的核对边界，旧回执仍不得启动旧归并。

### VG-P1-04：模型协议——固定类别已有保护，资源边界与语义质量分列

| 字段 | 核查结果 |
| --- | --- |
| 用户风险 | 畸形响应扩大权限/无限修复、截断答案被发布、超大成功响应拖垮宿主、格式合法而内容违背目标 |
| 实现 | model-adapter 的 parseOutput/outputFieldRequirements/validDecision/providerDiagnostic/enforceFixedContext/响应解析；runner.validWorkOutput；input-intent 的 Zod schema；task/assistance.helpProblem；budget；delivery-acceptance。不是整个 WorkOutput 都由 Zod 校验，其他动作亦有手写边界校验 |
| BDD | M10–M14/M17/M20/M23–M35/M37、H05–H07、W02、F18/F23/F27/F28、A45 等当前直接执行；model-regeneration/diagnostics/coordination-regeneration 步骤与真实 Runner/Adapter，HTTP provider 受控 |
| 模型 | core/host/delivery 门槛当前通过；F3/F4 提供拒绝授权及有界计费/补试有限性质，不证明任意 JSON 或自然语言理解 |
| 集成 | 缺字段/错误类型/未知成员/自助与嵌套协助/非法工具/连续修复、429共享重试、停止/版本/超时重查、SQLite 恢复与提交失败不再请求已有保护；截断 length 不提交且不按同容量盲重试 |
| 负对照 | F4 当前计费/补试限制变异，KEJ-100 core 的 capacity/coordination 等历史变异；超大成功响应无目标检出证据，真实语义无当前任务人工判定对照 |
| 结论/去重 | 04A 固定输入类别代表契约已覆盖，不为同例新增单测/模糊测试大票。04B 成功响应资源边界未实现，建产品加固 [KEJ-105](https://linear.app/kejunz/issue/KEJ-105)。04C 真实语义质量未验证，只补实际任务证据，不称协议校验已解决 |

04B 源码直接对成功体 `response.json()`；错误体 8192B、输入上下文预检、请求 max_tokens 和供应商 length 标志都不约束供应方实际返回的成功体。异常大体积响应可能在校验前消耗共享宿主内存。这里缺少的是资源上限和可观察超限失败行为，不能只增加“超长样例测试”。KEJ-105 先记录上限及配置决策，复用传输/预算/修复框架，验收缺失或虚假 Content-Length、分块超限、UTF-8 边界及取消，不记录无效正文、不发布截断内容。必要性质输入空间的验证须通过单测准入，代表用户结果仍由 BDD 承接。

04C 的 F23 等夹具预设检查 failed，证明冻结用户条件、逐项ID、引用和拒绝发布接线，不能证明真实模型会识别语义错误。供应商评测需原输入/资料快照/模型配置/完整输出和人工逐项判定；缺少这些材料时不因模拟场景通过宣称真实任务质量已通过。

### VG-P2-01：提供方金额与未知费用——产品能力未实现，单列 P2

BT_F06（1定义/1展开）仍在 requires_cost，未直接执行。`types.ts` usage、presentation 和 Details 当前展示 ordinary/checks 请求次数，没有可靠金额/未知费用状态；coordination 的请求预算不是计费金额。当前无费用集成或负对照，停止也不能撤回已发请求的实际费用。保持要求和登记；后续明确提供方数据来源、未知/估算语义后另由产品任务承接，不包装成 P0/P1 验证票。

## 四套形式化技能及既有 Issue 去重

实际工具为 **TLA+ Tools v1.7.4 / TLC 2.19**，不是 Lean/Quint。这不是因未用指定语言而缺少验证；不另建同性质模型。四套覆盖 KEJ-92–97 六项工作。下列命令是可重复完整入口，本次通过证据来自当前 main 的 Formal verification job，未在本地下载工具后再全跑。

| 编号/既有工作与入口 | 性质、有限范围与假设 | 当前证据、负对照与剩余边界 |
| --- | --- | --- |
| F1 / [KEJ-92](https://linear.app/kejunz/issue/KEJ-92)，`python3 .agents/skills/verify-squad-handoff/scripts/check.py` | engine submit/claim/send/flushResults/recover、assistance.acceptHelpResult、operations.owner/cancelWork、runner/store。AtomicHandoff/AtMostOnce/StopCancelsResume/Progress；一任务A/B、一已保存结果、epoch/goal各1..2、至多一次crash/rollback，弱公平恢复/flush。D04–D06仅规格关联，C02/H11/H12/H15另有当前验收 | CI verified 46.689s，清理/coveredFilesUnchanged全true；双存储代表前缀回放，6见证，删消费标记/重复续办/漏取消/runner漏flush四类行为负对照。**不领取A执行**，不覆盖多结果/多任务、结果保存前效果、Pi、物理竞争或无限故障 |
| F2 / [KEJ-93](https://linear.app/kejunz/issue/KEJ-93)，`python3 .agents/skills/verify-squad-delivery/scripts/check.py` | reducer.DELIVER、delivery.checkDisposition、evidence.deliveryEvidence、operations.finish、acceptance/事务。AtomicPublication/CurrentCandidate/VersionIsolation/Progress及SnapshotBinding；一任务/候选/文档/技能回执/检查、goal1..2、crash/rollback各1；有效审查/重开弱公平 | CI verified 18.847s；31状态/79边×两存储，9损坏输入；drop-final/accept-stale/skip-snapshot 六个实现负对照均以具体AssertionError/exit1检出，恢复exit0。F22–26/F31独立BDD；不覆盖KEJ-98多任务修订、连续多候选、分页重组、UI/语义 |
| F3 / [KEJ-94](https://linear.app/kejunz/issue/KEJ-94)、[KEJ-95](https://linear.app/kejunz/issue/KEJ-95)，`python3 .agents/skills/verify-squad-authority/scripts/check.py` | beginExecution→startTaskExecution→executionMachine.sameTicket，localEventProblem/applyLocalEvent、hostSessionMatches、LocalRuntime/租约。Execution一个owner/attempt1；Host一runCli/固定审批；SessionScope八二值字段×revoked=512输入状态。OneStart/NoUnauthorizedStart；20个生命周期实例，10个digest变体在spawn前终止。N06–N15/L23–L28及会话场景；无自动活性保证，未批准可等待 | CI Evidence verified；checker强制34步骤。六类一次性permit/审批ID/lease/到期/session namespace/digest真实变异；前五双存储，digest运行时文件入口。不是两条CLI真实并发、OS启动/回收、跨主机锁/TTL、撤回副作用、断电或无限多轮证明 |
| F4 / [KEJ-96](https://linear.app/kejunz/issue/KEJ-96)、[KEJ-97](https://linear.app/kejunz/issue/KEJ-97)，`python3 .agents/skills/verify-squad-coordination/scripts/check.py` | task budget/policy/reducer/discussion/map-reduce。Budget一owner、两用户epoch、普通3+2、retry1；CheckBudget一交付周期两候选/一次修订/两recover；Shards恰2片、乱序/重复/失败/partial、stop或一次goal改变、一reopen。弱公平领取/返回/归并；Q01–Q18另有BDD与容量实例 | CI verified 360.284s；19见证、16类真实双存储变异（含5类容量），恢复后重跑与证据读回。容量0/1/2/4、恢复4→3、legacy为12个实现实例，不是TLC容量全域探索。**取消后仍inflight再RECOVER**、多任务资源竞争、>2片笛卡尔积、宿主效果×权限×目标组合不在证明；03B确实落在此边界 |

当前 F1 coverage syncCommit=`756074087685bed3f52f0e6b6e06caf19c587a01`（49文件），F2–F4=`3ee6c875bbde0f802eae954d9017ffe5663a3cfc`（各62文件）。本次逐文件 SHA-256 均无漂移，且当前 main CI 重跑成功；syncCommit 比 main 旧并不表示源码对应已漂移。指纹只提供漂移门禁，不是等价证明。PR40/raw-input 的逐文件审查保留在各技能 references；新来源/容量分支边界已显式声明，不能由保守覆盖文件集合推出它们都在模型内。

形式化 [artifact 13552899707](https://github.com/kejun/squad/actions/runs/42321996074/artifacts/13552899707) 的 job 上传摘要：592文件、1039112字节，ZIP SHA-256 `02209b3b4dcab98a47168b2759f741a433ee4d48957b7c35a7460bae9aed6299`，保留14天。CI 检查器已执行自身证据校验；本次审计未下载该 ZIP 独立运行 `--verify-evidence`，此补证据动作不单独建实施票。模型结果依赖 SQLite 原子事务、可信宿主及弱公平等假设；每抽象边的代表具体前缀回放，不等于全部隐藏状态/历史或多个切片的组合证明。

| 其他既有工作 | 当前核对及去重 |
| --- | --- |
| [KEJ-98](https://linear.app/kejunz/issue/KEJ-98)（Linear In Progress） | 产品已进入main，有A29–A39/A44–A48独立保护；状态不能证明未实现或已验收。复用固定来源、新任务、原任务不变、HTTP并发/恢复保护，不新建同功能任务 |
| [KEJ-99](https://linear.app/kejunz/issue/KEJ-99)（In Progress） | 容量规划已在main与Q07–Q18/有限实现实例保护；不重做容量分片。106仅处理取消恢复占用泄漏 |
| [KEJ-100](https://linear.app/kejunz/issue/KEJ-100)（Backlog） | AGENTS单测准入、BDD唯一契约、逐项966条清理账本及四组纯模型入口已在main；状态与交付记录不一致，不擅自改状态。after.json的旧1152/435和formal-evidence历史摘要不替代本次1157/435结果；不复制测试治理工作 |

## 显式待验收登记：全部18项逐一处置

本次不删除或修改 `features/acceptance-gaps.json`、标签、步骤及要求。D类可复用保护只是 SQLite 机制回归，均不能作为 Pi Durable 背景直接通过。

| 登记项 | 当前可复用保护/边界 | 处置 |
| --- | --- | --- |
| BT_D01 | 双存储提交身份去重/冲突；非Pi | 保留，产品未实现 |
| BT_D02 | afterHelp真实子进程提交后退出；非Pi派发宿主 | 保留，产品未实现 |
| BT_D03 | afterClaim真实退出/逻辑请求恢复；不保证物理调用一次 | 保留，产品未实现 |
| BT_D04 | afterResult退出/消费恢复；F1有限切片 | 保留，产品未实现 |
| BT_D05 | 同结果不同送达身份不重复推进/公开 | 保留，产品未实现 |
| BT_D06 | failNextCommit显式回滚；非真实事务中丢进程 | 保留，产品未实现；104只补SQLite边界 |
| BT_D07 | 新engine读取与历史浏览器重启配方；非Pi活动宿主 | 保留，产品未实现 |
| BT_D08 | 受控重开期限/waitingHuman；非Pi唤醒 | 保留，产品未实现 |
| BT_D09 | unsafe操作恢复等待RECONCILE；非任意外服务幂等/可查询 | 保留，产品未实现；103不冒充本项 |
| BT_D10 | 提交故障后fail-closed；非Pi/真实磁盘故障 | 保留，产品未实现 |
| BT_D11 | 保存停止后不派旧工作；当前恢复机制 | 保留，产品未实现 |
| BT_D12 | 相同逻辑intent重试attempt/计费；供应商可收到重复物理请求 | 保留，产品未实现 |
| BT_D13 | 安全读取有界重试/永久失败等待；外写需适配器核对 | 保留，产品未实现 |
| BT_U01 | 建切群/点名/停止已有助手；中途输入完整契约未绑定 | 保留，部分覆盖，102 |
| BT_U02 | SSR/DOM与现有状态显示；连续状态行/时间线/折叠缺真浏览器绑定 | 保留，部分覆盖，102 |
| BT_U03 | 详情与来源已有实现/部分助手；所有入口/理由未完整绑定 | 保留，部分覆盖，102 |
| BT_U09 | 旧rooms有宿主退出后禁发；无当前main完整离线交互证据 | 保留，部分覆盖，102 |
| BT_F06 | 仅请求次数预算，无提供方金额/未知费用 | 保留，P2产品未实现 |

D类13定义/21展开，U类4/4，F类1/1，合计18/26。Linux L19/L22不在豁免登记；不得因本地缺少依赖新增排除。退出Gherkin的纯样式U15/P10/P20按features/README历史登记，不是遗漏或待验收编号。

## 最近真实任务与历史证据边界

- [KEJ-98实施记录](../implementation/kej-98.md) 的8组浏览器记录源于 `7aea407`，真实HTTP/SQLite/React/下载，provider夹具；[KEJ-99](../implementation/kej-99.md) 四成员八文档浏览器记录源于 `a1c0ef9`，资料/provider受控。旧 `work/.../browser-*` 原始目录不在当前checkout，未冒充已独立读回当前main浏览器结果。
- [PR40形式化对应修复](../implementation/pr-40-ci.md) 记录来源/容量新分支的切片边界，可解释当前指纹；当前通过仍用最新main原始CI job，不能用PR描述或旧Done状态代替。
- [技能资源交付记录](../skill-resource-delivery-verification.md) 明确早期真实网页订单对账partial。后续“三次真实模型成功”为源环境历史报告，迁移未复跑；本次未获得三次任务的完整快照/输出/人工判定，不宣布本main真实语义已验收。
- [工具调用交付验证](../tool-call-delivery-verification.md) 的旧 Chromium153 三路径和受控性能夹具只作线索；原运行审计导出缺失、真实模型配对指标待测。合成场景、有限模型与 CI 通过不证明真实供应商语义或性能。

## 经核实后的实施排序与依赖

拆票前已检索 sqaud 项目全部15项及团队工单，没有发现以下相同任务；全部新票是 KEJ-101 子项并建立关联。已覆盖项、已有进行中功能和仅需补证据的事项均不重复开票。

| 顺序/性质 | 明确缺口与工单 | 依赖及最小验收 |
| --- | --- | --- |
| 1 / P0验证 | VG-P0-02：[KEJ-102](https://linear.app/kejunz/issue/KEJ-102) | 复用现有Chromium助手及中文字体、隔离HTTP/SQLite；原四场景完整直接执行/截图trace/故障检出/清理后才移登记 |
| 2 / P1行为缺陷 | VG-P1-03B：[KEJ-106](https://linear.app/kejunz/issue/KEJ-106) | 原实现已重现；Q04/Q05组合与图/模型先行，新目标可再使用成员、重复恢复幂等、旧回执仍拒绝；不清掉真实未决效果 |
| 3 / P1验证 | VG-P1-01A：[KEJ-103](https://linear.app/kejunz/issue/KEJ-103) | 真实宿主/CLI checkpoint与同库恢复，unknown不盲重放、known原回执接续、租约可结算；不依赖102 |
| 4 / P1验证 | VG-P1-01B：[KEJ-104](https://linear.app/kejunz/issue/KEJ-104) | 真实SQLite事务COMMIT前/后进程终止对照；快照/回执/租约不可半提交，重放唯一；复用现有进程夹具 |
| 5 / P1产品可靠性加固 | VG-P1-04B：[KEJ-105](https://linear.app/kejunz/issue/KEJ-105) | 先明确体积上限/配置/失败诊断，再按BDD流程有界读取；超限取消、不发布/不盲重试；不是“只补鲁棒性测试” |
| 待决策 / 产品 | VG-P0-03 Pi Durable；VG-P2-01金额 | 保留原要求，先确认产品方向与数据契约；不新建假验收/重复功能票，不降低优先级掩盖Pi承诺 |
| 补证据 / 不拆票 | VG-P1-04C语义质量、最新浏览器原始目录、形式化ZIP独立读回 | 获取真实任务与人工判定/既有运行原件，明确受测SHA与环境；不能从固定JSON样例得出质量结论 |

本 Issue 的完成条件是审计和独立拆票可追踪，后续票保持未完成。五项不是本次已实现或已验证通过的功能；没有为了清单全绿新增空步骤、重复 BDD、平行模型或放宽断言。

## 操作记录

1. 读取KEJ-101、项目AGENTS、Uncle Bob Mode与coding-workflow，核对仓库干净、remote/refspec及最新main完整SHA，建立独立分支。
2. 并行只读审查P0、P1、四套形式化与协议；读取当前main两个job原始日志、逐step终态及工单状态，区分历史证据和当前执行。
3. 保留外层沙箱失败后以所需权限复跑现有检查与Host门槛；如实记录缺socat的本地失败和主线OS环境成功，未安装替代框架或修改测试。
4. 运行四组既有纯模型门槛、逐文件核对形式化覆盖指纹，核查KEJ-100历史账本适用边界，不用旧脚本失败改写历史结论。
5. 用现有真实SQLite/Runner夹具复现取消恢复占用缺陷，保留诊断JSON；未修产品，也未新增测试入口。
6. 在项目/团队工单去重后创建KEJ-102–106，逐票限定一项缺口、性质、复用入口、负对照、边界与依赖；保持Pi/金额/语义未验收事实。
7. 固化集中清单和证据快照，读回工单关联与main SHA，并审查差异仅含文档/证据。发布和PR检查状态以实际交付读回为准，不把基线CI结果冒充文档分支CI。
