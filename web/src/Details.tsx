import { useState } from "react";
import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  FileText,
  Layers,
  LoaderCircle,
  Terminal,
  X,
} from "lucide-react";
import type {
  ExecutionEvent,
  RoomSnapshot,
  WebAgent,
  WebWork,
} from "../../src/web/contracts";
import {
  AgentAvatar,
  agentStatus,
  IconButton,
  phaseLabel,
  Scroll,
  time,
} from "./ui";

const kindLabel: Record<WebWork["kind"], string> = {
  owner: "执行任务",
  assistance: "协助成员",
  check: "检查交付",
  facilitator: "协调任务",
  tool: "调用工具",
  cancel: "取消执行",
};
const statusLabel: Record<WebWork["status"], string> = {
  pending: "待执行",
  inflight: "执行中",
  done: "已结束",
  cancelled: "已取消",
  uncertain: "待核对",
};
const traceLabel: Record<string, string> = {
  CLAIM: "领取工作",
  CONSUME: "发起请求",
  HELP: "请求成员协助",
  RECORD_RESULT: "保存协助结果",
  HELP_RESULT: "接收协助结果",
  DELIVER: "提交交付",
  CHECK_RESULT: "检查交付",
  STOP: "停止任务",
  SETTLE: "结算执行",
  CONTINUE: "继续任务",
  WORK_FAILED: "执行失败",
  RECOVER: "恢复任务",
  USER_INPUT: "收到补充",
  BOUNDARY: "应用补充",
  HUMAN_DECISION: "收到用户决定",
  COORDINATE: "协调任务",
};
function EventIcon({ event }: { event: ExecutionEvent }) {
  return event.kind === "error" ? (
    <CircleAlert size={13} />
  ) : event.kind === "output" || event.kind === "tool-result" ? (
    <Check size={13} />
  ) : event.kind === "tool-start" ? (
    <Terminal size={13} />
  ) : (
    <Circle size={9} />
  );
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Details({
  snapshot,
  agent,
  onClose,
  connected,
}: {
  snapshot: RoomSnapshot | null;
  agent: WebAgent | null;
  onClose: () => void;
  connected: boolean;
}) {
  const [tab, setTab] = useState("process");
  const task =
    snapshot?.tasks.find((task) => task.id === snapshot.activeTaskId) ??
    snapshot?.tasks.at(-1);
  const works =
    snapshot?.works.filter(
      (work) => work.agentId === agent?.id && work.kind !== "cancel",
    ) ?? [];
  const artifacts = agent
    ? (snapshot?.tasks
        .filter((task) => task.owner === agent.id)
        .flatMap((task) => task.artifacts) ?? [])
    : (task?.artifacts ?? []);
  return (
    <aside
      className="details"
      aria-label={agent ? `${agent.name}的执行过程` : "任务详情"}
    >
      <header className="details-header">
        <span>
          <Layers size={15} /> {agent ? "成员详情" : "任务详情"}
        </span>
        <IconButton label="关闭详情" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>
      {agent ? (
        <>
          <div className="agent-profile">
            <AgentAvatar agent={agent} />
            <div>
              <h2>{agent.name}</h2>
              <span className="profile-id">{agent.id}</span>
            </div>
            <span
              className={`status-label ${agentStatus(agent.id, snapshot, connected) === "执行中" ? "active" : ""}`}
            >
              <i />
              {agent.retired
                ? "已移除"
                : agentStatus(agent.id, snapshot, connected)}
            </span>
          </div>
          <p className="agent-description">{agent.instructions}</p>
          <div className="agent-meta">
            <span>模型</span>
            <code>{agent.model ?? "未配置"}</code>
          </div>
          <Tabs.Root
            className="detail-tabs"
            value={tab}
            onValueChange={(value) => setTab(String(value))}
          >
            <Tabs.List className="tab-list">
              <Tabs.Tab value="process">
                执行过程 <span>{works.length}</span>
              </Tabs.Tab>
              <Tabs.Tab value="artifacts">
                产物 <span>{artifacts.length}</span>
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel className="tab-panel" value="process">
              <Scroll>
                {works.length ? (
                  <div className="work-list">
                    {works.map((work, index) => {
                      const events =
                        snapshot?.events.filter(
                          (event) => event.workId === work.id,
                        ) ?? [];
                      return (
                        <section className="work" key={work.id}>
                          <div className="work-heading">
                            <span
                              className={`work-marker ${work.status}`}
                              aria-hidden="true"
                            >
                              {work.status === "inflight" ? (
                                <LoaderCircle size={13} className="spin" />
                              ) : work.status === "done" ? (
                                <Check size={12} />
                              ) : (
                                <Circle size={8} />
                              )}
                            </span>
                            <h3>{kindLabel[work.kind]}</h3>
                            <span className="work-count">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                          </div>
                          <div className="work-body">
                            <p className="work-reason">{work.reason}</p>
                            <div className="work-status">
                              <span>
                                {connected
                                  ? statusLabel[work.status]
                                  : "连接中断，状态待同步"}
                              </span>
                              <span>
                                请求 {work.requestCount} 次
                                {work.attempt > 1
                                  ? ` · 第 ${work.attempt} 次尝试`
                                  : ""}
                              </span>
                            </div>
                            <div className="events">
                              {events.map((event) => (
                                <Collapsible.Root
                                  className={`execution-event ${event.kind}`}
                                  key={event.id}
                                >
                                  <Collapsible.Trigger className="event-trigger">
                                    <span className="event-icon">
                                      <EventIcon event={event} />
                                    </span>
                                    <span>{event.title}</span>
                                    <time>{time(event.at)}</time>
                                    <ChevronDown
                                      size={12}
                                      className="collapse-arrow"
                                    />
                                  </Collapsible.Trigger>
                                  <Collapsible.Panel className="event-panel">
                                    <pre>{event.detail || "没有附加内容"}</pre>
                                    <div className="source-reference">
                                      来源：
                                      {work.kind === "assistance"
                                        ? "成员协助请求"
                                        : "任务执行"}{" "}
                                      · 轮次 {work.epoch}
                                    </div>
                                  </Collapsible.Panel>
                                </Collapsible.Root>
                              ))}
                            </div>
                            {!events.length && (
                              <p className="no-record">
                                {work.status === "pending"
                                  ? "等待调度后显示执行记录"
                                  : "此操作暂无详细记录"}
                              </p>
                            )}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                ) : (
                  <div className="detail-empty">
                    <Terminal size={26} strokeWidth={1.3} />
                    <h3>还没有执行记录</h3>
                    <p>
                      在群聊中 @{agent.id} 发起任务，
                      <br />
                      执行过程会显示在这里。
                    </p>
                  </div>
                )}
              </Scroll>
            </Tabs.Panel>
            <Tabs.Panel className="tab-panel" value="artifacts">
              <Scroll>
                <Artifacts artifacts={artifacts} />
              </Scroll>
            </Tabs.Panel>
          </Tabs.Root>
          <div className="detail-foot">
            <span className="tiny-dot" />
            {connected ? "执行记录自动同步" : "连接中断，等待重新连接"}
          </div>
        </>
      ) : (
        <Scroll>
          <div className="task-details">
            <div className="section-eyebrow">当前任务</div>
            <h2>{task?.goal ?? "从一条消息开始"}</h2>
            <span className="task-state">
              {connected ? phaseLabel(task) : "连接中断"}
            </span>
            {task && (
              <>
                <div className="task-info">
                  <span>负责人</span>
                  <strong>
                    {snapshot?.agents.find((agent) => agent.id === task.owner)
                      ?.name ?? task.owner}
                  </strong>
                </div>
                <div className="task-info">
                  <span>执行请求</span>
                  <strong>
                    {task.usage.ordinary} / {task.limits.ordinary}
                  </strong>
                </div>
                <div className="task-info">
                  <span>交付检查</span>
                  <strong>
                    {task.usage.checks} / {task.limits.checks}
                  </strong>
                </div>
                {task.reason && <p className="task-reason">{task.reason}</p>}
                <h3 className="detail-section-heading">交付产物</h3>
                <Artifacts artifacts={artifacts} />
                {!!task.board.length && (
                  <>
                    <h3 className="detail-section-heading">共享记录</h3>
                    {task.board.map((entry) => (
                      <div className="board-entry" key={entry.id}>
                        <span>
                          {entry.author} · {entry.kind}
                        </span>
                        <p>{entry.text}</p>
                        {entry.sources.map((source) =>
                          /^https?:\/\//.test(source) ? (
                            <a
                              href={source}
                              key={source}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看来源 <ArrowUpRight size={12} />
                            </a>
                          ) : (
                            <code key={source}>{source}</code>
                          ),
                        )}
                      </div>
                    ))}
                  </>
                )}
                <Collapsible.Root className="task-log">
                  <Collapsible.Trigger>
                    调度记录 <ChevronDown size={14} />
                  </Collapsible.Trigger>
                  <Collapsible.Panel>
                    {task.trace.map((trace, index) => (
                      <div className="trace-row" key={index}>
                        <span>{traceLabel[trace.event] ?? trace.event}</span>
                        <time>{time(trace.at)}</time>
                      </div>
                    ))}
                  </Collapsible.Panel>
                </Collapsible.Root>
              </>
            )}
          </div>
        </Scroll>
      )}
    </aside>
  );
}
function Artifacts({
  artifacts,
}: {
  artifacts: { id: string; name: string; content: string }[];
}) {
  if (!artifacts.length)
    return (
      <div className="artifact-empty">
        <FileText size={24} strokeWidth={1.3} />
        <p>暂无产物</p>
        <span>成员交付的文件会保存在这里</span>
      </div>
    );
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => (
        <div className="artifact-item" key={artifact.id}>
          <FileText size={18} />
          <span>{artifact.name}</span>
          <Button
            className="icon-button"
            aria-label={`下载 ${artifact.name}`}
            onClick={() => download(artifact.name, artifact.content)}
          >
            <ArrowDownToLine size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}
