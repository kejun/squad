# PR #64 CI 修复

## 输入与 EARS 核查

原始要求：“解决 squad 项目的 ci 报错”；补充：“要拉 ci 的分支”。

- CI-01：当验证 PR #64 的修复时，应使用失败 CI 对应分支 `cursor/kej-115-tool-discovery-3986` 的源码作为基线。
- CI-02：当该分支执行既有 CI 检查时，相关检查应按当前产品契约通过，同时保留故障、缺口、协议拒绝与执行边界的有效保护。
- CI-03：当当前候选收到完整合法的未核实结论时，系统应按已有 BT_F15、BT_F21、BT_F27 契约保存结论、在正文声明缺口并正常交付，且继续执行真实资源采集与未决物理效果门禁。

核查通过：基线为 `189cb5a7a821d93ae021595a8d6eb558cb2a4646`，对应运行 https://github.com/kejun/squad/actions/runs/43420053885 。需求不要求恢复已移除的审核回环、降低断言、跳过检查或修改产品行为。PR #63 的旧失败另行保留，不混入本次分支。

## 已核实的契约与范围

- #60 已采用最新有效的下游结论；`features/74_downstream_handoff.feature` 的 BT_H201 明确规定历史讨论失败不否决当前通过结论。
- 背景讨论测试与仿真仍将历史故障等同于最终 partial；必须保留故障材料及交接断言，并依据夹具实际给出的检查结论断言终态。
- 检查协议技术补试可增加诊断，但固定资料不变；检查员可进行合法补救工具调用，畸形工具请求仍应拒绝。
- 负面有效检查结论直接交付缺口，不恢复旧的作者修订与审核回环。
- 渐进工具发现调整了固定检查提示词，故障注入锚点需对应当前生产源码，仍要求每项突变被原契约检出且恢复后通过。

首轮仅同步测试表达、仿真与验证记录。全量 BDD 随后暴露该分支在交付状态模型中新加的“全部 unverified 且非 MapReduce 则部分结束”回归，违背现有 BT_F15、BT_F21、BT_F27 与 BT_H210。先明确原 Gherkin 的适用范围，再细化状态图，最后删除该模型分支；复验既有纯状态模型通过后再做集成验证。无需新增 XState 状态或具体 I/O 实现。

其余测试表达修复适用 AGENTS.md 的对应豁免，无新增单元测试；在既有集成与模型检查中明确断言缺口材料完整交接及最终正文，保留相应验证边界。稳定性测试保留人类跳过决定及传给检查员的执行记录；目录故障注入使用稳定业务消息，原目录数量断言不变。其他旧的作者修订、检查工具禁令和失败即不发布预期按已有单向交付契约同步，保留版本、要求与缺口断言。

BT_M10 的引文样本改为拒绝空来源标识，避免重建 BT_H203 已取消的引文语义二次审核；BT_M30 保留编号，按 BT_H210 同步一次技术补试后直接交付合法负面结论及缺口，不再期待作者修订和复核。讨论负责人夹具从实际工作输入读取缺口并写入正文，保留原预算消息断言。

## 操作与验证记录

1. 读取仓库规则与 Uncle Bob Mode，核对干净工作区、远端与 CI 日志；拉取失败分支并创建独立修复分支。
2. 在原始基线执行 `env -u MODEL_API_KEY node node_modules/vitest/vitest.mjs run tests/background-discussion.test.ts tests/discussion-simulation.test.ts --maxWorkers=1`，复现 9 个失败测试（仿真报告含 20 条失败轨迹）。去除环境注入密钥仅用于隔离离线夹具，不改变 CI 配置。
3. 另组复现 model-regeneration 的 3 个失败与 shared-agent-behavior 的突变锚点漂移；按当前契约同步相关检查。

4. 定向验证完整退出 0：讨论 Vitest 32/32；BT_T05/BT_T06 直接执行 7/7 场景；讨论纯模型仿真 195/195、144 种返回顺序、8/8 状态；模型再生 Vitest 11/11；模型再生 feature 直接执行 68/68 场景；shared-agent-behavior 3 种突变全部被 HTTP 业务断言检出，9 个子进程自然退出且清理完成。

定向命令分别为 `env -u MODEL_API_KEY node node_modules/vitest/vitest.mjs run tests/background-discussion.test.ts tests/discussion-simulation.test.ts tests/model-regeneration.test.ts --maxWorkers=1`、`npm run simulate:discussion`、设置 `TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json` 后通过 Cucumber 运行 `features/20_model_regeneration.feature` 及讨论标签，以及 `node tests/shared-agent-behavior-negative.mjs`。这些开发阶段结果对应未提交工作区；最终提交的完整检查及远端 CI 另行读回核对。
