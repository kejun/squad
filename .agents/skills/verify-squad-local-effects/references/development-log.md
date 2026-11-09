# 开发与验证记录

本轮只编辑验证；产品基点 `64322436c87b216f9dd9ba1a137738e5cd923497`，实际同时开发的产品源字节由 coverage.json 固定。没有把 HEAD 名称当脏工作树源码的完整身份。

1. 完整阅读 AGENTS.md、Uncle Bob Mode、formal-generator maintenance 与 TLA 结果规则；核对 authority/handoff 的有限域和排除项，确定不重复其启动许可/已保存协助结果切片。
2. 先编写 BT_L90–BT_L93、验证图及真实模型门槛，既有 taskMachine 纯转换通过；未修改产品 XState 或业务行为。
3. 先搭一个真实公共接口单位轨迹，再抽取 LocalEffectsFixture；租约观察器最初先探测 owner 导致空闲锁被观察重新获取，属于验证器错误。改为先用陌生 probe 在同一观察事务中获取/释放，再用幂等 owner 探测；不改产品，不弱化独占性质。
4. 建立 LocalEffects.tla 的真实动作边界，prepared/确定回执与任务事务分离。首轮完整有限模型为108状态/282标记边，双存储逐边对应均通过。
5. 新增有界故障加恢复/提交弱公平的 SettledProgress、六个可达性见证、四个真实源码突变及对应模型反例；保持原安全承诺。
6. BT_L90–BT_L93 直接 Cucumber 执行4场景、20步骤通过。全 tests/tsconfig TypeScript 检查通过。
7. 第一轮完整技能命令 `--evidence reports/verify-squad-local-effects/kej107-first` 通过，62.839秒，137件原始证据；双存储每种282边，真实突变两种存储分别因指定行为失败，移除副本后原模型和实现重新通过；KEJ-103三模式与KEJ-104四窗口全部通过，临时资源清理与覆盖源未变均为true。
8. 第一轮证据独立 --verify-evidence 读回通过。随后加强读回对全部逐边JSONL的完整性和TLC原始计数核对，并把默认JAR路径改为用户缓存；不改变模型、性质、边界和运行回放。

9. 最终完整命令 `--evidence reports/verify-squad-local-effects/kej107-final` 通过，50.743秒；同一108状态/282边、基线/恢复的安全与活性检查、全部双存储负对照和7个实际进程接线均通过，覆盖源未变及清理true。独立读回138件证据通过。
10. 在临时证据副本中分别篡改原始TLC日志、删除一条JSONL且同步更新manifest，读回分别以证据SHA变化和逐边记录不完整拒绝；副本已删除。
11. 进一步加入Reopen的单任务/无flush/未到期可执行切片断言；wrong-session负模型现在完整提交错误回执并违反专门SessionBound，而非伪造半检查点。prepared日志负模型改为falseNotStarted分类观察位，仅在NoFalseNotStarted检出，不声称已经重排或再次物理写入。每次TLC使用独立java-tmp，避免并行提取标准模块竞态。
12. 原样最终命令因src/web/service.ts新增closing守卫而正确blocked；逐项审查e77f052，主图不调用WebService，实际接线在await ready后关闭，原协议/事务边界不变。对应记录在drift-review-kej-107-108.json，不直接刷新hash掩盖漂移。
13. e77f052产品源完整运行 `reports/verify-squad-local-effects/kej107-e77f052-final` 通过54.166秒，108状态/282边、双存储逐边/所有正负见证/恢复原实现及7条进程接线全部通过；独立读回139件证据成功，全部清理和源未变true。此证据保留为当时的历史完整轮。
14. 将全部77个覆盖实现/驱动/依赖原文保存在checker-inputs/implementation，读回按捕获coverage逐一核对字节SHA，且强制完整安全性质与SettledProgress配置、原始负对照JSON/log/diff、双存储逐边实际投影。最终完整运行 `reports/verify-squad-local-effects/kej107-inputs-complete` 通过54.507秒，模型与边数不变，216件证据独立读回通过，清理与源未变true。
15. `tests/local-effects-formal-readback-controls.py` 对最终证据临时副本运行四类独立反控：改原始TLC日志、删一条JSONL并重签、删全体真实负对照并重签、删真实负对照JSON/diff并重签，均被拒绝；原件前后读回通过且未变。保留可复现脚本、reader及原始日志在 `reports/formal-readback-controls/local-effects-all-four`。

最终完整重跑及独立读回见 coverage.json.review 与最终证据的 run.json。证据目录中的 checker-inputs 是该次实际输入，后续只推进同步元数据时不冒称又重新运行。
