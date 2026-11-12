# 可行动的共享工具经验

原始要求：把“中间产物放工作区、OCR 用 stdin”等已验证配方固化进工具知识，减少下一轮试错；经验应说明“在特定条件下，采取具体行动，以获得预期结果”。

## EARS 与核查

| 编号 | 要求 | 直接验收 |
| --- | --- | --- |
| EXP-01 | 当允许使用本地工具的成员请求模型决策时，系统应提供包含适用条件、具体行动、预期结果及证据级别的工具经验。 | BT_Y140 |
| EXP-02 | 当新任务或服务重启后开始工具决策时，系统应提供有版本和验证来源的工作区中间产物配方。 | BT_Y141 |
| EXP-03 | 在同一会话保存了旧任务的已结算能力发现回执且配置及当前能力匹配时，系统应允许下一任务复用该能力事实；如果配置或能力变化，则应拒绝沿用。构建一次模型请求时，历史任务数量增加不得导致重复读取整个会话的次数增加。 | BT_Y142 |
| EXP-04 | 如果来源失败、效果不明、已停止、旧目标、旧轮次、成员不允许工具或来自其他会话，则系统不得把它提供为当前资源已获取的成功证明。 | BT_Y143 |
| EXP-05 | 当已选择的 OCR 工具明确支持 stdin 且输入文件已在工作区时，系统应提供通过结构化 stdin 文件输入取得 OCR 文本的配方，并要求本次独立执行与正常宿主授权。 | BT_Y144、BT_Y145–Y148 |

核查：五条保留用户的条件＋行动＋结果目标。内置配方是版本化的执行知识，不是当前文档正文或宿主批准。历史能力事实只从同会话已持久化任务回执派生，不建立跨会话的全局经验文件，删除会话自然删除来源。旧任务的成功读取不证明新资源、当前认证或最新性。OCR 的 stdin 文件传输及审批绑定由独立 stdin 契约验收；本配方不假称所有 OCR 命令都支持 stdin。

## 最小数据契约

`ToolExperience` 含 `condition`、`action`、`expectedResult` 和 `evidence`；条件保留配置、执行环境及资源范围，行动是指导或明确模板，结果声明必须重新验证。`observationOnly:true`、`executionAuthority:false` 和 `requiresIndependentExecution:true` 永久成立。证据区分受控执行配方、能力元数据及宿主验证的资源内容。任意进程退出零或模型自报字段不能升级为资源正文证明。

效率约束：当前 `tool_inventory` 已包含全部目录正文时，其他观察只保存可核对的目录版本引用及能力事实，不重复注入相同的完整目录。相同历史能力快照可合并为一条，必须保留每个来源 operation 标识；不同能力事实不得因固定条数或字符预算消失。目录版本不匹配时明确标记该引用不能复用。BT_L116 同步移除旧十条及十六千字符退化规则，未知信息仍保持未知。

## 模型先行边界

该变更是只读观察投影，不引入新的业务生命周期。沿用真实 XState 的 `LOCAL_REQUEST → LOCAL_CLAIM → LOCAL_STARTED → LOCAL_RESULT`，以及失败、效果不明、STOP、epoch/goalVersion 和成员权限守卫；先运行 `tests/shared-tool-knowledge-model-fixture.ts` 的全部边界，再接入模型请求。执行配方仍由持久化意图、领取和原审批路径执行。这里没有独立状态可建，禁止用提示文本代替模型守卫。

OCR 具体例子使用本轮受控 tesseract stdin 运行验证；它不是用户旧机器命令的历史回放。生产配方要求先确认所选工具的 stdin 协议及所需语言包。

实测来源：`features/69_cli_stdin.feature` 的 BT_Y145，在 `tests/cli-stdin-acceptance.ts` 中于工作区 `.tmp` 生成 PGM `HELLO` 输入，持久化 `runCli` 后执行 `tesseract stdin stdout --psm 7 -l eng`，通过结构化 `stdin.path` 输入，核验 stdout 的 `HELLO` 及后续仍可读取的工作区文件。配方验证器为 `squad-cli-stdin-acceptance / BT_Y145`；拒绝、输入变化和取消分支由同组场景覆盖。该证据验证传输与配方，不声明任意图片或语言的 OCR 准确率。


## 验证记录

模型门槛先于具体接线：真实 `toolKnowledgeModelGate` 的成功、失败、效果不明、旧目标、旧轮次、停止、成员工具关闭、输入理解及仅退出零路径通过；复验真实 `taskEfficiencyModelGate` 的完整能力事实与并发路径。被测对象为当前工作树的 `taskMachine`，每步经真实持久化/恢复，不使用替身状态图。

直接场景命令：`env -u MODEL_API_KEY TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/46_shared_tool_knowledge.feature features/47_task_efficiency.feature features/68_tool_experience.feature features/69_cli_stdin.feature --import 'tests/bdd/*.ts' --format progress`，50 场景、3164 步通过。它验证接线、观察和受控命令执行，不代表真实模型选择准确率。

`node tests/tool-experience-negative-controls.mjs` 在拥有的临时完整副本分别删除历史配置和目录版本守卫，两次均被不变的真实 SQLite/runner 验收业务断言检出；恢复后通过，完整源码指纹一致，活工作树未变，临时副本已清理。不把导入、环境、超时或解释器错误计为检出。

批量历史读取的性能回归由 BT_Y142 的“多历史任务不放大读取”直接验收：真实 SQLite 和完整模型请求中，旧实现随样本历史增长从 22 次整会话读取增至 30 次；同批快照实现保持 19 次与 19 次，仍保留全部 8 个已结算来源。断言比较读放大，不绑定固定调用次数或私有 getter 实现。修复前先复验真实模型八类成功/拒绝路径；`TeamEngine.viewTasks` 统一拥有存储解码，执行器不复制快照恢复协议。
