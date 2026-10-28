import { useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import { Collapsible } from "@base-ui/react/collapsible";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  FileText,
  Layers,
  LoaderCircle,
  Terminal,
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
  phaseLabel,
  Scroll,
  time,
} from "./ui";
import { MessageText } from "./MessageText";
import type { DetailTarget } from "./ResultLinks";
import { artifactsForAgent, messageArtifacts } from "./ResultLinks";
import { DetailActions, downloadDetailDocument } from "./DetailActions";
import { artifactDocument, buildDetailDocument } from "./detail-document";

const kindLabel: Record<WebWork["kind"], string> = {
  interpretation: "理解输入",
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
  REGENERATE_MODEL_OUTPUT: "重新生成模型输出",
  MODEL_OUTPUT_REPAIR: "修正模型输出格式",
  INTERPRETATION_RESULT: "保存输入理解",
  INPUT_INTERPRETED: "输入理解完成",
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
export function Details({
  snapshot,
  agent,
  onClose,
  connected,
  target,
  onAgent,
}: {
  snapshot: RoomSnapshot | null;
  agent: WebAgent | null;
  onClose: () => void;
  connected: boolean;
  target?: DetailTarget | undefined;
  onAgent?: ((id: string) => void) | undefined;
}) {
  const [tab, setTab] = useState("process");
  const [opened, setOpened] = useState<DetailTarget | null | undefined>(undefined);
  const focused = opened === undefined ? target : opened ?? undefined;
  const task =
    focused ? snapshot?.tasks.find((task) => task.id === focused.taskId)
      : snapshot?.tasks.find((task) => task.id === snapshot.activeTaskId) ?? snapshot?.tasks.at(-1);
  const works =
    snapshot?.works.filter(
      (work) => work.agentId === agent?.id && work.kind !== "cancel",
    ) ?? [];
  const artifacts = agent
    ? artifactsForAgent(snapshot, agent.id)
    : (task?.artifacts.map((artifact) => ({ ...artifact, taskId: task.id })) ?? []);
  const detailDocument = useMemo(() => focused ? null : buildDetailDocument(snapshot, { agent, tab }),
    [snapshot, agent, tab, focused]);
  if (focused) return <ResultDetails snapshot={snapshot} target={focused} connected={connected} onClose={onClose} onAgent={onAgent}
    onOpen={setOpened} onBack={() => setOpened(target ? { taskId: target.taskId, ...(target.messageId ? { messageId: target.messageId } : {}) } : null)} />;
  return (
    <aside
      className="details"
      aria-label={agent ? `${agent.name}的执行过程` : "任务详情"}
    >
      <DetailActions document={detailDocument} onClose={onClose}>
        <span>
          <Layers size={15} /> {agent ? "成员详情" : "任务详情"}
        </span>
      </DetailActions>
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
                  </div>
                )}
              </Scroll>
            </Tabs.Panel>
            <Tabs.Panel className="tab-panel" value="artifacts">
              <Scroll>
                <Artifacts artifacts={artifacts} onOpen={(artifact) => setOpened({ taskId: artifact.taskId, artifactId: artifact.id })} />
              </Scroll>
            </Tabs.Panel>
          </Tabs.Root>
          {!connected && (
            <div className="detail-foot" role="status">
              连接中断，等待重新连接
            </div>
          )}
        </>
      ) : (
        <Scroll>
          <div className="task-details">
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
                {!!task.inputAnalyses?.length && (
                  <Collapsible.Root className="task-log">
                    <Collapsible.Trigger>输入理解 <ChevronDown size={14} /></Collapsible.Trigger>
                    <Collapsible.Panel>
                      {task.inputAnalyses.map(input => (
                        <div className="board-entry" key={input.id}>
                          <span>{{ pending: "等待理解", inflight: "正在理解", resolved: "已理解", clarification: "等待澄清", failed: "理解失败", cancelled: "已取消" }[input.status]}</span>
                          <MessageText agents={snapshot?.agents ?? []} onAgent={onAgent ?? noAgentAction} text={input.spec?.objective ?? input.rawText} />
                          {input.spec && <MessageText agents={snapshot?.agents ?? []} onAgent={onAgent ?? noAgentAction} text={[
                            ...input.spec.constraints.map(item => `- 约束：${item}`),
                            ...input.spec.expectedOutputs.map(item => `- 交付：${item}`),
                            ...input.spec.acceptanceCriteria.map(item => `- 验收：${item}`),
                            ...(input.spec.clarification ? [input.spec.clarification] : []),
                          ].join("\n")} />}
                        </div>
                      ))}
                    </Collapsible.Panel>
                  </Collapsible.Root>
                )}
                <h3 className="detail-section-heading">交付产物</h3>
                <Artifacts artifacts={artifacts} onOpen={(artifact) => setOpened({ taskId: artifact.taskId, artifactId: artifact.id })} />
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
  onOpen,
}: {
  artifacts: { id: string; name: string; content: string; taskId: string }[];
  onOpen: (artifact: { id: string; taskId: string }) => void;
}) {
  if (!artifacts.length)
    return (
      <div className="artifact-empty">
        <FileText size={24} strokeWidth={1.3} />
        <p>暂无产物</p>
      </div>
    );
  return (
    <div className="artifact-list">
      {artifacts.map((artifact) => (
        <div className="artifact-item" key={`${artifact.taskId}:${artifact.id}`}>
          <FileText size={18} />
          <Button className="artifact-name" aria-label={`查看 ${artifact.name}`} onClick={() => onOpen(artifact)}>{artifact.name}</Button>
          <Button
            className="icon-button"
            aria-label={`下载 ${artifact.name}`}
            onClick={() => downloadDetailDocument(artifactDocument(artifact, artifact.taskId))}
          >
            <ArrowDownToLine size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}

const noAgentAction = () => {};

function ResultDetails({ snapshot, target, onClose, onOpen, onBack, connected, onAgent }: {
  snapshot: RoomSnapshot | null;
  target: DetailTarget;
  onClose: () => void;
  onOpen: (target: DetailTarget) => void;
  onBack: () => void;
  connected: boolean;
  onAgent?: ((id: string) => void) | undefined;
}) {
  const task = snapshot?.tasks.find((item) => item.id === target.taskId);
  const message = target.messageId ? snapshot?.messages.find((item) => item.taskId === target.taskId && item.id === target.messageId) : undefined;
  const artifact = target.artifactId ? task?.artifacts.find((item) => item.id === target.artifactId) : undefined;
  const available = !!task && (!target.messageId || !!message) && (!target.artifactId || !!artifact);
  const artifacts = (message ? messageArtifacts(snapshot, message) : task?.artifacts ?? []).map((item) => ({ ...item, taskId: target.taskId }));
  const events = snapshot?.events.filter((event) => event.taskId === target.taskId) ?? [];
  const author = artifact?.author ?? message?.author;
  const agent = snapshot?.agents.find((item) => item.id === author);
  const detailDocument = useMemo(() => buildDetailDocument(snapshot, { target }),
    [snapshot, target.taskId, target.messageId, target.artifactId]);
  return (
    <aside className="details" aria-label={artifact ? "报告预览" : "结果详情"}>
      <DetailActions document={detailDocument} onClose={onClose}>
        <span><FileText size={15} /> {artifact ? "报告" : "详情"}</span>
      </DetailActions>
      <Scroll>
        <div className="task-details result-details">
          {!available ? <p className="no-record">内容已不可用</p> : artifact ? <>
            <Button className="result-back" onClick={onBack}><ArrowLeft size={13} /> 返回详情</Button>
            <div className="report-heading"><h2>{artifact.name}</h2></div>
            {author && <p className="report-author">{agent?.name ?? author}</p>}
            {/\.(?:md|markdown)$/i.test(artifact.name)
              ? <MessageText text={artifact.content} agents={onAgent ? snapshot?.agents ?? [] : []} onAgent={onAgent ?? noAgentAction} />
              : <pre className="report-plain"><code>{artifact.content}</code></pre>}
          </> : <>
            <h2>{task!.goal}</h2>
            <span className="task-state">{connected ? phaseLabel(task) : "连接中断"}</span>
            {message && <MessageText text={message.detailText ?? message.text} agents={onAgent ? snapshot?.agents ?? [] : []} onAgent={onAgent ?? noAgentAction} />}
            {!message && task!.reason && <p className="task-reason">{task!.reason}</p>}
            {!!artifacts.length && <Artifacts artifacts={artifacts} onOpen={(item) => onOpen({ ...target, artifactId: item.id })} />}
            {!!task!.board.length && <section className="result-evidence" aria-label="依据">
              <h3 className="detail-section-heading">依据</h3>
              {task!.board.map((entry) => <div className="board-entry" key={entry.id}>
                <MessageText text={entry.text} agents={onAgent ? snapshot?.agents ?? [] : []} onAgent={onAgent ?? noAgentAction} />
                {entry.sources.map((source) => /^https?:\/\//.test(source)
                  ? <a href={source} key={source} target="_blank" rel="noreferrer">查看来源 <ArrowUpRight size={12} /></a>
                  : <code key={source}>{source}</code>)}
              </div>)}
            </section>}
            {!!events.length && <section className="result-events" aria-label="执行记录">
              <h3 className="detail-section-heading">执行记录</h3>
              {events.map((event) => <details className={`result-event ${event.kind}`} key={event.id}>
                <summary><EventIcon event={event} /><span>{event.title}</span><time>{time(event.at)}</time></summary>
                <pre>{event.detail || "没有附加内容"}</pre>
              </details>)}
            </section>}
            {!!task!.trace.length && <details className="result-trace"><summary>调度记录</summary>
              {task!.trace.map((trace, index) => <div className="trace-row" key={index}><span>{traceLabel[trace.event] ?? trace.event}</span><time>{time(trace.at)}</time></div>)}
            </details>}
          </>}
        </div>
      </Scroll>
      {!connected && <div className="detail-foot" role="status">连接中断，等待重新连接</div>}
    </aside>
  );
}
