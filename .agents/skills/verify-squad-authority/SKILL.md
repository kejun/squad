---
name: verify-squad-authority
description: "验证 Squad 的一次性执行许可与按次宿主审批、工作区租约、停止和恢复后的旧授权拒绝。更改 beginExecution、执行子状态机、LOCAL_* 守卫、事务存储时运行；不证明宿主 OS 副作用撤销。"
---

# Verify Squad authority

保护用户承诺：外部执行前必须取得一次性已提交许可；宿主命令必须持有对应、未过期审批和工作区独占权，停止或恢复后的旧许可不能启动命令。违反承诺可能重复执行或在授权撤销后启动命令。

先读 AGENTS.md 和 [实现对应](references/correspondence.md)。本技能只运行验证，不启动真实宿主命令，不改产品、凭据或用户数据库。

## 一条命令

仓库 Node 22.18+/24.11+、npm ci、Python 3.10+、Java 11+。准备官方 TLA+ Tools v1.7.4（TLC 2.19）的 tla2tools.jar，SHA256 必须为 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88：

```sh
TLA2TOOLS_JAR=/absolute/path/tla2tools.jar python3 .agents/skills/verify-squad-authority/scripts/check.py
```

默认使用 ~/.cache/squad-formal/tla2tools-1.7.4.jar（尊重 XDG_CACHE_HOME），首次从官方固定发行下载并校验 SHA，下载上限 50 秒。可用 TLA2TOOLS_JAR 或 --jar 指定已有 JAR。单子进程上限 90 秒，TLC 一个 worker、512 MiB 堆。有限范围通常数十秒完成。超时、缺依赖、漂移或不完整探索均失败。输出 reports/verify-squad-authority 下新证据目录；--evidence 可选择新目录，不能覆盖已有结果。

随后对输出的实际目录独立读回：

```sh
python3 .agents/skills/verify-squad-authority/scripts/check.py --verify-evidence reports/verify-squad-authority/实际运行目录
```

完整退出零且 run.json.status=verified、cleanup=true、coveredFilesUnchanged=true 才通过。核对两份 TLC 日志的完整完成消息和最终队列为零；不把反例的非零退出与基线失败混淆。artifacts.json 校验保留日志与数据；不能用一份总结替代原始日志。篡改、缺文件与运行不完整会拒绝读回。

## 精确范围

三个独立有限抽象：
- Execution：一个已经成功领取的 owner intent，固定 attempt=1。启动、停止和一次重开恢复可任意交错；检查旧 permit 至多一次、停止/恢复拒绝重用、事务失败不提交许可。
- Host：一个已经准备好按次审批的 runCli 操作，固定旧 approval ID 和 parent attempt，四个授权阶段。审批、领取、启动、一次到期、停止、恢复、另一个所有者占据工作区可交错。每个可达状态还以真实公开入口尝试 Start/Claim/Approve/错误 ID，逐项核对允许或拒绝。

- SessionScope：namespace、workspace、host、account、environment、epoch、goal、stopped 八个二值输入，256 个组合加 revoked 投影共 512 状态。它是对真实 hostSessionMatches 的有限输入域对应检查，不是 512 条事务可达历史证明。输入由已成功持久化会话快照克隆，分别扰动作用域字段。

实际 TLC 规模由日志报告，不预填成功数字。每条抽象边重放一条最短前缀，再从每个可达状态重放许可探针；MemoryStore/SQLite 分别执行。SQLite 实际关闭并重开。固定时间从 1 到 900（审批到期，工作 deadline=1001），不调用真实外部适配器。

主许可模型的安全结论覆盖旧授权。补充 20 条公开入口双存储生命周期实例验证 queued/claimed × revoke/recover/goal/stop/continue：新审批可恢复、新 epoch 可启动而旧 permit 不可、旧 goal 结果拒绝、uncertain 正确/错误 session 回执隔离及结算后租约释放。这些是有界实例，不冒充全部组合历史的穷举。

另执行 10 个真实 LocalRuntime.execute 参数/文件变体，验证审批 digest 绑定 args、requestHash、workId、epoch、goal、workspace 内容、可执行文件、环境及期限。正常对照到达启动回调后主动抛错阻止 spawn，所有变体都必须在回调前拒绝，实际命令启动数为零。不是 OS 命令执行或进程回收测试。

取消类 intent、无限多轮、物理进程结束、跨主机锁、磁盘断电和永久故障不在本轮模型范围。工作区 lease 是 Store 的所有者互斥记录，不是带 TTL 的分布式租约。不要把拒绝后续启动说成已经执行的副作用被撤回。

这是有限抽象穷举 + 代表前缀真实代码对应检查，不是 TypeScript 机器证明；不同具体历史可能有未投影的差异。模型以既有事务原子性和可信 runner 为假设。Started/Usable 的可达性见证与恢复实例证明授权满足时存在可推进路径，但不声称自动活性：用户未批准、其他工作区持有者未释放或效果未核清时，永久等待是允许的安全结果。正路径由 StartedReachable 反例见证，不代替公平性证明。

## 故障检出

在独立临时源码副本中删除以下真实检查，分别在两种存储上要求 Authority 行为断言失败，而不是导入错误：
1. startTaskExecution 的 authorized 一次性前置检查，重复 Start 必须被检出。
2. approval ID 精确匹配，错误审批不能被接受。
3. LOCAL_CLAIM 的 leaseAvailable 检查，另一所有者占据时不能领取。
4. LOCAL_STARTED 的审批到期检查，已经领取但审批过期后不能启动。
5. hostSessionMatches 的 namespace 限制，跨作用域输入必须拒绝。
6. LocalRuntime 的 commandDigest 比较，批准后参数变化必须在启动边界前拒绝。前五项双存储分别执行，第六项是实际文件/运行时入口测试，不伪称存储依赖。

所有副本退出时删除；随后重跑原实现，并核对全部覆盖源文件未被修改。模型另有移除失效守卫的变体，必须违反 NoUnauthorizedStart。模型本身不感知 TypeScript 修改，故真正检出依赖回放而不是源文件哈希。一个负对照不证明对所有缺陷敏感。

## 维护

[coverage.json](references/coverage.json) 的 syncCommit 为 cd987f2f4a7e29ad3efae1af36a0f432ce813c8f（PR37 合并前的 head；现已 squash 合入 main d7b80a4，两者完整树相同）。保守记录全部 src TypeScript、依赖锁与夹具哈希；哈希仅为漂移门禁，不是对应证明。文件变化先审查模型原子边界、权限守卫和新写入口，不能直接刷新哈希。模型/回放通过并完成真实负对照后才能推进对应基线。

请求 `$create-formal-verification-skill 维护 kejun/squad 的 verify-squad-authority`，按 [维护过程](references/maintenance.md) 执行。发现真实违约保留反例，区分模型缺陷和产品缺陷；不能放宽性质让它通过。
