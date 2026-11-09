# 建立验证的记录

1. 阅读AGENTS、官方Uncle Bob Mode、形式验证生成维护及TLA结果说明；重新核对四套现有TLA的实际域，确认hostRetryRequests/Batch没有被其图覆盖，文件hash门禁不等于语义覆盖。
2. 以已有BT_L53–L55为契约，重建两来源/两批的最小退休切片，逐项对应真实纯guard/reducer和XState宏步提交。
3. 先手工执行公开前缀的queued/成功/拒绝/未知模式，核对恢复、到期和结束观察，再建立TLA。
4. 首次图解析因活性产生的虚线stutter被误计为事务边而拒绝；修正解析器明确区分自动stutter与所有标记边，不丢弃业务动作；完整图为41状态、111标记边、4公共起点。
5. Memory/SQLite每条标记边从真实公共最短前缀重放，四可达性见证、四真实源码负对照各两存储及原模型/实现复验通过。未拼写模型TaskContext或重写live store。
6. 首次完整证据initial保留56件；补保留实际检查器输入快照后，用final重新完整执行，独立命令读回62件。模型界限和性质未减少。
7. 本轮产品改动只有经授权先红后绿的两处宿主准备复用分支，未改变hostRetry纯状态或事务接口；coverage保存实际受测工作树hash及基线commit，不能把未提交改动归给基线commit。
8. 所有负对照只改隔离副本，恢复后覆盖源码hash保持相同。无真实模型服务/CLI，结论范围和活性公平假设在SKILL与correspondence中明确。

9. 独立交叉审查发现读回器的真缺陷：删除整个negative-controls并重建manifest/摘要SHA后原读回仍通过，记录/workspace/work/host-retry-readback-missing-controls.json。此为验证器缺件虚绿，不是产品状态机缺陷。补齐必需原始文件、实际JSON与raw日志/差异核对，并保留双存储每标记边JSONL，独立核对Counter、目标状态与公共前缀。
10. 首次加强读回对纯插入源码突变误要求删除行，因验证器断言过强返回非零；修正为有效统一diff头/块/新增行，不改任何业务性质或负对照。读回失败不再保留verified结果标志。
11. TLC每模型使用独立java.io.tmpdir，消除多任务抽取共享/tmp标准模块的工具竞态。完整最终命令e77f052-final重新执行：41状态/111边/4起点、两存储各111边、4见证和4×2真实源码负对照、恢复复验全过；72件原始证据独立读回。
12. 在内部一致的临时证据副本中重算manifest，分别删除全部negative原始件、删一条边记录、删baseline回放JSON、篡改actual目标状态、伪造公共前缀，五案全部被目标完整性断言拒绝；副本清理。
13. 完成后确认所有covered SHA与e77f052产品源一致，才推进syncCommit并记录完成结果；元数据推进不冒充另一次执行。

14. 为使未提交的验证driver也能由原始证明重建，最终checker捕获全部64个covered实现/依赖/fixture原文并按受测SHA核对，且读回强制实际cfg的全部安全性质与Progress。用最终checker完整执行e77-implementation-complete，24.873秒，仍41状态/111标记边/4公共前缀、全部双存储和负控/恢复通过，136件独立读回。
15. 独立证据反控现有七项：原五项加删除实现原文、漏配指定性质；均在重算manifest后被目标完整性规则拒绝。只在完成后更新metadata，旧72件是之前阶段的历史，不补文件冒充新执行。
