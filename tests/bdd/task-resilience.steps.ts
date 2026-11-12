import assert from 'node:assert/strict';
import { Before, Given, When, Then } from '@cucumber/cucumber';
import { runResilienceAcceptance, assertResilienceConsequence, type ResilienceProof } from '../task-resilience-acceptance.js';

interface ContractState { id: string; detail: string; premises: string[]; proof?: ResilienceProof }
const states = new WeakMap<object, ContractState>();
const current = (world: object) => { const state = states.get(world); assert(state, 'resilience scenario must have an explicit contract identity'); return state; };
Before({ tags: "@BT_Y01 or @BT_Y02 or @BT_Y03 or @BT_Y04 or @BT_Y05 or @BT_Y06 or @BT_Y07 or @BT_Y08 or @BT_Y09 or @BT_Y10 or @BT_Y11 or @BT_Y12 or @BT_Y13 or @BT_Y14 or @BT_Y15 or @BT_Y16 or @BT_Y17 or @BT_Y18 or @BT_Y19 or @BT_Y20 or @BT_Y111 or @BT_Y113" }, function ({ pickle }) {
  const id = pickle.tags.map(tag => tag.name.slice(1)).find(tag => /^BT_Y\d+$/.test(tag) && (Number(tag.slice(4)) <= 20 || tag === 'BT_Y111' || tag === 'BT_Y113'));
  assert(id); states.set(this, { id, detail: '', premises: [] });
});

