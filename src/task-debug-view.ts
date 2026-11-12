import type { DebugFrame } from './task-debug.js';
import type { MachineGraph, MachineTransition } from './task-structure.js';
import type { TaskContext, Phase } from './types.js';

export const phaseNames: Record<Phase, string> = {
  interpreting: '理解输入', running: '执行中', waitingAssistance: '等待协助', coordinating: '协调中',
  waitingHuman: '等待人工', checking: '检查交付', stopping: '停止中', ended: '本轮已结束',
};
export const guardDescriptions: Record<string, string> = {
  valid: '事件身份、版本、权限和额度有效',
  retryReviewContinues: '已保存的协助结果用于继续本轮评审', retryHasResult: '有本轮尚未消费的协助结果',
  claimOwner: '领取主工作或工具请求', claimDiscussion: '领取本轮讨论工作', claimCancel: '领取取消确认',
  stoppedSettled: '在途工作已结算且没有不确定结果', discussionHandoffReady: '讨论汇总就绪且主工作已结算',
  analysisReady: '有待解析输入且可以开始解析', inputsReady: '补充输入可以在执行边界应用',
  deferredReady: '延后协调已满足执行边界', reviewReady: '待评审请求可以进入协调',
  canCoordinate: '讨论和在途工作允许进入协调',
  checkCanRetry: '检查协议需要修正且本轮仍可补试',
  checkContinues: '新用户输入等执行交接待办需要接续',
  settlingCheck: '当前检查工作已结算', settlingCheckHandoff: '检查结算后接续待处理的交接',
  checkFailureHandoff: '检查失败后接续待处理的交接',
  checkFailed: '检查失败已结算，本轮无法自动恢复',
  revisionFailed: '本轮唯一一次实质修订失败',
  claimCheckUnavailable: '当前检查无法领取且需结算本轮',
  localCheckExhausted: '工作区验证结束，但检查无法继续',
  recoveredCheckExhausted: '恢复时检查已超时或已用尽补试机会',
  localResumeOwner: '本地操作已确认且可以恢复主工作或工具工作',
  localResumeHelp: '本地操作已确认且可以恢复协助工作',
  localResumeFacilitator: '本地操作已确认且可以恢复协调工作',
  localResumeCheck: '本地操作已确认且可以恢复检查工作',
  uncertainLocalResult: '有效本地结果仍未结算或影响未明，且任务未停止、工作不属于讨论',
  failedDiscussion: '有效失败结果属于讨论工作',
  holdingDelivery: '交付事件有效但讨论尚未结束',
  incompleteDiscussion: '检查事件有效且本轮讨论标记为不完整',
  safeBoundary: '没有主流程在途工作或仍可能运行的本地操作',
  resultAtBoundary: '协助结果有效、任务可继续且主流程在途工作已结算',
  reviewResultAtBoundary: '有效协助结果可在执行边界继续下一位评审',
  isCurrent: '结果版本有效、任务未停止，若关联工作则必须仍在途且尝试匹配',
  interpretationClarifies: '有效输入理解结果需要人工澄清',
  currentInterpretation: '结果属于本轮仍在途的输入理解工作',
  claimInterpretation: '领取的是有效输入理解工作',
  decisionReview: '有效协调决定要求评审',
  decisionReviewDispatch: '有效协调决定要求评审且额度允许派发',
  reviewResultContinues: '有效协助结果允许继续下一位评审',
  failedReviewContinues: '评审失败结果已确定且下一位评审与派发额度可用',
  incompleteReview: '检查事件有效且本轮评审标记为不完整',
  claimHelp: '领取的是有效非讨论协助工作',
  claimFacilitator: '领取的是有效非讨论协调工作',
  claimCheck: '领取的是有效检查工作',
  shouldTick: '到达进展检查时刻，事件未处理且讨论、执行及本地授权均不阻塞',
  repeated: '同一失败达到重复阈值且当前允许进入协调',
  decisionAssist: '有效协调决定要求协助',
  decisionAsk: '有效协调决定要求询问用户',
  decisionFinish: '有效协调决定要求结束本轮',
  decisionRun: '有效协调决定要求继续或重新规划',
  retryable: '失败是可安全重放的暂时错误，结果已确定且重试与工作额度允许',
  failedAssistance: '有效协助失败结果已确定',
  recoveredSafe: '恢复配置兼容且没有仍可能执行、结果不明或不可重放的在途工作',
  hostRetryBatchRetirable: '续办负责人工作已终止或缺失，且没有待核对的执行效果',
  hostRetryBatchNeedsSync: '宿主批次阶段需要同步到当前执行事实',
  mapQueueNeedsProgress: '分片队列需要结算、补位、取消或归并',
};
const rejectionDescriptions: Record<string, string> = {
  SELF_DEPENDENCY: '不能向当前负责人本人求助', STALE_FENCE: '结果的轮次或目标版本已过期',
  BUDGET_EXHAUSTED: '当前额度不足', UNRESOLVED_WORK: '仍有未结算或结果不确定的工作',
  WORK_NOT_PENDING: '该执行请求已不是待领取状态', WORK_BUSY: '成员或执行通道仍在工作',
  WORK_EXPIRED: '执行请求已过截止时间', INVALID_STATE: '当前状态未接受该事件',
  STALE_WORK: '执行请求属于旧轮次或目标版本', UNKNOWN_BOT: '目标成员不存在',
};
export const contextOf = (frame: DebugFrame): TaskContext => (frame.snapshot as { context: TaskContext }).context;
export const frameKey = (frame: DebugFrame) => frame.stepId ?? ('sequence' in frame ? String(frame.sequence) : frame.event.id);
export function selectDebugFrame(frames: readonly DebugFrame[], key: string | null): DebugFrame | undefined {
  return key === null ? frames.at(-1) : frames.find(frame => frameKey(frame) === key);
}
export function completionLabel(context: TaskContext) {
  return context.outcome ? ({ complete: '已完成', partial: '部分完成', failed: '失败', stopped: '已停止' }[context.outcome]) : '';
}
export function waitingItems(context: TaskContext): { id: string; text: string; detail: string }[] {
  const name = (id: string) => context.config.bots.find(bot => bot.id === id)?.name ?? (id === 'facilitator' ? '协调员' : id);
  const items: { id: string; text: string; detail: string }[] = [];
  const round = context.discussion;
  if (round && !['delivered', 'cancelled'].includes(round.status)) {
    const queue = round.mapReduce?.queue;
    const collecting = queue ? `分片结算 ${queue.filter(part => !['queued', 'running', 'uncertain'].includes(part.status)).length}/${queue.length}` : `讨论收集 ${round.results.length}/${round.targets.length}`;
    const labels = { planning: '协调员正在安排讨论', collecting,
      summarizing: '等待协调员汇总讨论', ready: `讨论汇总已就绪，等待${name(context.owner)}当前工作结算` };
    items.push({ id: round.id, text: labels[round.status as keyof typeof labels], detail: `discussion · ${round.id}` });
  }
  const kinds = { owner: '主工作', assistance: '协助', facilitator: '协调', discussionSummary: '讨论汇总', check: '检查',
    cancel: '取消确认', tool: '工具调用', interpretation: '输入解析' };
  for (const work of context.intents.filter(i => ['pending', 'inflight', 'uncertain'].includes(i.status))) {
    const status = work.status === 'pending' ? '待领取' : work.status === 'uncertain' ? '执行结果待确认' : '等待返回';
    items.push({ id: work.id, text: `${name(work.target)} · ${kinds[work.kind]}${status}`,
      detail: work.id + (work.deadline === null ? '' : ` · 事件时钟截止 ${work.deadline}`) });
  }
  if (!items.length) items.push({ id: 'state', text: completionLabel(context) || context.reason || '当前没有待执行工作', detail: context.reason });
  return items;
}
export function frameSummary(frame: DebugFrame, graph: MachineGraph): string {
  if (frame.event.type === '@init') return '任务创建';
  if (frame.event.type === '@baseline') return '复制基线';
  if (!frame.evidence) return `${frame.from ?? '基线'} → ${frame.phase} · 条件未采集`;
  if (frame.evidence.definition !== graph.definition) return `${frame.from ?? '基线'} → ${frame.phase} · 机器结构版本不同`;
  const selected = graph.transitions.filter(rule => frame.evidence!.evaluations.some(e => e.ruleId === rule.id && e.passed));
  const changed = frame.evidence.changed, c = contextOf(frame);
  if (selected.some(rule => rule.actions.includes('reject')) || (changed.includes('reply') && !c.reply.ok)) return '已拒绝 · ' + (rejectionDescriptions[c.reply.code] ? rejectionDescriptions[c.reply.code] + ' · ' : '') + c.reply.code;
  if (!changed.length && selected.length) return '已处理 · 状态和上下文保持不变';
  return frame.from !== frame.phase ? `${frame.from} → ${frame.phase}` : `已更新上下文 · ${changed.length}项`;
}
export function branchStatus(rule: MachineTransition, frame: DebugFrame | undefined, graph: MachineGraph): string {
  if (!frame) return '待判断';
  if (!frame.evidence) return '此记录未采集';
  if (frame.evidence.definition !== graph.definition) return '机器结构版本不同，无法关联';
  const observations = frame.evidence.evaluations.filter(e => e.ruleId === rule.id);
  if (observations.some(e => e.passed)) return rule.guards.length ? '本次满足并命中' : '本次命中';
  if (observations.length) return '本次不满足';
  if (rule.event === '@always') return '本次未评估';
  const localEmpty = graph.transitions.some(t => t.source === frame.from && t.event === rule.event && !t.guards.length);
  if (rule.source === '*' && localEmpty) return '被局部无条件处理遮蔽';
  if (frame.evidence.evaluations.some(e => e.event === rule.event && e.passed)) return '前一分支已命中，未评估';
  return '本次未评估';
}
export interface ContextChange { path: string; before: unknown; after: unknown }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  const id = item.id ?? item.resultId ?? item.target;
  return typeof id === 'string' ? id : undefined;
};
/** Arrays align by domain identity, never by shifting numerical indices. */
export function contextChanges(before: TaskContext, after: TaskContext, limit = 200): { changes: ContextChange[]; truncated: boolean } {
  const changes: ContextChange[] = []; let truncated = false;
  const visit = (a: unknown, b: unknown, path: string) => {
    if (equal(a, b)) return;
    if (changes.length >= limit) { truncated = true; return; }
    if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(v => identity(v) !== undefined)
      && new Set(a.map(identity)).size === a.length && new Set(b.map(identity)).size === b.length) {
      const left = new Map(a.map(v => [identity(v)!, v])), right = new Map(b.map(v => [identity(v)!, v]));
      for (const id of new Set([...left.keys(), ...right.keys()])) visit(left.get(id), right.get(id), `${path}[${id}]`);
    } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) visit((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? path + '.' + key : key);
    } else changes.push({ path, before: a, after: b });
  };
  const priority = ['reply', 'outcome', 'reason', 'owner', 'epoch', 'goalVersion', 'usage', 'discussion', 'review', 'intents', 'assists', 'results'];
  for (const key of new Set([...priority, ...Object.keys(before), ...Object.keys(after)])) {
    visit(before[key as keyof TaskContext], after[key as keyof TaskContext], key);
  }
  return { changes, truncated };
}
export function previousFrame(frame: DebugFrame, frames: readonly DebugFrame[]): DebugFrame | undefined {
  const index = frames.indexOf(frame), previous = index > 0 ? frames[index - 1] : undefined;
  return previous && frame.previousStepId === frameKey(previous) ? previous : undefined;
}
