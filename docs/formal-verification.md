# Squad 有限形式化验证

验证检查容易被单条实例遗漏的事件顺序，并将抽象迁移回放到真实实现。TLC、真实代码对应、产品场景和宿主接线是不同证据；它们不构成整个 TypeScript 程序、外部服务、操作系统、SQLite 或文件系统的机器证明。

## 六个技能与完整入口

先安装锁定依赖 `npm ci`。需要受支持的 Node（建议 24.11+）、Python 3.10+、Java 11+；需要下载 JAR 的入口还需 curl。所有模型使用固定 TLA+ Tools v1.7.4，JAR SHA-256 为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。可设置 `TLA2TOOLS_JAR` 指向已校验文件；下载与缺依赖处理以各入口说明为准。

| 技能 | 原检查与组合检查 | 主要边界 |
| --- | --- | --- |
| [verify-squad-handoff](../.agents/skills/verify-squad-handoff/SKILL.md) | `scripts/check.py` **和** `scripts/check-composition.py` | 已保存结果原子消费；失败/已保存前缀的重试选择、负责人及权限变化 |
| [verify-squad-delivery](../.agents/skills/verify-squad-delivery/SKILL.md) | `scripts/check.py` 已包含原 Delivery 及三个新组合模型 | 工程验证、发布前版本复核、三个交付周期、三个任务的冻结来源 |
| [verify-squad-authority](../.agents/skills/verify-squad-authority/SKILL.md) | `scripts/check.py` **和** `scripts/composition-check.py` | 一次性许可、租约、宿主审批；撤销、恢复与新旧 attempt/审批/许可组合 |
| [verify-squad-coordination](../.agents/skills/verify-squad-coordination/SKILL.md) | `scripts/check.py` **和** `scripts/check-extensions.py` | 原预算/分片；后继费用、输入、取消恢复、评审与延期协调 |
| [verify-squad-local-effects](../.agents/skills/verify-squad-local-effects/SKILL.md) | `scripts/check.py` | 未知效果、可信 journal、检查点、工程独占与恢复提交 |
| [verify-squad-host-retry](../.agents/skills/verify-squad-host-retry/SKILL.md) | `scripts/check.py` | 两个来源、先后两批的续办与安全退休 |

表内脚本路径相对于对应技能目录。完整集合为：

```sh
python3 .agents/skills/verify-squad-handoff/scripts/check.py
python3 .agents/skills/verify-squad-handoff/scripts/check-composition.py
python3 .agents/skills/verify-squad-delivery/scripts/check.py
python3 .agents/skills/verify-squad-authority/scripts/check.py
python3 .agents/skills/verify-squad-authority/scripts/composition-check.py
python3 .agents/skills/verify-squad-coordination/scripts/check.py
python3 .agents/skills/verify-squad-coordination/scripts/check-extensions.py
python3 .agents/skills/verify-squad-local-effects/scripts/check.py
python3 .agents/skills/verify-squad-host-retry/scripts/check.py
```

Delivery 的独立 `scripts/composition-check.py` 供开发时单跑新增域，不能代替完整 `check.py`。其他旧入口也不能冒称已运行其独立扩展。每个入口支持 `--evidence 新目录`，拒绝覆盖已有证据；完整运行后，再用**同一入口**的 `--verify-evidence 实际目录` 独立读回。不同入口的证据目录和读回器不能混用。

若宿主只注入 `MODEL_API_KEY` 而没有模型端点，配置模块可能在回放前拒绝导入。可在当前命令前加 `env -u MODEL_API_KEY MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=formal-fixture MODEL_NO_AUTH=true`。这只是导入前提；回放使用显式受控配置，不请求该地址，也不修改用户 `.env`。

## KEJ-107/108 组合覆盖

