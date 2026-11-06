# PR40 形式化 CI 修复

## 原因与复现

PR head `21ee46039f594d9b93d400bf703e14d42fab2b0e` 的 Complete verification 已成功；Formal verification 在首个 handoff 检查的源码漂移门禁退出1，尚未执行TLC。原同步基线为 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f`，KEJ-98／99改变了14个handoff已覆盖文件。其余三套检查原样运行也因覆盖漂移blocked。直接运行 `python3 .agents/skills/verify-squad-handoff/scripts/check.py` 可在毫秒级复现同一错误。

此前实现任务时没有同步独立形式化对应记录；不是普通测试失败，也不能用重新跑普通测试或仅刷新哈希解决。

## 对应审查与修复

四套技能各自按本地maintenance流程读取旧同步到上述head的全部覆盖差异。每套的 `references/drift-review-pr40.json` 保留逐文件旧新指纹、分类、理由和证据；新增artifact-request、source-artifact、map-reduce-capacity纳入传递依赖漂移门禁。同步只在审查后的候选完整验证成功后推进，随后按技能再次完整运行。

原TLA性质、状态域、故障预算和所有真实代码负对照保持。新增来源和模型解析分支在旧有限切片之外，回放增加显式缺席断言，避免将其悄悄投影忽略。coordination另加0/1/2/4容量、恢复4→3及legacy字段缺席的双存储有限实例，以及5种容量真实代码破坏对照；它们不冒充TLC对容量状态的全域穷举。恢复实例的适配器校验读取当前ticket中的3而非准备时的4；schema合法旧解释仍独立通过当前派发守卫整份回退。

模型/脚本、配置、覆盖清单、对应文档及本轮审查记录随证据保存。修正了delivery/authority维护模板误指handoff的命令和路径。此次修改限验证及记录，不改产品、CI断言或时限，不新增跳过。

## 本地验证

固定TLA+ Tools v1.7.4 / TLC2.19，SHA256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。Java21，当前checkout锁定依赖。每套都执行完整模型、MemoryStore/SQLite逐边回放、可达性见证、隔离真实代码负对照、删除变体后的原实现复跑，以及独立 `--verify-evidence`。证据包含每步命令、退出码、原始日志及清理状态。

| 检查 | 既有有限域与真实对照 | 最终本地证据 |
| --- | --- | --- |
| handoff | 146状态、424边；4类双存储真实负对照、6个见证 | reports/verify-squad-handoff/20261106T102156Z-29383 |
| delivery | 31状态、79边；9个回执快照损坏输入、3类双存储真实负对照 | reports/verify-squad-delivery/20261106T102020Z-27971 |
| authority | Execution 8状态/19边、Host 48/174、SessionScope 512状态；6类真实代码负对照 | reports/verify-squad-authority/pr40-final |
| coordination | Budget 151/345、Shards 456/1379、CheckBudget 117/237；原11类加容量5类真实负对照 | reports/verify-squad-coordination/pr40-final-21ee460 |

四套均为updated，两轮完整验证及独立证据读回全部退出0。handoff保留108件工件，delivery 81件；authority每轮34步全部满足原成功/预期失败判据。coordination首轮337.898秒、最终325.665秒均退出0；最终258件工件读回成功，19个可达性见证与16类真实代码对照在两种存储均因指定性质产生预期失败，原实现恢复后再次通过。所有清理及coveredFilesUnchanged（coordination另有checkerInputsUnchanged）均为true。最终三处对应修正（无source断言、当前ticket容量、完整审查输入打包）也已在最终证据中确认。GitHub将对本次验证维护提交重新运行Complete verification和Formal verification，远端终态在PR中核对。

此结论是有限抽象模型和代表前缀的实现对应检查。来源资格/正文语义、四片与所有资源状态的笛卡尔积、供应商质量、任意任务历史及底层断电可靠性仍不在这些模型保证内。KEJ-98／99的业务验收与完整测试由Complete verification独立承担。
