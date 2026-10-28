import type { CSSProperties, ReactNode } from "react";
import { Button } from "@base-ui/react/button";
import { Tooltip } from "@base-ui/react/tooltip";
import { ScrollArea } from "@base-ui/react/scroll-area";
import type { RoomSnapshot, WebAgent, WebTask } from "../../src/web/contracts";

const colors = ["#4d759b", "#9a75a1", "#5b8b75", "#b38b55", "#7787af"];
export const agentColor = (id: string) =>
  colors[
    id === "A"
      ? 0
      : id === "B"
        ? 1
        : id === "builder-1"
          ? 2
          : id === "builder-2"
            ? 3
            : 4
  ]!;
export function AgentAvatar({
  agent,
  small = false,
}: {
  agent: Pick<WebAgent, "id" | "name">;
  small?: boolean;
}) {
  return (
    <span
      className={`agent-avatar ${small ? "small" : ""}`}
      style={{ "--agent-color": agentColor(agent.id) } as CSSProperties}
      aria-hidden="true"
    >
      {agent.id.startsWith("builder-") ? (
        <span className="builder-symbol">
          ⌘<sub>{agent.id.slice(-1)}</sub>
        </span>
      ) : agent.id === "facilitator" ? (
        "S"
      ) : (
        agent.id.slice(0, 2)
      )}
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  className = "",
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            className={`icon-button ${className}`}
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Scroll({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ScrollArea.Root className={`scroll-root ${className}`}>
      <ScrollArea.Viewport className="scroll-viewport">
        <ScrollArea.Content>{children}</ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="scrollbar">
        <ScrollArea.Thumb className="scrollbar-thumb" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
export const phaseLabel = (task: WebTask | undefined) =>
  !task
    ? "等待开始"
    : task.phase === "ended"
      ? {
          complete: "已完成",
          partial: "部分完成",
          failed: "执行失败",
          stopped: "已停止",
        }[task.outcome ?? "failed"]
      : task.review?.status === "pending" && task.phase === "coordinating"
        ? "组织成员评审"
        : task.review?.status === "reviewing" &&
            task.phase === "waitingAssistance"
          ? `成员评审 ${task.review.completed.length}/${task.review.targets.length}`
          : task.review?.status === "summarizing" && task.phase === "running"
            ? "汇总评审意见"
            : {
                interpreting: "正在理解输入",
                running: "正在执行",
                waitingAssistance: "等待协助",
                coordinating: "正在协调",
                waitingHuman: "等待你的回复",
                checking: "检查交付",
                stopping: "正在停止",
              }[task.phase];
export function agentStatus(
  id: string,
  snapshot: RoomSnapshot | null,
  connected: boolean,
) {
  if (!connected) return "连接中断";
  if (!snapshot) return "空闲";
  const active = snapshot.works.filter(
    (work) => work.agentId === id && work.taskId === snapshot.activeTaskId,
  );
  if (
    active.some((work) => work.status === "inflight" && work.kind !== "cancel")
  )
    return "执行中";
  if (
    active.some((work) => work.status === "pending" && work.kind !== "cancel")
  )
    return "待执行";
  const task = snapshot.tasks.find((task) => task.id === snapshot.activeTaskId);
  if (task?.owner === id && task.phase === "waitingHuman") return "等待回复";
  if (task?.owner === id && task.phase === "waitingAssistance")
    return "等待协助";
  return "空闲";
}
export const time = (at: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
