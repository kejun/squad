# KEJ-89：独立分片并行与归并

## 需求与选择

用户希望输入理解识别 map-reduce 类任务后并行创建多个 sub-agents。已有 discussion 通道已经提供不同成员的独立 intent、持久化执行 actor、领取回执、并行执行与结果归并；复用它比建立第二套子任务调度器更小，也保留共享预算、成员锁、停止和版本隔离。

这里的 sub-agent 是现有成员的独立单次执行上下文，不新增永久成员。输入解释可为 request/supplement 给出 2–8 个相互独立的只读分片和归并要求，不能指定成员或工具。宿主根据现有成员、锁和基础请求额度分配，并持久化分片与成员对应关系；分片超过可用成员或启动预算时整体回退给负责人。没有自动拆分串行依赖或权威工程写操作。真实供应商的意图识别质量仍需另外评估，本次以受控模型边界验收产品调度。

参考既有实现：`src/task/discussion.ts`、`src/task/facts.ts`、`src/task/execution.machine.ts`；行为建模遵循仓库 `AGENTS.md` 与其链接的 Cucumber 指南和 Uncle Bob Mode。代码保持原始用户条件及工具权限，不把分片答案提升为指令。

## 按顺序实施的记录

1. 阅读规则、输入解释、主任务状态机、并行讨论、预算、执行器及既有测试，确认可复用通道与安全边界。
2. 写 `features/26_map_reduce.feature`（BT_Q01–BT_Q06），更新 README 入口与 `docs/state-diagrams.md` 的「并行分片生命周期」。
3. 扩展输入契约与纯状态转换：输入记录一次应用、宿主分配成员、全部分片结算才归并、资源不足整体回退。
4. 基线红测 8 失败/2 通过，加入模型后 10 项真实 XState 测试通过。随后为显式分片成员对应表增加断言，见到 1 失败/9 通过，修正模型后全部通过；补充输入边界用例后共 11 项通过。所有模型门槛不调用数据库、网络或文件系统。
5. 模型门槛通过后，接入 OpenAI 兼容适配器的分类、分片与归并提示。已有 WorkRunner 消费持久化 discussion intent，无额外调度器。
6. 新增 HTTP 屏障、SQLite 恢复和 Gherkin 绑定。屏障在任一响应返回前确认两份模型请求均已开始，不以多条消息冒充并行。失败或 partial 不因归并声称成功而变成完整交付。
7. 独立审查无阻断；按反馈将额度说明修正为启动基础请求检查，明确工具续办/重试额外消耗不受预留保证。

## 模型门槛与实际检查

- `npx vitest run tests/map-reduce-model.unit.test.ts --maxWorkers=1`：11 项通过。
- `npx vitest run tests/input-intent.test.ts tests/background-discussion.test.ts tests/map-reduce.test.ts tests/map-reduce-model.unit.test.ts --maxWorkers=1`：加入最后一项补充输入模型测试前，72 项通过；最后模型用例单独通过，不能混称为该次 73 项运行。
- `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/26_map_reduce.feature --import 'tests/bdd/*.ts' --format progress`：10 个展开场景、321 步通过。
- `npm run build`：生产与网页构建通过。
- 最终完整 `npm run check`：三份 TypeScript 检查通过，61 文件、770 项 Vitest 全部通过；Gherkin 715 场景中 713 通过、2 失败（23818 步通过、5 跳过、2 失败）。两项失败是本环境缺少原生 OS namespaces；外层检查同时报告 scripts/test.mjs 的 90 秒 ETIMEDOUT，因此聚合检查退出 1，规格覆盖未执行。日志为 `reports/kej89/check-final.log`。不可将这次验证描述为完整通过，也未排除场景、放宽断言、增加总超时或将空 CI 当作通过。

模型源码 SHA-256：

- `src/task/map-reduce.ts`：79eb3c2530e91e8a94adf3609c1cc995530ce4383db2374247805dab83e97d3a
- `src/task/reducer.ts`：48a18cc50d89ff9e0a68409e2b80fa3e744b1dd89f8ea45b4ac60c27fa41cd62
- `src/input-intent.ts`：7b6d7dc6b87eedf42733f2adbd9c26f3d7b1779d07b06e3d0ae80efb6ebd2fb3

## 交付边界

基于 a50386dd43136fad60818065d9736259dbcf5fd4，独立工作树保存全部修改。之前 GitHub fetch 的 CONNECT 403 不能由插件只读 SHA 核对替代，因此尚未提交、推送或合并。独立云线程的输入解释与协作快照修复未被覆盖或宣称已整合。最终提交前仍需获准同步最新 main，完整验证最终组合；只有该提交实际完整 CI 成功才可合并。
