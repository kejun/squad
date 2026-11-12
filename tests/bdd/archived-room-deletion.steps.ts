import assert from 'node:assert/strict';
import { After, Before, Given, When, Then } from '@cucumber/cucumber';
import { ArchivedRoomDeletionCase } from '../archived-room-deletion-case.js';
import type { SpecWorld } from './steps.js';

const cases = new WeakMap<SpecWorld, ArchivedRoomDeletionCase>();
const timeout = { timeout: 60_000 };
Before(async function (this: SpecWorld, { pickle }) {
  const id = pickle.tags.find(tag => /^@BT_X\d+$/.test(tag.name))?.name.slice(1);
  if (id) cases.set(this, new ArchivedRoomDeletionCase(id));
});
After(timeout, async function (this: SpecWorld, { result }) {
  const fixture = cases.get(this); if (result?.status !== 'PASSED') fixture?.markFailed(); await fixture?.close();
});
// A finite binding list: a new contract sentence remains undefined until it has a reviewed fixture action.
const givenSteps = [
  "用户准备直接删除一个归档会话",
  "删除指定会话的请求存在{string}",
  "已归档会话的任务合法处于{string}",
  "待删会话包含状态为{string}的历史操作",
  "会话的删除意图和禁止新业务屏障已经持久化",
  "同一归档版本的恢复与删除请求按{string}到达",
  "已归档会话包含多个任务、通知、消息、黑板、产物、候选、授权与检查点",
  "会话存在请求回执、网页执行事件、measurement及调试记录",
  "完整所有权清单确认{string}属于待删会话且已可安全清理",
  "清理项存在{string}",
  "待删会话引用{string}",
  "删除流程在{string}停止",
  "删除流程遇到{string}",
  "会话已经进入删除屏障或完成删除",
  "会话已经安全清理并完成独立核对",
  "客户端选中了待删归档会话且存在详情、草稿和缓存",
  "其他会话也有草稿与缓存",
  "待删会话的内容或外部会话与其他会话存在依赖",
  "归档会话已经完成删除并重启服务",
  "归档会话包含{string}",
  "已归档会话的历史任务结果为{string}",
  "会话同时保存已发布产物、partial文件、失败草稿、候选与旧修订",
  "存在后台附件、未消费结果、来源副本、冻结检查材料和模型检查点",
  "目标会话同一操作曾多次领取并留下多个session及准备日志",
  "另一个会话使用相同消息、work和operation标识",
  "执行在准备日志、创建副本和发布完成标记之间中断",
  "待处理资源表现为{string}",
  "删除流程已经报告所有清理项执行完毕",
  "删除核对仍发现{string}",
  "归档会话的文件准备仍在执行且原逻辑运行器已经退役",
  "真实SQLite内存服务已保存两个会话及任务回执和网页执行记录"
];
const whenSteps = [
  "用户点击直接删除入口",
  "服务器核对删除确认",
  "用户明确确认删除该会话",
  "全部在途执行和未决效果已经可靠结算",
  "删除流程处理该操作",
  "删除屏障期间收到{string}",
  "两个请求完成事务裁决",
  "已确认的删除流程完成清理",
  "删除流程执行并核对该清理项",
  "删除运行器核对并处理该清理项",
  "会话独占内容完成清理",
  "服务重启并继续原删除请求",
  "所有剩余项经独立核对消失",
  "无法完成当前清理阶段",
  "{string}到达",
  "服务器保存防复活和幂等记录",
  "目标会话完成删除",
  "旧响应或离线客户端重新连接",
  "系统准备删除清单",
  "用户读取该会话的{string}",
  "用户确认删除会话",
  "用户确认删除并完成适用的安全结算与清理",
  "删除流程完成独立核对",
  "根据受信所有权清单删除目标会话",
  "删除流程枚举该会话资源",
  "删除流程核对其实际所有者、引用和效果",
  "所有权和安全清理条件由可信核对确认",
  "独立核对数据库、完整所有权清单、实际执行及可控服务和客户端投影",
  "系统返回删除状态",
  "用户确认删除且系统检查实际运行时责任",
  "原文件准备实际结算并产生最后的独占文件",
  "用户通过HTTP归档并明确删除其中一个内存会话"
];
const thenSteps = [
  "会话应立即移除且不出现二次确认",
  "应能辨认目标会话、删除范围、不可恢复性和未完成工作的处理方式",
  "会话内容、归档状态、执行和独占文件应保持不变",
  "应明确拒绝请求且不冻结、停止或删除任何会话资源",
  "系统应保存删除请求并冻结该会话的新业务",
  "应撤销待领工作并停止或可靠接管全部在途工作",
  "应显示持久处理状态、当前剩余项及下一处理方式",
  "原删除请求应能继续到完整清理而不要求重新创建请求",
  "应采取{string}且不伪造执行成功或释放未知冲突资源",
  "应拒绝该业务请求且不新增模型或工具执行",
  "可信的原操作结算与清理进度仍应能够持久化",
  "只能产生{string}且不能同时恢复业务和删除数据",
  "所有属于该会话的业务快照、网页记录和请求回执应不存在",
  "服务调试入口不能再读取该会话内容",
  "其他会话的相同标识记录应保持不变",
  "该独占资源应不存在且其他会话资源保持不变",
  "应拒绝越界清理并保留明确剩余项",
  "受控根目录之外的文件及其他会话内容应保持不变",
  "该共享资源及其他会话的使用能力应保持不变",
  "应从持久进度继续安全处理并保留尚未完成的清单",
  "不得重复业务执行、误删共享资源或伪造文件回滚",
  "原删除请求应仅产生一个无正文完成回执",
  "应保留必要证据、当前阶段、剩余项和具体原因",
  "应提供重试或核对入口并保留清理责任",
  "不得返回删除完成或静默丢弃未知资源",
  "应返回一致删除状态或明确拒绝且不重建会话内容",
  "不得新增孤立网页事件、模型调用或工具调用",
  "记录应仅包含完成状态及必要的不透明身份与版本",
  "记录不得包含会话标题、正文、产物、工具输出、凭据或资源正文",
  "客户端应移除该会话的列表、快照、草稿、详情及持久缓存",
  "应切换到其他有效会话或空页且保留其他会话的草稿",
  "应先同步删除状态且不能复活原会话内容",
  "应保留其他会话所需的独立快照或说明阻塞依赖",
  "只能使用已支持的清理能力处理明确属于目标的外部会话",
  "不得删除共享账号、用户另存文件或外部业务写入结果",
  "应返回一致的不存在或已删除结果且没有会话正文",
  "全部历史任务、目标版本、轮次与尝试都应纳入清理或核对",
  "activeTaskId为空或任务终态不能单独证明清理完整",
  "应清理该会话全部约定内容并通过完整性核对",
  "上述全部会话内容应不存在且不能只删除当前附件",
  "目标会话全部历史session、pending文件与日志应被处理",
  "另一个会话的同名标识文件及记录应逐项保持不变",
  "应覆盖可证明归属的半成品目录、标记和临时文件",
  "缺失完成标记不能导致漏清理或扩大到共享目录",
  "归属未确认前应保留资源及必要核对材料并显示处理入口",
  "不能按年龄、共享workspace键或重复operation标识直接删除",
  "原持久清理流程应能继续而不丢失责任",
  "只有全部约定内容消失且仅剩允许墓碑时才应返回删除完成",
  "已连接客户端、刷新和服务重启都不能读回目标会话内容",
  "应明确显示处理中、等待核对或失败及剩余项",
  "不得显示已彻底删除",
  "删除应保持处理中且不得在准备仍可创建文件时清除资源",
  "原删除流程应重新枚举并清理这些文件后才能完成",
  "同一内存数据库中目标会话的四类业务记录应全部消失",
  "另一会话的任务回执和网页记录应逐项保持不变",
  "旧入口和重复请求应返回已删除且不得重建内存会话",
  "服务应正常关闭并仅释放一次共享内存数据库连接"
];
for (const [kind, expressions] of [['given', givenSteps], ['when', whenSteps], ['then', thenSteps]] as const) {
  for (const expression of expressions) {
    const run = async (world: SpecWorld, value?: string) => {
      const fixture = cases.get(world); assert(fixture, 'Deletion scenario must keep its BT_X identity');
      if (kind === 'given') await fixture.given(value);
      else if (kind === 'when') await fixture.act(value);
      else await fixture.verify();
    };
    const callback = expression.includes('{string}')
      ? async function (this: SpecWorld, value: string) { await run(this, value); }
      : async function (this: SpecWorld) { await run(this); };
    if (kind === 'given') Given(expression, timeout, callback);
    else if (kind === 'when') When(expression, timeout, callback);
    else Then(expression, timeout, callback);
  }
}
