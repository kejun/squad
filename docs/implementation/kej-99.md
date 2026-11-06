# KEJ-99 实施记录

基线6004150（包含KEJ-98完整验证）。需求合理，无阻断问题：现有解释提示只有2–8协议上限，忽略可用成员和余额，8文档容易变成8片并被4成员派发守卫整份拒绝。复用现有讨论lane与授权，用共享纯函数统一容量，保留派发重算和完整回退。无需新阶段、新表或截断分片。

先核对prepareInterpretation、CLAIM/CONSUME计费、startMapReduce、validInputIntent及既有BT_Q01–Q06测试；新增BT_Q07–Q12与状态图先行。理解初次费用在CLAIM发生，prepare预扣1且CLAIM后刷新，以免边界多报一片；模型只得到只读容量，不获得成员分配权限。历史无字段的意图仍按原协议解析并由当前守卫派发。文档实际读取和语义覆盖以受控HTTP八文档测试证明，不声称真实语雀供应商验收。

## 验证记录

完整任务约束、引用及验收不因容量0/1或回退而丢失；模型门槛与接线结果如下。

## 模型层验证

以6004150基线的真实XState taskMachine（XState 5.33.3）验证：先新增容量测试观察到16项中14项因缺maxPartitions失败，再实现共享纯容量、prepare预扣、CLAIM实际计费后刷新与派发重算；另补无字段旧pending意图恢复兼容测试。

命令：`MODEL_BASE_URL=https://example.test/v1 MODEL_NAME=fixture node node_modules/vitest/vitest.mjs run tests/map-reduce-capacity-model.unit.test.ts tests/map-reduce-model.unit.test.ts --maxWorkers=1`。结果2文件28/28通过；`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`通过。

关键轨迹：prepare预扣理解1次 → CLAIM真实扣费且刷新容量 → 首次CONSUME不双扣 → 接受覆盖八文档的四个完整分组 → 四个assistance结果全部保存 → 仅一次discussionSummary → 一次owner续办。普通/协助/成员边界、0/1保留全部目标和八份引用、重试CLAIM再次扣费后容量下降均已验证。派发前成员忙碌或两类余额下降时，原四片和归并要求完整交owner，assists及ordinary不额外扣费，无部分派发。旧pending意图缺字段经persist/restore/RECOVER/CLAIM仍缺字段，旧inflight结果由现有schema和当前容量守卫完整派发或完整回退。既有Q02–Q05的限额回退、失败保留、停止/目标隔离与重启去重复验通过。

该门槛通过后再接模型提示、动态协议校验和HTTP/BDD夹具；模型测试的合成解释/答复证明接线及边界，不冒充真实供应商的语义覆盖验证。


## 模型接线与集成

模型层门槛通过后接入适配器：提示明确每片可有多份文档、全部来源恰好覆盖一次、容量0/1省略分解，旧work缺字段沿用协议上限8。`validInputIntent`可选第四参数只用于调用固定容量下的适配器输出校验；超限走既有有界格式修复，不把未通过的八片结果应用或截成四片。状态机入口保持结构协议校验，再由派发当前容量兜底，保留旧解释/旧快照整份回退语义。

新增适配器测试先见8项中5失败，再接入后8/8通过。模型+适配器36/36通过。集成新增18项，覆盖生产Engine/Runner/OpenAICompatibleAdapter/CloudflareWebTools路径，只有provider和网页工具HTTP边界替换为合成响应。各分片真正调用生产web_fetch处理文档工具响应，逐URL读取计数和原始工具结果中的独有事实一路核对到归并与产物；这证明受控HTTP边界接线，不冒充实际网络请求或真实语雀/模型供应商行为。

八文档主轨迹：一次理解max4 → 四组每组两源 → 四个assistance均先在途 → 每源恰好读取一次 → 全部分片结算 → 一次summary → 一次owner → 独立检查发布。超限八片修为四片与伪造spec.maxPartitions均触发一次修复；费用按现有ordinary/retries扣除。普通额度7的组合回归中修复前max4，额外理解使usage2，派发当前cap3，完整交owner且无assistance、丢文档或部分扣费。旧快照首片完成后重启两次仍只执行余下三片。Q07–Q12新增15个展开BDD已通过；旧Q02派发守卫夹具直接提交结构合法解释，保留其测试目标，不让故意固定超限的适配器替身冒充正常理解输出。

独立审查未发现产品正确性缺陷；其建议的修复耗费组合边界已加入。完整检查、构建及浏览器验证在最终提交后补记。
