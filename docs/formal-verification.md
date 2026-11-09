# Squad 有限形式化验证

本组验证检查容易被实例测试遗漏的故障顺序，并把抽象迁移回放到真实实现。它不是整个 TypeScript 程序的机器证明，也不证明外部服务、操作系统、SQLite 或文件系统本身正确。

## 入口

先执行 `npm ci`，再按本次变更涉及的边界选择命令。需要 Node.js 24.11+、Python 3.10+、Java 11+ 和 curl。每个入口验证固定 TLA+ Tools v1.7.4 JAR 的 SHA256，不需要模型服务密钥或真实外部工具。

```sh
python3 .agents/skills/verify-squad-handoff/scripts/check.py
python3 .agents/skills/verify-squad-delivery/scripts/check.py
python3 .agents/skills/verify-squad-authority/scripts/check.py
python3 .agents/skills/verify-squad-coordination/scripts/check.py
```

CI 的 `Formal verification` 作业顺序执行四个入口，并保留 `reports/verify-squad-*` 下的原始日志、反例、回放和完整性清单。该作业独立于 `Complete verification`；形式化检查通过不能替代普通回归、Gherkin、构建或原生沙箱验收。

## 从改动找到验证

| 代码边界 | 验证技能 | 工单 |
| --- | --- | --- |
| B 结果消费与 A 续办的原子交接、幂等、停止 | [verify-squad-handoff](../.agents/skills/verify-squad-handoff/SKILL.md) | [KEJ-92](https://linear.app/kejunz/issue/KEJ-92) |
| 固定技能证据、候选审查与最终发布记录 | [verify-squad-delivery](../.agents/skills/verify-squad-delivery/SKILL.md) | [KEJ-93](https://linear.app/kejunz/issue/KEJ-93) |
| 执行许可、停止恢复、宿主审批与工作区租约 | [verify-squad-authority](../.agents/skills/verify-squad-authority/SKILL.md) | [KEJ-94](https://linear.app/kejunz/issue/KEJ-94)、[KEJ-95](https://linear.app/kejunz/issue/KEJ-95) |
| 请求预算、有界重试、并行分片归并 | [verify-squad-coordination](../.agents/skills/verify-squad-coordination/SKILL.md) | [KEJ-96](https://linear.app/kejunz/issue/KEJ-96)、[KEJ-97](https://linear.app/kejunz/issue/KEJ-97) |

每个技能记录自己的精确边界、初始前提、原子步骤、保证与排除项。不同技能的模型不能直接拼成全系统证明。一个属性在某个有限切片通过，不代表其他流程、任意并发数或无限故障也通过。

## 读结果

- 只有完整命令退出 0、报告状态为 verified、清理与源码未改变检查通过，才算该次检查完成。超时、缺依赖、队列未排空和 blocked 均不算通过。
- 每个技能支持 `--evidence` 指定新的证据目录，以及 `--verify-evidence` 独立校验已经保留的结果。读取本次原始 TLC 日志，不从示例统计推断实际覆盖。
- 模型检查穷举声明的抽象有限域；逐边回放为每条抽象边选择一个真实可达前缀，不是全部具体历史的等价性证明。
- 真实代码负对照必须被行为断言检出，不能用源码哈希漂移、构建错误或依赖失败代替。模型变体与真实代码变体的检出能力分别说明。
- 公平调度与最终恢复属于明确假设，不因一个成功运行被证明；无法撤回的外部副作用不因任务停止而消失。

## 维护

当前 KEJ-102–105 对应审查的产品/包基线为 `32c26b376b46ae1a03718a6820683b59b802b413`，逐文件判定和完整正负检查、恢复复跑及独立读回见四个技能各自的 `references/drift-review-kej-102-105.json`。原 TLA+ 状态域、性质和公平性未扩张；真实 HTTP 字节限制、进程终止与 SQLite 物理边界由独立验收提供证据。

历史基线 `cd987f2f4a7e29ad3efae1af36a0f432ce813c8f` 对应 PR37 合并前的 head。PR37 已以 squash 提交 `d7b80a4b0e032d300a7201e2532238709eb601cf` 合入 main，两者完整树均为 `cb1c46eadee0eaa1ac4d17127f28dc1896c63203`。PR38 已同步该 main；保留原同步源码记录和覆盖哈希，不把纯提交历史变化当作源码漂移。模型维护与生产代码修复分开提交。

覆盖哈希只负责发现漂移。文件移动、增加写入口、守卫改变、事务拆分或投影遗漏时，必须审阅真实差异并更新对应关系，不能仅刷新哈希。维护交接技能时已发现旧 sync commit 与部分旧哈希实际版本不一致，逐文件审查记录保留在其 references 目录。

请求维护时使用 `$create-formal-verification-skill`，指定仓库和对应技能。真实实现违反性质时保留反例；需要修复产品行为时，仍按 AGENTS.md 先场景、状态图、状态模型验证，再接入具体实现。