// These explicit expressions are a finite binding list. New feature steps remain undefined
// until given a real fixture action and observable postcondition; no catch-all step exists.
const premises = [
  "任务已保存固定处理窗口和已用修复预算",
  "任务处于{string}且缺少真实可执行的推进路径",
  "{string}的提供方永不返回且任务没有必需人类决定",
  "任务有尚未明确回复的{string}人类门",
  "当前任务的人类门已持久保存",
  "必需人类门仍打开且原自动处理窗口已经到期",
  "某项内容已按当前策略允许缺失且另有独立内容可处理",
  "任务已有当前目标的可信成果和明确缺口",
  "汇总与检查模型均不可用且相关调用额度已耗尽",
  "任务没有当前目标的可用业务成果且不等待必需人类决定",
  "任务同时保存旧目标产物和当前目标产物",
  "已领取请求在真正启动以前处于{string}",
  "任务存在{string}且已保存对应冲突资源",
  "当前处理窗口已发布固定的不完整交付且未知效果由清理接管",
  "{string}在自身期限之前被成功领取",
  "负责人等待明确回复且后台讨论处于{string}",
  "已停止任务仍有未知或取消中的物理操作",
  "未知外部效果已由可信宿主核对且原负责人检查点保存该回执",
  "协助结果已保存但尚未消费且任务后来因执行额度终止",
  "协助结果在自身期限附近返回并具有可靠执行身份",
  "任务的所有待执行记录均因{string}不能真正执行",
  "当前窗口接近硬期限且最终交付尚未冻结",
  "旧快照缺少监督字段但保存了创建时间已用额度和未决操作"
];
const recordPremise = (world: object, premise: string, parameter?: string) => {
  const state = current(world); state.premises.push(premise);
  if (parameter !== undefined) state.detail = parameter;
};
for (const premise of premises) {
  if (premise.includes('{string}')) Given(premise, function (parameter: string) { recordPremise(this, premise, parameter); });
  else Given(premise, function () { recordPremise(this, premise); });
}
const actions = [
  "在截止时间前后反复发生{string}",
  "宿主按持久监督期限检查任务",
  "操作期限和有限修复窗口耗尽且原自动窗口尚未到期",
  "自动处理窗口到期并经历重复恢复",
  "收到{string}",
  "人类{string}",
  "该项内容{string}",
  "自动处理窗口到期且用户明确结束并保留已有成果",
  "自动处理窗口和有限修复均已耗尽且用户明确结束",
  "宿主冻结partial交付",
  "宿主以{string}冻结partial交付",
  "可信宿主确认该尝试从未实际启动",
  "内容被跳过或逻辑任务结束",
  "{string}迟到或重复发生",
  "实际执行许可在截止时间或之后校验",
  "用户通过当前任务明确要求继续",
  "按{string}处理停止恢复和确定回执",
  "监督协调员决定在原目标和窗口内继续",
  "用户获准重新激活并重试该已保存结果",
  "{string}处理结果和期限事件",
  "监督器核查有效执行资格",
  "{string}与到期续窗门并发提交",
  "从可靠提交点重复恢复该快照"
];
const execute = async (world: object, parameter?: string) => {
  const state = current(world); assert(state.premises.length > 0, 'business premises must be supplied before execution');
  if (parameter !== undefined) state.detail = parameter;
  state.proof = await runResilienceAcceptance(state.id, state.detail);
};
for (const action of actions) {
  if (action.includes('{string}')) When(action, async function (parameter: string) { await execute(this, parameter); });
  else When(action, async function () { await execute(this); });
}
const consequences = [
  "应接续携带原回执的安全负责人工作而不重放外部操作",
  "原操作身份执行时间和固定窗口应保持不变",
  "原处理窗口的硬期限和已用预算应保持不变",
  "任务不应仅因这些事件获得新的业务执行许可",
  "应建立有界修复或明确人类门或真实逻辑终态",
  "旧轮次待执行记录和永久被拒绝的领取不应被视作有效工作",
  "已结束任务只应接续尚未移交完毕的物理清理",
  "应停止新增业务派发并无需新模型或检查调用生成不完整结果",
  "未知物理效果应移交独立清理而不冒充已结束",
  "人类门应继续等待明确回复且不被自动同意或跳过",
  "自动窗口已耗尽应与待回复状态分别保存",
  "只有当前人类门的明确回复应恰好一次改变处理决定",
  "关闭提示和旧门回复不应解除当前人类门",
  "当前明确跳过的内容不应因随后模型检查通过而成为complete",
  "澄清答复应重新解释或接续已授权协助而不留下孤立待领工作",
  "应按明确授权建立新窗口或保持续窗待答或交付已有不完整结果",
  "跳过原问题只省略该内容而不替代明确结束窗口",
  "原窗口期限和历史已用额度不应被重置",
  "应记录内容跳过范围和授权依据并继续独立内容",
  "跳过不应被记为已验证成功或替代必需权限决定",
  "应无需新模型调用生成固定版本的partial宿主报告",
  "报告应包含已核验和未核验成果及失败跳过和未决效果",
  "未核实草稿中的全部完成叙述不应成为宿主完成事实",
  "应形成failed及缺口原因而不伪造业务成果",
  "失败报告本身不应被算作已完成原任务的成果",
  "应保存固定的目标版本正文和当前文件清单",
  "单独导出的宿主报告应自带partial及核验缺口声明",
  "旧目标文件和未核实草稿不应混成当前已核验终稿",
  "多次交付的未核实正文应具有唯一身份且不得遮蔽当前版本",
  "应退休原许可或明确拒绝无效事实并保留已定逻辑结果",
  "不得重新派发已停止工作或重写冻结交付",
  "原操作及其核对门应原子移交独立持久清理责任",
  "逻辑任务可如实输出partial或failed或stopped",
  "未知效果不得据逻辑结束或租约到期被当作已结算释放",
  "没有CLI记录的未知效果只应由提供方可信核对结算且人类普通回复不能代替",
  "事件只应结算原操作或追加历史",
  "不应改写冻结正文版本文件选择或夺取活动任务",
  "该次适配器不应启动",
  "系统应保存未启动事实并建立后继恢复或真实终态",
  "重复监督和恢复不应留下无工作无唤醒的阶段",
  "旧讨论应被合法接续或退休并保存已有意见",
  "当前轮次应有可执行后继或明确人类门",
  "旧轮次待执行记录不得阻塞当前负责人",
  "逻辑任务应保持停止意图并收敛为一致的stopped结果",
  "尚未确定的效果继续由独立清理持有",
  "无需再次点击停止才能得到正确逻辑终态",
  "消费结果和唯一可执行后继应原子提交",
  "任务阶段与outcome应一致且历史计费不清零",
  "重启和重复请求不得再次消费或重复创建后继",
  "应按同一期限策略标记结果和可用证据",
  "相同执行事实不得仅因监督顺序得到相反业务结论",
  "原始迟到结果应可追溯且后继只交接一次",
  "不应把待执行数量非零视作健康推进",
  "应在有界修复后建立可执行后继或明确人类门或不完整终态",
  "应按持久事务顺序与当前任务目标和门版本裁决",
  "已接受输入不得静默丢失且被拒绝输入应有明确原因",
  "晚结果不得改写既有版本或悄悄延长原窗口",
  "应按原始事实建立一次兼容的固定窗口而不按每次恢复续期",
  "已用预算停止意图和原操作身份应保留",
  "终稿冻结与未决效果责任不能只提交其中一半"
];
for (const consequence of consequences) Then(consequence, function () {
  const state = current(this); assert(state.proof, 'the public model action must have executed');
  assertResilienceConsequence(state.id, state.proof);
});
