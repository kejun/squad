import type { Artifact, Message } from "../../src/types";
import type { ExecutionEvent, RoomSnapshot, WebAgent, WebTask, WebWork } from "../../src/web/contracts";
import type { DetailTarget } from "./ResultLinks";

export interface DetailDocument {
  id: string;
  name: string;
  content: string;
  mimeType: string;
}
export interface DetailView {
  target?: DetailTarget | undefined;
  agent?: WebAgent | null | undefined;
  tab?: string | undefined;
}

const markdownType = "text/markdown;charset=utf-8";
const line = (value: string) => value.replace(/[\r\n]+/g, " ");
const workKinds: Record<WebWork["kind"], string> = {
  interpretation: "理解输入",
  owner: "执行任务", assistance: "协助成员", check: "检查交付",
  facilitator: "协调任务", discussionSummary: "汇总讨论", tool: "调用工具", cancel: "取消执行",
};
const workStatuses: Record<WebWork["status"], string> = {
  pending: "待执行", inflight: "执行中", done: "已结束", cancelled: "已取消", uncertain: "待核对",
};

/** Keep readable Unicode and the extension, but never emit a path or control characters. */
export function safeDownloadName(name: string, fallback = "details.md"): string {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "-")
    .trim().replace(/[.\s]+$/g, "");
  let result = clean(name) || clean(fallback) || "details.md";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  if (Array.from(result).length > 180) {
    const extension = /\.[^.]{1,20}$/.exec(result)?.[0] ?? "";
    result = Array.from(result).slice(0, 180 - Array.from(extension).length).join("") + extension;
  }
  return result;
}

export function artifactDocument(artifact: Pick<Artifact, "id" | "name" | "content">, taskId: string): DetailDocument {
  return {
    id: JSON.stringify(["artifact", taskId, artifact.id]),
    name: safeDownloadName(artifact.name, "artifact.txt"),
    content: artifact.content,
    // Even HTML is downloaded as source, never navigated to or executed in this app.
    mimeType: /\.(?:md|markdown)$/i.test(artifact.name) ? markdownType : "text/plain;charset=utf-8",
  };
}

