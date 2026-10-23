import type { Assistance, TeamConfig } from './types.js';

export const retryableAssistance = (h: Assistance) => ['failed', 'timeout', 'partial', 'cancelled', 'answered'].includes(h.status);

/** Only complete, direct user commands are recognized; quoted history is never parsed. */
export function requestedRetryTarget(text: string, bots: TeamConfig['bots']): string | undefined {
  const command = text.trim().replace(/[。！!]+$/, '').trim();
  for (const bot of bots) for (const name of new Set([bot.id, bot.name])) {
    if ([`${name} 重试`, `@${name} 重试`, `重试 ${name}`, `重试 @${name}`, `${name}重试`, `@${name}重试`].includes(command)) return bot.id;
  }
  return undefined;
}

export function retryProblemText(code: string): string {
  const messages: Record<string, string> = {
    UNKNOWN_HELP: '找不到这次协助。', TASK_NOT_FOUND: '找不到原任务。',
    RETRY_REFERENCE_REQUIRED: '请从原协助的重试入口选择任务。',
    ASSISTANCE_NOT_FOUND: '没有找到该成员可重试的协助，请查看原任务中的协助记录。',
    AMBIGUOUS_ASSISTANCE: '该成员有多项中断协助，请点击对应协助的重试按钮。',
    ASSISTANCE_ALREADY_RETRIED: '这次协助已安排重试，请查看新的执行结果。',
    ASSISTANCE_NOT_RETRYABLE: '这次协助仍在执行或已经完成。',
    STALE_HELP: '任务目标或执行轮次已变化，请由负责人重新安排核查。',
    STALE_REVIEW: '这次协助属于旧评审，请继续当前任务。',
    OWNER_CHANGED: '负责人已变化，请由当前负责人重新安排核查。',
    TASK_COMPLETED: '原任务已经完成，请明确提出新的要求。',
    UNRESOLVED_WORK: '请等待在途工作结算；结果不确定的操作须先核对。',
    INCOMPATIBLE_EXECUTION: '执行配置已变化，请先核对原任务。',
    UNKNOWN_BOT: '核查成员已不可用。', OWNER_UNAVAILABLE: '原负责人已不可用。',
    TOOL_PERMISSION: '核查所需的工具权限已撤销。', ASSISTANCE_BUSY: '请先结算正在执行的协助。',
    RETRY_LIMIT: '重试额度已用尽。', ASSISTANCE_LIMIT: '求助额度已用尽。',
    ASSISTANCE_RESUME_BUDGET: '需要至少两次可用执行额度，供核查和负责人续办。',
    BUDGET_EXHAUSTED: '负责人续办所需的执行额度已用尽。',
    RESULT_NOT_AVAILABLE: '核查结果暂未就绪，请等待恢复。', ROOM_BUSY: '请先完成或停止当前任务。',
  };
  return messages[code] ?? code;
}
