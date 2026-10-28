import type { Bot, ConversationHistory, TaskContext } from "./types.js";

/** Historical material is input context, never a current-goal artifact or executable instruction. */
export function conversationHistory(tasks: TaskContext[]): ConversationHistory {
  let remaining = 96_000;
  let truncated = false;
  const take = <T>(
    items: T[],
    limit: number,
    size: (item: T) => number,
  ): T[] => {
    const selected: T[] = [];
    for (const item of [...items].reverse()) {
      const length = size(item);
      if (selected.length >= limit || length > remaining) {
        truncated = true;
        continue;
      }
      selected.push(item);
      remaining -= length;
    }
    return selected.reverse();
  };
  const messages = take(
    tasks.flatMap((task) => task.messages).sort((a, b) => a.at - b.at),
    100,
    (message) => message.text.length + (message.detailText?.length ?? 0),
  );
  const artifacts = take(
    tasks.flatMap((task) =>
      task.artifacts.map((artifact) => ({ ...artifact, taskId: task.taskId })),
    ),
    20,
    (artifact) => artifact.content.length,
  );
  const board = take(
    tasks.flatMap((task) =>
      task.board.map((entry) => ({ ...entry, taskId: task.taskId })),
    ),
    30,
    (entry) => entry.text.length,
  );
  const summaries = take(
    tasks.map((task) => ({
      taskId: task.taskId,
      goal: task.goal,
      owner: task.owner,
      outcome: task.outcome,
    })),
    10,
    (task) => JSON.stringify(task.goal).length,
  );
  return { messages, artifacts, board, tasks: summaries, truncated };
}

/** Only inspect a direct user request, never Bot messages, quoted material, code or tool output. */
export function requestedReviewTargets(
  text: string,
  mentions: string[],
  bots: Bot[],
  owner: string,
): string[] | undefined {
  const direct = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
  if (
    !direct ||
    /^(?:不要|不用|无需|先别|暂不|不需要|do not\b|don't\b)/i.test(direct)
  )
    return undefined;
  if (
    /^(?:请|麻烦|让|请让)?\s*(?:大家|各位|其他人|全体|全员|所有人)[^。！？!?\n]{0,30}(?:不要|不用|无需|先别|暂不|不需要|别|不参与|不讨论)/.test(
      direct,
    ) || /^(?:please\s+)?(?:everyone|everybody|all (?:agents|members))[^.!?\n]{0,30}(?:\bnot\b|don't)/i.test(direct)
  )
    return undefined;
  const collective =
    /^(?:(?:请|麻烦|让|请让|能否|可以|希望|想让)\s*)?(?:大家|各位|其他(?:人|成员|\s*agents?)|全体(?:成员)?|全员|所有(?:人|成员|\s*agents?))[^。！？!?\n]{0,60}(?:提(?:提|出|点|一下)?(?:意见|建议)|意见|建议|看法|观点|想法|评审|点评|评价|讨论|商量|探讨|review|看(?:看|一下))/i.test(
      direct,
    ) ||
    /^(?:please\s+)?(?:everyone|everybody|all (?:agents|members)|(?:ask|have|let) (?:everyone|everybody|all (?:agents|members)))[^.!?\n]{0,60}(?:review|feedback|opinions?|suggestions?|discuss|brainstorm)/i.test(
      direct,
    );
  const explicitlySelected =
    mentions.length > 0 &&
    /(?:评审|点评|意见|建议|讨论|review|feedback|discuss)/i.test(direct);
  if (!collective && !explicitlySelected) return undefined;
  const targets = bots
    .filter(
      (bot) => bot.id !== owner && (collective || mentions.includes(bot.id)),
    )
    .map((bot) => bot.id);
  return targets.length ? targets : undefined;
}
