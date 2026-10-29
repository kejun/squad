# 本地技能与 CLI 验证记录

实现从 `d526aac` 开始，遵循 Gherkin → 状态图 → 真实 XState → 模型仿真 → I/O 接入顺序。BT_L01–BT_L13 在 `features/24_local_skills_cli.feature`；细化图在 `docs/state-diagrams.md` 的「本地技能与 CLI 子操作」。

## 接入前模型门槛

`node node_modules/vitest/vitest.mjs run tests/local-operation-model.test.ts --maxWorkers=1`：9/9 通过。模型使用真实 `taskMachine`，每个事件后序列化再恢复，所有时钟及回执受控，无文件、模型或进程 I/O。

受测模型 blob：`task.machine.ts=473c37e48c7cd6509863ea827dbb82c0495fbc82`；`local-operation.ts=dc16b0876770d6202aedeaa71766d7c282ff33fb`；`types.ts=076af7a7e51830052651ebd4bf60af54e3ee312b`。后续模型变化必须先复验再继续接线。

关键轨迹：父工作 inflight → LOCAL_REQUEST queued → LOCAL_CLAIM claimed（ordinary +1）→ LOCAL_STARTED running → LOCAL_RESULT succeeded（回执与模型检查点一同保存），父工作仍 inflight。STOP 将 claimed/running 置 cancelling，SETTLE 被拒，直到会话确实退出。RECOVER 将已领取且无回执的写入置 uncertain，并保留锁；仅可信的 LOCAL_RECONCILE 能解除。已保存成功回执恢复后可直接交给原 Bot，不重跑 CLI。

覆盖普通预算、评审/讨论汇总保留、check 子操作普通预算、元数据免费、权限撤销、旧 payload 无授权、版本失效、身份冲突、迟到回执、未结算交付与四类崩溃边界。

## 执行边界

固定 Anthropic Sandbox Runtime `0.0.81`（已核对其 allowRead、PID namespace、die-with-parent 和依赖探测实现）。当前验证宿主的 bubblewrap 返回 `Creating new namespace failed: Operation not permitted`；生产后端必须如实返回不可用，不能把受控进程夹具当作 OS 隔离验证。后续集成记录须区分真实子进程测试、策略测试和实际 OS 沙箱验收。

## 最终模型与集成覆盖

后续按同一顺序补齐了 queued 拒绝回执、可信核对后的父阶段恢复、群/任务命名空间，以及后台操作不确定时保留方案师草稿；每次先修订场景/图，复验纯模型后再继续接线。

- 真实模型断言：`tests/local-operation-model.test.ts`，14项。全部事件都经持久化快照往返。
- `npm run simulate:local-tools`：8种角色 × 4种动作 × 8类结果，256个场景、1760次转移。含成功、失败、停止、领取前/后崩溃、回执后恢复、旧版本和撤权；`reports/local-tools-simulation.json` 记录逐步轨迹及模型 SHA-256。CLI、磁盘读取和模型返回均为合成事件；只有报告及模型摘要读写，不执行真实工具。
- 最终受测模型 SHA-256：`task.machine.ts=dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`，`local-operation.ts=57a5f88c8a8640d99dfe98166cdf40e371d30717e9ba1ddcbe38658f6ce39fce`，`types.ts=9c1b3801b9ec8e890909fde106a0de26a8dd30a3c85397cb5fd9461ab4f46482`。
- 本地工具集成：方案师、核查员、Builder、新增 Bot、协调员、check、后台讨论均走真实 WorkRunner → JSON 模型循环 → 状态机领取 → 技能文件/真实 Node 子进程 → 原 Bot 续办。模型 HTTP 返回受控，子进程真实执行；显式注入的 ControlledProcessBackend 不提供 OS 隔离。
- 注册表覆盖损坏 YAML、缺失根、同名、顶层链接、包内逃逸、激活前修改、旧快照跨重启、路径穿越和缺失版本。
- 执行覆盖同一工程的真实排队、SQLite/内存跨群租约、重复消息 ID 的默认目录及副本隔离、未完成命令不解锁、核查副本输出、缺命令/后端、非零退出、超时、取消与后代、控制字符导致的转义后大输出、会话核对及过期摘要拒绝。
- 恢复覆盖5个窗口（请求前、已保存未领取、领取后未启动、启动后 DB 回执前、回执后模型前），并额外经过真实 WebService 启动：确定回执先补交再调度，可能已启动而无回执时不发新模型请求/命令。格式修复不重复写入。
- 网页继续复用已有执行详情，不增加 UI 组件；新 scope 透传、激活/命令记录、退出码、日志与持久回执恢复均由服务集成直接检查。没有新增浏览器目视验收声明。

`npm run check`：439项 Vitest、510个直接执行的 Gherkin 用例通过；新 BT_L01–BT_L18 共53例均直接执行。原有26个待验收用例保持原登记，未移除或隐藏要求。

`npm run verify:local-sandbox` 在当前宿主退出78：`CLI_SANDBOX_UNAVAILABLE: Required OS namespaces are unavailable`。这是真实生产后端的拒绝结果，不是隔离已通过。仓库提供了可重复的 OS 文件读取、快照写入、环境和网络验证脚本；部署宿主需要通过此项。首期 Linux、单服务/同一数据库；没有跨实例租约、Windows/macOS 后端或硬性 cgroup 资源配额保证。


BT_L17 在正面 CHECK_RESULT 提交前领取宿主 verifyWorkspace 子操作。权威工程变化、副本输入变化、输入改变后恢复均拒绝；仅 dist/test-results 等输出变化可通过。check 沙箱源文件只读、仅预建输出/临时目录可写；复核本身不运行 CLI。BT_L09 额外使用真实 npm run build，经工程内 node_modules/.bin 链接启动工具并生成 dist，证明副本链接与相对模块读取可用。

最终提交上复验 check/build 与模型仿真；生产入口也在隔离技能根下真实启动，GET /api/rooms 返回200，SIGTERM 正常退出并释放运行时锁。没有访问验证环境的个人技能目录。

BT_L18 跨 Bot、工作意图和运行时重启继承任务级技能版本；以更新后的目录按名称加载，仍使用旧正文、引用和脚本。迟到旧目标的激活回执不污染新目标绑定。明确目标变化或 replan 才重建任务绑定。

BT_L12 另覆盖执行协议版本不兼容后的可信回执：只结算旧操作，保留不兼容原因与 waitingHuman，不恢复父工作或重新授予本地执行权限。
