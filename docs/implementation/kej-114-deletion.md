# KEJ-114：归档会话的安全删除

需求：[KEJ-114](https://linear.app/kejunz/issue/KEJ-114/安全干净地删除归档会话并清理关联数据与独占资源)。权威需求读回为 `work/linear-KEJ-114.json`。起始产品基线 `15d27144b05086b27ae6b02338c094a3df60fbd2`；实现分支 `codex/kej-113-114-resilience-and-deletion`。

本文先定义需求、验收与拟建状态模型；未通过模型门槛前不接入数据库清理、文件删除或网页行为。当前删除能力尚未实现。

## 输入与 EARS 核查

原始输入：安全、干净地删除归档中的会话。补充输入：检查能否彻底删干净，包括未完成、部分完成等各种情况。用户已授权实现 KEJ-113 与 KEJ-114；范围是单个明确确认的归档 room，不包含批量清空、删除用户源工程或撤销外部业务写入。

R01–R20 保留 issue 的唯一编号。核查均通过：触发、可观察响应和保护边界明确；未完成并不等于永久拒绝，未知效果并不等于可以强删。删除是独立持久生命周期，现有归档继续执行语义不改变。下表为对应 EARS 响应的压缩索引，权威原文仍是 issue。

| 需求 | 经核查的可观察响应与边界 | 场景 |
| --- | --- | --- |
| R01 | 当用户选择删除时，应明确目标、范围、不可恢复性与未完成处理；仅明确确认提交，取消不改变数据。 | X01 |
| R02 | 当受理时，应复验存在、归档状态、版本、身份与权限；失效请求无清理副作用。 | X02、X06 |
| R03 | 当存在未完成工作时，应受理安全删除并冻结、撤销、停止或接管全部执行；未决显示处理/核对及入口，不假完成。 | X03、X04 |
| R04 | 当确认有效时，应先持久删除意图、目标版本、清单与屏障；新业务、恢复和审批须按事务与版本拒绝。 | X05、X06 |
| R05 | 当清理时，应删除全部会话快照、回执、网页事件及 measurement、调试记录和相关索引，旧 URL 无正文。 | X07、X17 |
| R06 | 当删文件时，应依据受信 namespace/操作/session 清单，仅删受控根内独占资产并防路径/链接/替换越界。 | X08、X09 |
| R07 | 在删除中，应保护其他会话、源工程、共享技能、服务锁、账号与未确认资源。 | X10、X21 |
| R08 | 当跨 DB/FS 时，应持久进度、幂等重试和重启续办；局部事务一致，不伪造文件回滚或过早成功。 | X11 |
| R09 | 如果失败或新发现未知效果，应保留必要材料、阶段、原因和恢复入口及责任者。 | X12、X23、X25 |
| R10 | 当重复、迟到、轮询或重放到达时，应幂等或拒绝，不复活、不新增孤立事件或执行。 | X13 |
| R11 | 在防复活需要记录时，应仅保留不含标题/正文/产物/输出/凭据的最小独立标记。 | X14 |
| R12 | 当删除时，应清服务与可控客户端投影、草稿及持久缓存，切换有效目标，保护其他会话草稿。 | X15 |
| R13 | 当存在共享引用时，应保留其他会话独立副本或明确依赖；外部清理只用已支持能力，不删共享账号与业务结果。 | X16 |
| R14 | 当所有项独立核对完成时，应删除完成，所有旧内容入口及重启均不可恢复读取。 | X17、X24 |
| R15 | 当枚举时，应遍历全部历史任务、目标、epoch、轮次及尝试，覆盖八阶段四结果，不以 active/outcome 判空。 | X03、X18、X19 |
| R16 | 当清内容时，应覆盖所有发布/部分/失败/历史产物、附件、来源、检查材料及原始输入和检查点。 | X20 |
| R17 | 当追踪文件时，应绑定 room/namespace/work/attempt/operation/全部 session；跨 room 标识可碰撞，旧数据不唯一须核对。 | X21、X22、X23 |
| R18 | 当清准备残留时，应覆盖 scratch、检查输出、半成品 copy、marker、journal pending 和旧 session 日志，不能同名删共享资源。 | X08、X10、X22 |
| R19 | 当发现孤儿时，应核对所有者/引用/进程/效果并持久跟进；不能凭年龄、共享 key、operationId 清空。 | X23 |
| R20 | 当显示完成时，应独立核对全清单、实际执行、服务与客户端投影，仅保留无正文墓碑；有遗留如实显示未完成。 | X24、X25 |

`BT_X01–BT_X25` 使用仓库未占用的单字母前缀，符合 `scripts/spec-coverage.ts` 的 `^@BT_[A-Z]\d+$`。新增场景不排除、不登记为人工豁免；当前阶段只做语法核对，未绑定步骤与行为通过在后续如实记录。

## 删除生命周期

图类型：**拟建真实 XState 删除作业模型**，所有者 `src/room.machine.ts` 导出的独立 `roomDeletionMachine`；不是已存在的任务阶段，也不改八种任务阶段的含义。组织归档仍由现有 `roomMachine(active/archived)` 负责；删除作业从受信归档事实建立，删除状态由 Store 单独持久化，不能依赖 `activeTaskId`。

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> preparing: REQUEST [明确确认且归档版本一致] / 保存删除身份、屏障与准备意图
    idle --> idle: REQUEST [无效] / 无副作用拒绝
    preparing --> waiting: INVENTORY [在途或未知效果或归属待核对] / 保存停止、清理接管及核对意图
    waiting --> preparing: SETTLED [可信效果与所有权核对有效] / 更新未决项并继续准备
    preparing --> deleting: INVENTORY [完整所有权清单且物理责任满足] / 保存文件清理意图
    preparing --> paused: FAILED / 保存错误、剩余项与恢复入口
    deleting --> deleting: ITEM_SETTLED [身份和版本有效] / 提交逐项清理进度
    deleting --> paused: FAILED / 保留已完成及未完成项
    paused --> preparing: RETRY或RECOVER [原删除身份] / 恢复原意图而非重放业务
    deleting --> deleted: VERIFIED [DB、文件、执行和投影核对全部通过] / 原子清会话数据并压缩无正文墓碑
    deleted --> deleted: REQUEST或迟到事件 / 幂等删除状态或拒绝复活
```

守卫只读取持久事实，不访问文件、进程或网络。模型动作仅更新 context 与生成持久操作意图。可信引擎在事务中领取意图后，删除运行器才执行所有权扫描、停止/核对、文件清理与独立读回，并以带 `deletionId/revision/intentId/attempt` 的事件回传。数据库提交失败不执行下一阶段 I/O。取消/暂停删除不能复活已经移除的数据；关闭和重启恢复原 job。未知效果由原物理清理或删除清理所有者持久接管，在核对结束前保留必要证据且不返回 deleted。

目标是支持所有合法任务阶段与结果；单个 room 内一律枚举所有任务和操作。`ended`、`partial`、`stopped` 和 `activeTaskId=null` 都不能跳过资源检查。运行中的任务要停止派发并可靠结算/接管；未完成业务不能自行产生后继。删除等待必须有下一核对时间或明确人类事件及处理入口，不允许无人负责的等待。

## 共享契约提案（接线前固定）

### 持久作业与 Store

新增独立 `room_deletions(room_id PRIMARY KEY,data)` 保存删除 XState 快照；不将作业只放入待删 `rooms.data`。建议公开契约如下，具体 TS 命名在模型阶段固定并通知接线方：

```ts
interface DeletionIdentity { roomId: string; deletionId: string; revision: number }
interface DeletionRequest { id: string; confirmed: true; archiveVersion: number }
interface DeletionStatus extends DeletionIdentity {
  phase: 'preparing' | 'waiting' | 'deleting' | 'paused' | 'deleted';
  remaining: number; reason?: string; nextWake: number | null;
}
// Store内部事务维护快照、删除屏障、领取与原子最终清理。
readDeletion(roomId: string): RoomDeletion | undefined;
listDeletions(): RoomDeletion[];
transactDeletion<T>(roomId: string, update: DeletionTransaction<T>): T;
finishRoomDeletion(identity: DeletionIdentity, verified: CleanupVerification): DeletionStatus;
```

`Store.finishRoomDeletion` 在**同一个 SQLite connection/事务**删除 `rooms`、`receipts`、`web_rooms`、`web_events` 中目标 room 行，并把 job 压缩为墓碑，避免原 web connection 与 Store connection 的伪原子提交。表不存在时按空处理，但不能忽略真实 SQL/提交错误。内存 Store 提供相同域语义；WebService 在提交最终清理前退役本 room 执行器与服务投影，在提交后通知客户端清缓存。客户端离线清理通过墓碑同步防复活，不声称擦除用户另存文件。

普通 `Store.transact(roomId, ...)` 在删除屏障/墓碑下拒绝创建或修改 room；原操作结算只能通过明确的可信 settlement 意图与内部宿主入口进入删除事务，不能向任意调用者开放一个 `allowDeleting` 布尔绕过开关，也不能成为新业务派发许可。旧 `read()` 返回空对象不再允许迟到事务写回空 room。请求幂等身份、归档版本和删除版本必须与屏障同事务核对。

完成后仅保留 room 不透明身份、deletionId/版本、完成时间及请求幂等摘要；去除 manifest、路径、标题、正文、原事件和工具内容。墓碑不参与普通会话历史。墓碑命令身份不复用普通待删回执表；不同幂等 id 重复请求返回一致删除状态。

### 运行时所有权与文件清理

建议接口：

```ts
interface RuntimeOperationOwner { roomId: string; taskId: string }
// 新增可选第6参以兼容旧嵌入；新生产runner始终传可信owner。
execute(work, operation, signal, started, observe?, owner?: RuntimeOperationOwner);
planRoomCleanup(input: RoomCleanupInventory): Promise<RuntimeCleanupManifest>;
cleanupRoom(manifest: ClaimedRuntimeCleanupManifest, signal: AbortSignal): Promise<CleanupReceipt>;
```

Runtime 在原 journal `prepared` 写入和任何目录准备前，先保存所有权记录：roomId、taskId、namespace、workId、parentAttempt、operationId、local attempt、sessionId 与预期资产。每次 session 都有独立不可被新 session 覆盖的记录。创建前记录预期路径，才能覆盖准备一半即崩溃的目录/文件；清理完成后再清该记录。journal 新记录可同时携带同一 owner；旧 journal 保持可读，不伪造旧 owner。

完整 inventory 从 **全部 room task/intents/localOperations**、可信所有权记录和已持久事件中的精确 session 关联重建，不能只用当前 `op.sessionId`。operationId/workId 不全局唯一，journal 和 copy marker 的旧格式不足以单独证明 room。无法唯一归属的旧资产进入明确核对；禁止按年龄或仅按 operationId/共享源路径删除。

文件动作只接受服务端计算并持久化、领取过的 manifest。清单包含允许的资产类型、根目录内规范相对路径、所有权身份与用于防替换的文件身份；不接受客户端或模型传入任意删除路径。核对根和父链、拒绝越界/链接替换，清理只移除已证明的目录项，不跟随符号链接到外部。共享根内的名字不能单独成为删除许可。全部会话独占文件都应列入 final verification，包括所有权记录自身。

| 资产 | 所有权/范围 | 清理边界 |
| --- | --- | --- |
| `workspaces/<namespace>` | `fingerprint({roomId,taskId})` 的默认独占任务根 | 包括整个根内 scratch/任务产物；配置源工程时不得删外部根 |
| `copies/<digest(namespace:workId)>` | 同一 work 的副本，含未准备完目录 | 不仅依赖 `op.isolated` 或完成 marker；依据可信工作种类与所有权记录 |
| 对应 `copies/<hash>.json` | 副本 marker | 与副本分别纳入清单，避免删目录留 marker |
| 独占根内 `.home/.tmp` | 沙箱 scratch | 共享源工程或宿主 HOME 内的同名目录不属本 room |
| 独占根内 `dist/test-results/reports/coverage` | 验证及部分输出 | 遍历完整目录，不以最多100项输出摘要作为全清单 |
| `sessions/<digest(sessionId)>.json` 与 `.json.pending` | 全部历史 session 的 journal 和原子写临时文件 | 先结算/接管物理效果，未知时保留核对材料 |
| `logs/<digest(sessionId)>.log` | 全部历史 session 的日志 | 不能只清当前 session 或只依据非全局唯一operationId |
| 新运行时 ownership 记录 | 绑定完整 room/namespace/attempt/session | 本 room 所有资产核对后清理；完成墓碑不得残留路径/内容 |
| `skills/<version>`、bindings及其pending | 跨 room 共享缓存 | 不按 room 删除；独立缓存回收不在本期单room清理中扩大 |
| `service.lock`、原技能、账号配置、外部 workspaceRoot | 全局/用户所有 | 保留，不能为了看起来干净而删除 |

数据库 `workspace_leases.owner` 是不可逆指纹且无 room 外键。由所有已知操作重建精确 owner，并核对实际进程/效果后处理；共享 key 不证明归属。孤儿 lease 和不能归属的文件由独立清理责任持久跟进，不能移除 room 后丢失处理者。

## 与 KEJ-113 R26 的资源键边界

R26 的实现另按 KEJ-113 场景/模型门槛推进；这里记录共享设计约束：`workspaceId` 保留来源/版本血缘，新的执行 `conflictKey` 在 LOCAL_CLAIM 前由可信 runtime 和持久 work/namespace 确定，沙箱隔离 work 对应实际 copy key；真实共享写入或宿主未知外部影响继续争用相应真实资源。

不能仅凭 `isolated=true`、后端 `available=true` 或模型自述判断独占范围。只有可信 backend 明确提供实际沙箱隔离能力，且资源声明证明影响限制在副本内，才使用副本执行 key；host CLI 可访问副本之外，未明确的效果继续保守使用真实共享/外部冲突资源。受控进程测试后端不自动获得 OS 隔离声明。

副本准备对源快照的短暂一致性保护与副本执行租约分开。可用持久 preparation claim 保护源读取，`LOCAL_PREPARED` 提交副本/版本事实后只释放该准备资源，执行继续持有副本资源；不能整段命令一直独占源工程，也不能为并发删除源保护。资源集合的领取/失败回退必须原子，不得出现领取失败释放另一个owner租约。删除 inventory 需记录两类资源，未知效果只隔离实际受影响资源。

## 验证门槛与工作记录

顺序：中文 Gherkin → 本文删除图与 README/state-diagrams 入口 → 独立真实 XState 删除模型 → 受控事件与持久化/恢复模型门槛 → Store/Runtime I/O → Engine/WebService/HTTP/UI → 接线及独立读回 → 故障负对照与相关 CI。

模型门槛至少包含：确认/版本拒绝、八任务阶段与九操作状态的输入事实、四种结果、全历史枚举、永久屏障、逐项进度、等待核对、暂停/重试、重复/迟到、终态压缩、重启恢复、共享资源不变。文件/SQLite不伪装为模型测试；后续由真实临时目录、真实SQLite和公开服务入口验证。

本阶段记录：重新完整阅读 AGENTS.md 与 Uncle Bob Mode；只读核对 issue R01–R20、当前归档/Store/runtime边界与 Gherkin identity 正则；先新增 BT_X01–X25 和设计记录，未修改生产代码、未提交或推送。用真实 Gherkin parser 校验了新文件语法及全仓场景身份唯一性；最终定义数25、展开用例102，未宣称新场景已直接执行或任何删除已发生。
