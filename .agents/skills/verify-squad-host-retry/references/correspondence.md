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


## KEJ-109 CLI 元数据与定向引用诊断审查

最终受审产品提交为 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596`。历史同步 e77 提交在当前浅克隆不可用，已逐项核对可用基线 5b8c596 的全部原覆盖文件与旧 SHA 完全一致，再审阅其后三个提交及10个已覆盖文件和3个新导入模块。逐文件理由、原样 blocked、运行和独立读回记录见 [KEJ-109审查](drift-review-kej-109.json)。

CLI catalog/分页及共享调用经验是纯投影或适配器路径，不新增调度、计费或执行授权。交付引用诊断在原 CHECK_RESULT/WORK_FAILED 事务内只追加当前候选的 checkDiagnostics；原引用错误码、补试/请求/修订上限和事务边界保留。非引文错误不追加诊断，CheckBudget 的 BadProtocol 和无诊断技术失败仍得到相同固定材料。现有模型、性质、公平性和界限均不变；新引用正文诊断、真实CLI发现与模型HTTP质量由独立场景验收，不能因本检查通过声称已形式化证明。

本轮宿主批次完整验证在 `reports/verify-squad-host-retry/kej-109-reviewed` 通过：41状态、111标记边，两个存储在原版及恢复后各比较111边，4项真实源码负对照双存储均检出；30.745秒。独立读回139文件以及7项自洽证据篡改负控通过。运行时捕获的2cd9bad加适配器未提交改动，已逐文件证明与最终产品提交 `8f4a1acb31f1aa9d73996e60dbb9aa3becce0596` 完全相同，成功后才推进syncCommit；不冒称这次元数据推进是第二次完整运行。


## 显式生命周期实施对应审查

源码基线 97b7349 至本次候选的全部变更及迁移写入口逐项记录于仓库 `docs/testing/explicit-lifecycles-review.json`。原覆盖指纹与 97b7349 的文件逐项相同。批次同步和分片补位属于原任务事务内自动微步；交付阶段绑定原固定材料，未拆分保存/领取/执行许可事务。迁移的计费、修订、容量刷新、归并和证据重置负对照已定位新写入口。原 TLA/CFG 边界、性质与公平性保持；八片四并发、宿主服务生命周期由新增场景和纯模型路径承接，不冒称原两片切片已穷举新队列。完整结果以本轮运行/独立读回记录为准，pending 或 blocked 不推进 syncCommit。

## KEJ-110 交付优化的效果切片审查

受审产品 `661e438e8705d08a36b9dc0d07b296616737eee4`。旧同步对象不可读时，先逐文件证明可用主线 `942dfe4` 与全部旧coverage指纹一致，再审查13项变更/新增依赖，详见 [KEJ-110审查](drift-review-kej-110.json)。新增sourceItems是纯预检和渲染，增量检查是纯投影，自适应修订的承诺由coordination单独更新；本切片保持既有动作原子性、模型、性质、公平性和界限。共享能力事实来自已结算回执，不写原回执、不发命令、不批准也不释放租约。不能把纳入传递依赖SHA解释为已形式化证明新增文本语义或任意新旧领域组合。

本前缀虽保存短文本候选，但没有sourceItems或先前独立检查，新增来源门禁为空、无delta基线，也不消耗修订上限。批次退休、未知效果保留、同来源去重和后继推进写入口均未变。完整41状态/111标记边，双存储每边对应、4个可达性见证、4类真实源码负对照和原版恢复复验通过，证据 `reports/kej-110-661-host-retry`；独立读回及7项自洽证据篡改负控通过，读回负控输出 `reports/verify-squad-host-retry/evidence-controls.json`。

### KEJ-110 最终提示布局修复后的严格源绑定复验

产品 `615b18f2cf66d46b63fa3bc2c3a7c86fc10779c9` 仅把sourceItems说明从deliver的JSON示例末尾移入owner系统提示；这些有限驱动不执行模型HTTP，因此授权、效果及批次的对应不受影响。仍按严格源绑定要求对最终源码完整重跑，未把661证据改称615运行。旧661目录保留历史；新运行、真实负对照、恢复后复验、独立读回和源未变检查均成功，详见本轮审查中的 strictSourceRerun 与 verification。

最终证据 `reports/kej-110-final-host-retry` 保留41状态/111标记边、双存储正向与恢复复验、4类真实源码负对照及4见证，独立读回成功。新读回负控输出 `reports/kej-110-final-host-retry-reader-controls.json`，7项自洽证据篡改分别因预期完整性错误被拒绝。


## KEJ-111：工具失败反馈与补齐分片的旧切片审查

受审冻结产品 `c239dd39d86f143a2f435f48590c648b20745b8b`；可用旧基线 `49d2bc0ec61df94581cc52aef48725b040ea8603` 的所有旧coverage文件与旧同步清单逐项同SHA，原样运行先被漂移门禁阻塞。12项改变/新增实现依赖的分类及原始阻塞证据见 [KEJ-111审查](drift-review-kej-111.json)。

hostRetryDriver公开前缀的DELIVER省略partitionRecoveries；observe每次断言无discussion/review，完整比较savedCandidate与原已决回执。因无声明，mapRecoveryProblem返回null、mapRecoveryCriteria返回空，保存候选与批次建立保持原行为；图中无CHECK_RESULT或RECORD_TOOL_FAILURE。批次退休/后继创建、效果未知阻挡及同来源去重所有者实现未变；恢复仍按recoverySlice断言单任务、无待消费结果及无到期副作用。

因此旧图、全部性质、公平性、有限界限、双存储逐边比较及真实源码负对照保持。新Web恢复/MapRecovery有自己的有限扩展与具体BDD，不以保守传递依赖指纹声称这些旧图已验证任意新旧领域组合。最终完整执行、恢复后复验、负对照与独立读回状态见本轮审查，pending不算通过，不推进syncCommit。

最终冻结源完整复验已通过：`reports/kej-111-final-host-retry`，41状态/111标记边、双存储完整对应、4见证及4类真实源码负对照；147件原始证据独立读回通过。`reports/kej-111-final-host-retry-reader-controls.json`的7类自洽缺件/轨迹篡改反控被正确拒绝。各运行与恢复后复验成功，清理及覆盖源未变为真；不将稍后同步元数据声称为额外完整执行。


## KEJ-112：当前工作工具建议与重复失败边界

受审冻结产品 `7e5b3426d0909e133fd6329a06e08288ea4c5c62`。原样执行先报告源码漂移；旧同步对象不可读时，已逐文件证明可用主线 `6134a0c` 与旧 coverage 清单全部字节相同。7 个改动覆盖文件及 3 个新增传递依赖的逐项分类见 [KEJ-112 审查](drift-review-kej-112.json)。

本切片保留原模型、动作原子性、性质、公平性、域界限、真实源码负对照和双存储逐边对应。新重复限制只在第三次同键且已有两次可诊断失败的 LOCAL_REQUEST 生效；本图不产生该历史，故没有用削弱性质或删除图边接受新行为。requestLocal 回执 ID 绑定完整请求，操作 ID/hash、session 及租约所有者不变，既有精确事件重放保持。元数据建议只读且不发命令；LocalEffects 真实进程桥的 Adapter 仍由确定 answer/check 夹具驱动。新建议/分类/限制的实际语义由 BT_L117–BT_L124 与独立 XState 门槛承接，不能把这些旧图的通过当作新增领域任意组合证明。全部九入口完成前保持旧 syncCommit；最终完整运行和独立读回结果填入审查记录。

本入口完整运行与独立读回现已通过：41 状态、111 条标记边，每种存储每阶段全部逐边对应；保留原见证、四类真实源码负对照及原版复验。证据 `reports/kej-112-final-host-retry` 保留 150 件原始件，独立读回及自洽缺件/截断/篡改读回反控通过。旧 syncCommit 仍保留，等待父流程确认九入口后统一推进。
# KEJ-113 / KEJ-114 维护候选（尚未完成验证）

本轮原样入口先因源码漂移返回 blocked，原始证据位于 `reports/kej-113-114-initial-host-retry`。名义同步对象 7e5b342 在此克隆不可读取；已逐文件核对可用 HEAD e526f6f 以及 15d2714、62fdb58 与原 coverage 全部字节相同，然后从 e526f6f 审查当前工作树。逐文件旧/候选 SHA、迁移写入口、原事务边界和新增依赖分类见 [本轮审查](drift-review-kej-113-114.json)。候选源码仍可能变化，SOURCE_FREEZE 前不将这些指纹或旧通过结果称为当前产品验证。

原有限模型、性质、公平假设与域界限保留；不能用减小域、删边或弱化不变量接受产品缺陷。新自动监督、处理硬截止、人类回复/跳过、独立清理、部分宿主报告、资源正文凭证、读写资源租约、归档删除与进程守卫均有独立契约，本旧切片不证明它们任意组合正确。完整原入口及真实代码负对照、原版复验、独立证据读回尚待源码冻结后执行；当前 syncCommit 未推进。

冻结产品 `36916b5c6e974c11f8e51720189c64facef9269e` 已逐文件对应审查，候选 coverage 已绑定当前字节。完整入口、原真实代码故障反控、恢复复验和独立读回开始执行；当前仍未通过，syncCommit 未推进。旧域排除新增监督/权限门/资源正文语义/RW/归档删除与任意供应商时序，不能将字节纳管当作这些性质证明。

首次冻结源运行在 mode1、Expire→RejectOwner 的精确错误码断言停止：实际 WORK_EXPIRED 先于自依赖诊断，并仍拒绝 HELP；原图的 End 转移、性质和界限均保留。验证 driver 现按实际 parent.deadline 明确区分到期/未到期代码，并额外核对 candidate/artifacts/assists/原 receipt 不变。父工作退休及后继批次仍由未改的逐边目标投影完整核对，不能把逻辑终结说成所有 context 字段不变。首次原始反例保留在 reports/kej-113-114-final-host-retry，修订后重新完整执行于 reports/kej-113-114-final-host-retry-2。

KEJ-113/114 本入口最终完整执行通过：`reports/kej-113-114-final-host-retry-2`，固定产品 `36916b5c6e974c11f8e51720189c64facef9269e`；160 件原始证据独立读回成功，证据读回反控也全部按预期拒绝。原有限模型、性质、界限及全部标记边双存储对应保留；具体统计、真实突变、清理和运行命令见本轮审查 verification。受测实现未变；syncCommit 等待父流程全部九入口确认，后续同步元数据不表示又完整执行一次。

全部九入口和独立读回已由父流程确认，当前 syncCommit 已推进到 `36916b5c6e974c11f8e51720189c64facef9269e`；旧证明输入、失败反例和保证边界保持。仅元数据同步，不冒称又完成一次完整执行；同步后再次独立读回原始证据。
同步元数据后的独立原始证据读回已再次通过，覆盖实现 SHA 仍全部相同，九份证明 run/manifest 均未改写。


## 共享 Agent 行为规范维护

冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 只新增静态共享提示模块，并在默认适配器的固定检查和普通模型工作 system 消息中各注入一次，替换原 owner/facilitator 短段。逐文件来源、归档依赖和实际运行状态见[本轮审查](drift-review-shared-agent-behavior.json)。旧有限模型、性质、夹具、真实源码负对照和超时保持；九入口全部完整验证和独立读回成功前保留旧 sync。LocalEffects 的真实适配器桥仍使用受控 transport，其通过不代表真实模型服从自然语言规范；新增上下文占用和六角色请求由独立适配器场景验证。


共享规范最终复验：冻结产品 `4032d88341b75c3b419215b73a63c0830f6f137a` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## LB07 固定核查引用提示的第二阶段审查

冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 只在 checkMessages 增加一条既有来源目录和可选引用省略规则说明；共享规范、宿主校验和旧有限性质均未改。`4032d883` 的完整证明仅保留为第一阶段历史；本阶段须以新源码重新完成九入口全部正向、真实源码负对照、原版复验和独立读回。逐项差分及阶段状态见[共享规范审查](drift-review-shared-agent-behavior.json)。


LB07 第二阶段最终复验：冻结产品 `e1c29edbc080b4638b34b9406e4e81b057e20940` 的九入口均完整通过正向、真实源码负对照、原版复验和独立读回，结果为 updated。本技能精确证据路径和保证边界见[本轮审查](drift-review-shared-agent-behavior.json)；仅同步元数据，不冒称额外完整运行。


## 跨会话资源等待与协调观察的旧切片审查

本轮受审对象为当前 HEAD 加已审查的工作区补丁，精确字节、旧基线等价证明、逐文件分类、原样漂移阻塞及完整重跑状态见 [资源等待审查](drift-review-workspace-wait.json)。`workspaceWait` 只保存合法 `LOCAL_CLAIM` 被真实资源冲突拒绝的观察，成功领取删除；不授予执行票据、宿主审批或解锁权限。Store 的冲突所有者与租约清单均只读，原冲突谓词和领取/提交边界不变；结算后的通知只唤醒重新校验。新 `coordination-view` 元数据和协调员提示不成为可信命令。

原有限图、性质、公平性、界限、逐边公开回放和真实源码负对照保持。排队等待监督的 `resources` 支路、跨会话核对浮层、释放通知与全局协调观察由 BT_Y114–BT_Y120 的新模型/BDD/服务/浏览器承接，不声称被旧有限图证明。完整运行及独立读回成功前不推进同步提交。
