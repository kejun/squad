# HostRetry 实现对应、原子边界与遗漏

建立基线commit为64322436c87b216f9dd9ba1a137738e5cd923497，最终完整受测产品commit为e77f052acacd208fd8eb8587ac6901ba19003220。受测源含KEJ-108准备复用分支与WebService关闭门禁修复，其文件指纹记录在coverage及每次run.json。那些文件虽属于保守导入依赖，但本切片没有LocalRuntime/SkillRegistry文件I/O；模型不把它们的修复当作宿主批次性质证明。

## 数据映射

`mode`是四个由公共操作生成的前缀类型；`stage`投影首个续办LocalOperation.status；`parent`投影该批owner Intent.status；`batch`区分旧批/新批；`retirement`数旧批HOST_RETRY_BATCH_RETIRED轨迹；`successors`数第二来源hostRetryOf操作；`request`是第一HostRetryRequest.status。`online/recovered/expired`来自受控宿主和时钟，不从业务对象猜测。

公开前缀在tests/host-retry-formal-driver.mjs：TeamEngine.submit→claim(owner)→对两来源分别requestLocal/claimLocal/LOCAL_RESULT(failed sandbox)→requestHostRetry(first)→DELIVER（保存既有候选并建立批次）→claim(batch owner)→requestHostRetry(second)。成功/未知前缀经过LOCAL_CLAIM/LOCAL_RESULT；拒绝前缀经过准备具体审批和LOCAL_APPROVAL_DECISION(deny)。不直接篡改live store或拼写TaskContext，也不mock业务reducer。

## 原子动作

| 模型动作 | 实际入口与边界 |
|---|---|
| EndOwner | 一个TeamEngine.send(SETTLE)事务，release后真实XState的always顺序执行retireHostRetry→startHostRetry；提交时观察原快照与新快照，不拆解事务内部自动迁移 |
| RejectOwner | 一个HELP(self)事务返回SELF_DEPENDENCY，真实拒绝动作结算原owner并触发批次退休；不是假定非法模型输出无后果 |
| DeniedEnd | 首子操作uncertain时SETTLE被拒；只允许观察同一快照 |
| Reconcile | LOCAL_RECONCILE(receipt)事务：结算原子操作和请求、恢复父工作pending，未领取执行不能直接交接 |
| ClaimParent | 公共engine.claim事务；领取与后续结束分开可插入恢复/重复请求 |
| Crash | 仅把宿主对象标为不可调用，持久业务状态不变；这是环境抽象，不含实际进程/CLI效果 |
| Reopen | 新engine与一次RECOVER事务；每次可执行断言一个原任务、无待消费results、nextCheckAt与所有工作/request期限未到，因此额外flush/tick不提交其他业务事务。普通已结束批次在本图只可能是新批已建立，因此禁止在后继阶段再Crash，保持边界明确 |
| Expire | 只推进受控时钟至第一request期限，尚不发送业务事件；与后续EndOwner独立，验证已知拒绝/成功回执不能误记为过期 |
| Sweep | 非到期阶段的公开engine.tick；调度观察而无隐藏启动 |
| Duplicate | 使用新的用户commandId再次公共requestHostRetry同来源，不能依赖事务同ID回执掩盖来源去重错误 |

所有主图标记边都由最短公共可达前缀重建，再逐动作在Memory和SQLite投影比较。四个初态都实际执行并独立assert；不同状态数和标记边数与TLC原始输出核对，含多初态计数（generated=标记边+4）。TLC为活性增加的虚线stutter单列数量。

## 源码所有者及关键守卫

src/host-retry.ts：applyHostRetry按来源去重；hostRetryBoundary/canStartHostRetry控制新批安全边界；hostRetryBatchRetirable、retryEffectUnconfirmed保护仍活动父工作和未知物理效果；retireHostRetryBatch只结束本批，保留已完成回执并显式清占用；queueNext创建单条后继；settleHostRetryOperation记录确定回执。src/local-operation.ts：LOCAL_RESULT/RECONCILE的身份与效果守卫及checkpoint；src/task/lifecycle.ts的ordered always；src/task/actions.ts执行纯assign；src/task/reducer.ts负责父工作结算和LOCAL事件；src/engine.ts事务接线及公共恢复/tick；src/store.ts提供两种真实事务存储。

## 真实负对照与活性含义

四种隔离源码变体分别：将uncertain父工作视为可退休、退休时抹掉已知operation.result、移除批次退休自动迁移、移除applyHostRetry的已有来源去重。每个都用未修改基线TLC图在Memory和SQLite单独回放；失败必须含目标行为断言，不接受导入错误、超时、源码hash门禁冒充检出。清理后重新完整运行原TLC和原双存储回放。

Progress的公平性只要求当已确认效果下恢复/领取/结束动作持续可用时最终被选择；并不假定未知效果总能获准确认、服务永不崩溃或用户一定批准命令。恢复本身不是EndOwner，不把已保存结果与未来负责人的外部请求合并原子动作。

## 未覆盖内容

没有STOP/新目标/权限撤销组合、余额不足、第三来源、无限次丢失、实际启动命令、完整审批指纹或模型文本；没有把人工构造的旧版本dangling-owner快照混入当前公共可达模型。BT_L53–L55既有代表验收仍须实际执行。覆盖hash是保守审查门禁，不是从TS自动提取TLA的语义证明。当前结论最多是本有限切片全探索与其所有标记迁移的真实对应验证。

证据读回除清单哈希外，强制全部阶段必需原始文件，解析raw TLC计数/完成与实际JSON/日志，逐条将双存储JSONL与标记边Counter、目标状态和可达公共前缀核对。缺失真实负对照文件不可由run.json摘要代替；独立证据反控在自洽重算manifest后仍须拒绝缺件和轨迹篡改。