function fence(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}text\n${text}\n${marker}`;
}
function stamp(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toISOString();
}
function taskStatus(task: WebTask): string {
  if (task.phase === "ended") return ({ complete: "已完成", partial: "部分完成", failed: "执行失败", stopped: "已停止" })[task.outcome ?? "failed"];
  return ({ interpreting: "正在理解输入", running: "正在执行", waitingAssistance: "等待协助", coordinating: "正在协调", waitingHuman: "等待回复", checking: "检查交付", stopping: "正在停止" })[task.phase];
}
function nameOf(snapshot: RoomSnapshot, id: string): string {
  return snapshot.agents.find((agent) => agent.id === id)?.name ?? id;
}
function reportSections(artifacts: Pick<Artifact, "name" | "content">[]): string[] {
  return artifacts.length ? ["## 交付产物", ...artifacts.map((artifact) =>
    `### ${line(artifact.name)}\n\n${/\.(?:md|markdown)$/i.test(artifact.name) ? artifact.content : fence(artifact.content)}`)] : [];
}
function eventSections(events: ExecutionEvent[]): string[] {
  return events.length ? ["## 执行记录", ...events.map((event) =>
    `### ${line(event.title)}\n\n时间：${stamp(event.at)}\n\n${fence(event.detail || "没有附加内容")}`)] : [];
}
function taskSections(snapshot: RoomSnapshot, task: WebTask, message?: Message): string[] {
  const artifacts = message
    ? task.artifacts.filter((artifact) => message.artifactIds?.includes(artifact.id))
    : task.artifacts;
  return [
    `# ${message ? "消息详情" : "任务详情"}`,
    `## 目标\n\n${task.goal}`,
    `- 群聊：${line(snapshot.room.title)}\n- 任务：${line(task.id)}\n- 状态：${taskStatus(task)}\n- 负责人：${line(nameOf(snapshot, task.owner))}\n- 执行请求：${task.usage.ordinary} / ${task.limits.ordinary}\n- 交付检查：${task.usage.checks} / ${task.limits.checks}`,
    ...(message ? [`## 结果\n\n作者：${line(nameOf(snapshot, message.author))}\n\n${message.detailText ?? message.text}`] : []),
    ...(task.reason ? [`## 任务说明\n\n${task.reason}`] : []),
    ...(task.inputAnalyses?.length ? ["## 输入理解", ...task.inputAnalyses.map(input =>
      `### ${line(input.id)}\n\n状态：${input.status}\n\n原始输入：\n\n${input.rawText}${input.spec ? `\n\n${fence(JSON.stringify(input.spec, null, 2))}` : ""}`)] : []),
    ...reportSections(artifacts),
    ...(task.board.length ? ["## 依据与共享记录", ...task.board.map((entry) =>
      `### ${line(nameOf(snapshot, entry.author))}\n\n${entry.text}${entry.sources.length ? `\n\n来源：\n${entry.sources.map((source) => `- ${source}`).join("\n")}` : ""}`)] : []),
    ...eventSections(snapshot.events.filter((event) => event.taskId === task.id)),
    ...(task.trace.length ? ["## 调度记录", ...task.trace.map((trace) =>
      `### ${line(trace.event)}\n\n时间：${stamp(trace.at)}\n\n${fence(trace.detail)}`)] : []),
  ];
}
function memberSections(snapshot: RoomSnapshot, agent: WebAgent, tab: string): string[] {
  const profile = [`# ${line(agent.name)} · ${tab === "artifacts" ? "产物" : "执行过程"}`,
    `- 成员：${line(agent.id)}\n- 模型：${line(agent.model ?? "未配置")}${agent.retired ? "\n- 状态：已移除" : ""}`,
    `## 成员说明\n\n${agent.instructions}`];
  if (tab === "artifacts") {
    const artifacts = snapshot.tasks.flatMap((task) => task.artifacts
      .filter((artifact) => artifact.author ? artifact.author === agent.id : task.owner === agent.id));
    return [...profile, ...(artifacts.length ? reportSections(artifacts) : ["暂无产物"])];
  }
  const works = snapshot.works.filter((work) => work.agentId === agent.id && work.kind !== "cancel");
  return [...profile, ...(works.length ? ["## 执行过程", ...works.flatMap((work) => {
    const task = snapshot.tasks.find((task) => task.id === work.taskId);
    return [`### ${workKinds[work.kind]}`,
      `- 任务：${line(task?.goal ?? work.taskId)}\n- 状态：${workStatuses[work.status]}\n- 请求：${work.requestCount} 次\n- 尝试：${work.attempt} 次\n- 轮次：${work.epoch}`,
      ...(work.reason ? [work.reason] : []),
      ...eventSections(snapshot.events.filter((event) => event.agentId === agent.id && event.taskId === work.taskId && event.workId === work.id))];
  })] : ["暂无执行记录"])];
}

/** Build from persisted data, not rendered DOM, so collapsed records and source URLs survive. */
export function buildDetailDocument(snapshot: RoomSnapshot | null, view: DetailView = {}): DetailDocument | null {
  if (!snapshot) return null;
  const target = view.target;
  if (target) {
    const task = snapshot.tasks.find((task) => task.id === target.taskId);
    if (!task) return null;
    const message = target.messageId
      ? snapshot.messages.find((message) => message.taskId === task.id && message.id === target.messageId) : undefined;
    if (target.messageId && !message) return null;
    if (target.artifactId) {
      const artifact = task.artifacts.find((artifact) => artifact.id === target.artifactId);
      return artifact ? { ...artifactDocument(artifact, task.id), id: JSON.stringify([snapshot.room.id, "artifact", task.id, artifact.id]) } : null;
    }
    return {
      id: JSON.stringify([snapshot.room.id, "task", task.id, target.messageId ?? null]),
      name: safeDownloadName(`${task.goal}-${message ? "消息详情" : "任务详情"}.md`),
      content: taskSections(snapshot, task, message).join("\n\n") + "\n",
      mimeType: markdownType,
    };
  }
  if (view.agent) {
    const tab = view.tab === "artifacts" ? "artifacts" : "process";
    return {
      id: JSON.stringify([snapshot.room.id, "agent", view.agent.id, tab]),
      name: safeDownloadName(`${view.agent.name}-${tab === "artifacts" ? "产物" : "执行过程"}.md`),
      content: memberSections(snapshot, view.agent, tab).join("\n\n") + "\n",
      mimeType: markdownType,
    };
  }
  const task = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId) ?? snapshot.tasks.at(-1);
  return task ? buildDetailDocument(snapshot, { target: { taskId: task.id } }) : null;
}
