# KEJ-91 宿主能力发现

## 调研与取舍

现有 LocalRuntime 提供固定版本技能目录和受控 CLI，模型只能看到第一页技能元数据，不知道平台、沙箱状态或指定 CLI 是否存在。现有系统没有 MCP transport/调用接口，扫描账号配置无法把它变成可靠可调用能力，且可能暴露凭据。因此增加有界 discoverHost 只读动作，明确已探测与未探测、存在与可执行授权、MCP 未接入三种边界。复用技能、CLI 与任务持久化，不另造执行通道。

依据：现有 src/local-runtime.ts、src/local-cli.ts、src/local-operation.ts、src/model-adapter.ts；Node fs.access 的 X_OK 只证明当时访问条件，不保证随后执行成功，https://nodejs.org/api/fs.html#fspromisesaccesspath-mode 。

## 执行记录

- 2026-11-05：读取 AGENTS.md、Uncle Bob Mode、现有本地操作与测试；创建独立工作树，未触碰其他未推送修复。
- 依照锁文件安装当前工作树依赖。默认 npm cache 不可写，改用已有可写 npm-cache 后 npm ci --ignore-scripts 成功。未借用其他 node_modules。
- 先写 BT_L56–BT_L58 和状态图；能力发现沿用本地子操作生命周期，只扩展动作契约与免费元数据规则。

- 模型门槛先红后绿：新增动作尚未定义时 2 项预期失败；扩展纯动作契约和免费元数据规则后，真实 taskMachine 新增 15 项与原本地操作 44 项共 59 项通过。受测基线 a50386d 加工作树动作契约，命令：`node node_modules/vitest/vitest.mjs run tests/host-capabilities-model.unit.test.ts tests/local-operation-model.unit.test.ts --maxWorkers=1`。
- 门槛通过后接入 LocalRuntime、模型动作协议与执行详情标签。只提取 CLI 搜索 PATH，不读取整个账号环境来做能力发现；执行接口复用同一搜索路径函数。
- 新增定向单元/模型检查 20 项通过；直接 Gherkin 9 场景、282 步通过。BT_L58 使用脚本化模型响应验证真实 Adapter/Runner/SQLite/CLI 接线和上下文契约，不证明真实供应商模型总能正确选工具或绝不虚报。MCP 原生调用未实现，本服务明确返回未接入。
- `npm run check` 完整运行：生产、网页、测试类型检查通过；Vitest 61 文件 775 项全部通过；Gherkin 714 场景中 712 通过、2 失败（23081 步中 23074 通过、5 跳过、2 失败）。失败均为原生沙箱验收 BT_L19/BT_L22 所需 OS namespaces 不可用，未跳过或放宽断言，后续覆盖报告未执行。完整检查未通过，不能作为合并凭据。
- `npm run build` 通过。独立代码审查未见阻断问题；依其意见修正文档动作数量，并限定脚本化模型接线的验收含义。
- 提交前同步限制仍存在，未重试被拒绝的 GitHub CONNECT 路径，也未绕道发布；保持本地未提交变更，由父任务整合与核实交付。