下表对应 KEJ-107 的六组和 KEJ-108 的 A1–A6、B1–B5，共 17 个主项。有限模型的类型、源码所有者与现有状态图见[组合状态图索引](state-diagrams.md#kej-107108-组合验证补充)。表中“接线”不表示新增 TLC 模型，场景编号也不表示只靠标签关联就已直接执行。

| 主项 | 保护的边界 | 验证入口与独立场景 |
| --- | --- | --- |
| KEJ-107 #1 本地效果恢复 | 未知效果不重做、不释放工程；确定回执与检查点、租约原子结算 | local-effects；BT_L90–L93；另复用 KEJ-103/104 真实进程窗口 |
| KEJ-107 #2 宿主续办批次 | 未知效果保留阻挡，已知旧批次退休且下一来源唯一推进 | host-retry；两个来源、两批、四种公开前缀 |
| KEJ-107 #3 工程验证两阶段 | 隔离工程成功后才可请求模型检查；最终发布前复核相同版本 | delivery Verification；BT_F50–F51 |
| KEJ-107 #4 共享预算 | 额外请求不能侵占已承诺的成员、汇总、负责人及检查费用 | coordination DiscussionBudget/ReservedRequests；BT_J01–J02 |
| KEJ-107 #5 输入安全边界 | 旧交接结算后再解释补充，旧候选检查不能发布新要求 | coordination InputBoundary；BT_J03 |
| KEJ-107 #6 取消讨论恢复 | 已知旧成员工作退休；未知物理效果保留占用且不能推进废弃轮次 | coordination CancelledDiscussion；BT_J04 |
| KEJ-108 A1 多周期交付 | 三周期中只由当前检查发布，旧文档和历史 final 保持原选择 | delivery Cycles；BT_F52 |
| KEJ-108 A2 协助重试 | 已保存结果消费与新尝试互斥，重复命令不重复核查，资格变化不放大权限 | handoff RetryComposition；BT_K01–K02 |
| KEJ-108 A3 评审队列 | 失败修复保留其余结果，完成成员不重复，只安排当前汇总 | coordination ReviewQueue；BT_J05 |
| KEJ-108 A4 延期协调 | 普通活动与真实进展含义不同，已提交协调义务在安全边界履行或被停止 | coordination DeferredCoordination；BT_J06 |
| KEJ-108 A5 授权组合 | 撤销、重新审批与 parent attempt 变化后旧身份无新执行效果 | authority ApprovalComposition；BT_N30–N32；[详细边界](authority-composition.md) |
| KEJ-108 A6 来源与 lineage | 创建时冻结原文；新请求拒绝旧发布，后继任务只记录直接交付来源 | delivery SourceLineage；BT_F53 |
| KEJ-108 B1 网页回执与快照 | 另一群成功发送不清原群重试身份；旧快照不污染当前群及连接状态 | 真实 Chromium、HTTP、SQLite；BT_U20–U21 |
| KEJ-108 B2 服务生命周期 | 关闭后不启动新操作；存储故障全实例停止，非存储 hostError 暂隔离本房间后由监督按原窗口与预算恢复 | 真实 WebService/SQLite、受控 Promise/定时器及宿主边界；BT_K03–K07 |
| KEJ-108 B3 资源准备 | 并发、源变更和发布/marker 前后丢失后，只交付完整版本及具备临时、适用检查输出目录的隔离副本 | 真实文件系统、SIGKILL、公开技能/执行接口；BT_L81–L84；[准备流程](preparation-composition.md) |
| KEJ-108 B4 模型会话 | 工具资料在格式修正后保留，修正不重跑工具或回显无效原文，新工作不继承旧资料 | 真实 WorkRunner/模型适配器、受控 HTTP 与本地技能；BT_M50–M51 |
| KEJ-108 B5 Inspector 多代装载 | 旧 generation 不导航、投递或覆盖反馈，当前身份先注册后发快照，释放后无迟到快照 | 生产控制器/bridge 的四种装载顺序；BT_V41 |

这些主项共用真实模型与事务，但保证不能直接相乘。三周期不是无限修订，两个来源不是任意批次，三个任务不是任意来源图；服务、浏览器和文件准备的有限实例也不是 TLA+ 穷举。

## 场景与宿主接线入口

新增中文 Gherkin 位于 `features/36_coordination_composition.feature` 至 `43_handoff_composition.feature`。编号范围为 BT_J01–J06、BT_L81–L84、BT_L90–L93、BT_M50–M51、BT_U20–U21、BT_V41、BT_F50–F53、BT_K01–K07、BT_N30–N32。所有未登记缺口的展开例默认进入 `npm run test:bdd` / `npm run check`，覆盖报告检查遗漏；TLC 回放和 Vitest 标签不能替代直接执行。

B1 先 `npm run build`，再运行新增浏览器驱动；Playwright、Chromium 路径沿用[网页验证技能](../.agents/skills/verify-squad/SKILL.md#kej-108-组合验证入口)：

```sh
node .agents/skills/verify-squad/scripts/composition.mjs --case BT_U20 --variant 普通
node .agents/skills/verify-squad/scripts/composition.mjs --case BT_U20 --variant 来源引用
node .agents/skills/verify-squad/scripts/composition.mjs --case BT_U21 --variant 成功
node .agents/skills/verify-squad/scripts/composition.mjs --case BT_U21 --variant 失败
node tests/web-composition-negative.mjs
```

驱动复用生产服务、SQLite、provider fixture、进程监督器和构建指纹。丢回执在真实提交之后发生；旧快照也来自真实读取。产品写入经网页，数据库只读核对，不直接设置 React 状态或伪造 API 成功。

B2/B5 不需要真实供应商、官方登录或模型密钥：

```sh
node --import ./tests/service-composition-fault-loader.mjs --import tsx tests/service-composition-driver.mjs --case BT_K03
node tests/service-composition-negative.mjs
node --import tsx tests/inspector-generation-fixture.ts
```

B2 的 K05 六种顺序由 Gherkin 大纲驱动，单跑时可加 `--case BT_K05 --variant 定时、重复、完成`。诊断加载器只在独立测试进程观察/故障注入公开执行边界，不向生产代码增加开关；普通适配器 WorkFailure 不冒充 hostError。B5 复用真实观察模型及其生产控制器，不把已有 dispose-import 实例冒称本次两代交错增量。

B3/B4 的准备、会话序列、源码负对照与独立读回入口如下。读回使用前述 `npm run check` 生成的真实全量 `test-results/cucumber.json`，逐项核对当前适配器场景；手工单跑时也可显式传入专用 Cucumber 报告：

```sh
node --import tsx tests/preparation-composition-fixture.ts --all
node tests/preparation-composition-controls.mjs
node tests/preparation-composition-readback.mjs
node --import tsx --input-type=module -e "import { modelSessionComposition } from './tests/model-session-composition-fixture.ts'; await modelSessionComposition(false); await modelSessionComposition(true);"
node tests/model-session-composition-controls.mjs
node tests/model-session-composition-readback.mjs reports/kej-108-model-session test-results/cucumber.json
```

具体参数以脚本和对应说明为准。准备期使用真实文件系统和命名屏障处 SIGKILL，执行后端用于观察交付的目录，不证明 OS 沙箱隔离。模型会话用受控 HTTP 回应，不证明供应商输出质量。

## 读结果与保证边界

- 完整命令正常退出 0、报告为 verified、清理与源码未改变检查通过，才算该次验证完成。blocked、超时、缺依赖、队列未排空、加载失败或错误反例不能算通过。
- TLC 原始日志须显示声明域完整探索、零剩余队列，以及适用的独立活性检查完成。逐边回放每条抽象边使用一个真实可达前缀，不是所有具体历史的等价性证明。
- 独立读回按各入口声明的协议核对证据。新增组合读回要求原始 DOT、逐边 JSONL 和实际负对照记录；旧读回器的摘要与哈希检查不扩大为同等协议。
- B1/B2 的 `run.json`、HTTP/SQLite 读回、trace 或加载边界记录按各自驱动复核；它们没有通用的 TLC `--verify-evidence` 接口。Inspector 的通过标准是生产控制器的导航、注册、投递与资源断言，不是官方认证可用。
- 真实源码变异必须由原行为断言检出，不能靠构建错误或哈希漂移冒充；丢弃变异后复验原版。模型反例与代码变体的检出能力分别报告。
- 活性依赖各模型声明的弱公平、有限故障和可信结算假设。用户永不批准或未知效果永不核清时，安全等待是允许结果；不保证供应商一定返回，不撤回已经发生的物理副作用。
- 数据库事务原子性是模型假设。真实 CLI/SQLite 进程窗口提供接线证据，不证明硬件断电、OS 沙箱实现、跨主机锁或外部工具恰好一次。

## 维护

原四个技能的 KEJ-102–106 证据和源码审查是历史记录；KEJ-107/108 扩大了上表明确列出的有限域。当前同步提交、未提交源差异及精确文件哈希以各技能 `references/*coverage.json`、对应说明和本次运行的输入快照为准。不能把 HEAD 标识当作包含全部工作区修复的证明，也不能因只更新元数据而宣称又完整运行一次。

历史基线 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f` 对应 PR37 合并前的 head。PR37 已以 squash 提交 `d7b80a4b0e032d300a7201e2532238709eb601cf` 合入 main，两者完整树均为 `cb1c46eadee0eaa1ac4d17127f28dc1896c63203`。PR38 已同步该 main；保留原同步源码记录和覆盖哈希，不把纯提交历史变化当作源码漂移。模型维护与生产代码修复分开提交。

覆盖哈希只发现漂移。文件移动、守卫改变、新写入口、事务拆分或投影遗漏时，必须审阅真实差异，必要时修改模型、回放和负对照，完整运行与独立读回后才推进同步元数据。不得仅刷新哈希或放宽性质让真实缺陷通过。历史审查记录保留在各技能 references 目录。

请求维护时使用 `$create-formal-verification-skill`，指定仓库和对应技能。真实实现违反性质时保留反例；需要修复产品行为时，仍按 AGENTS.md 先场景、状态图、状态模型验证，再接入具体实现。
