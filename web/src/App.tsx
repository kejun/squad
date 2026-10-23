import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Hash,
  Layers,
  LoaderCircle,
  Menu,
  PanelRight,
  Plus,
  Radio,
  Square,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import type { Message } from "../../src/types";
import type { WebAgent } from "../../src/web/contracts";
import { api, useWorkspace } from "./api";
import { Details } from "./Details";
import { AgentAvatar, agentStatus, IconButton, phaseLabel, time } from "./ui";

const MessageText = lazy(() =>
  import("./MessageText").then((module) => ({ default: module.MessageText })),
);

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span>
          squad<span className="brand-period">.</span>
        </span>
      )}
    </div>
  );
}
export function App() {
  const workspace = useWorkspace();
  const {
    rooms,
    roomId,
    snapshot,
    connected,
    error,
    setError,
    chooseRoom,
    createRoom,
  } = workspace;
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mentionsByRoom, setMentionsByRoom] = useState<
    Record<string, string[]>
  >({});
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const sendIdentity = useRef<{
    roomId: string;
    text: string;
    id: string;
  } | null>(null);
  const draftKey = roomId ?? "new";
  const text = drafts[draftKey] ?? "";
  const agents = snapshot?.agents ?? [];
  const task = snapshot?.tasks.find(
    (task) => task.id === snapshot.activeTaskId,
  );
  const latestTask = task ?? snapshot?.tasks.at(-1);
  const selected = agents.find((agent) => agent.id === selectedAgent) ?? null;
  const activeAgents = agents.filter((agent) => !agent.retired);
  const query = /@([\w-]*)$/.exec(text)?.[1]?.toLowerCase() ?? "";
  const mentionCandidates = activeAgents.filter((agent) =>
    `${agent.id} ${agent.name}`.toLowerCase().includes(query),
  );
  const setText = (value: string) =>
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));

  useEffect(() => {
    setMentionOpen(false);
    setSidebarOpen(false);
    setSelectedAgent(null);
    setDetailOpen(false);
    atBottom.current = true;
  }, [roomId]);
  useEffect(() => {
    if (chat.current && atBottom.current)
      chat.current.scrollTop = chat.current.scrollHeight;
  }, [snapshot?.messages.length, roomId]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
    }
  }, [text]);
  const openAgent = useCallback((id: string) => {
    setSelectedAgent(id);
    setDetailOpen(true);
    setSidebarOpen(false);
  }, []);
  const addMention = (agent: WebAgent) => {
    const withoutQuery = text.replace(/@[\w-]*$/, "");
    setText(
      `${withoutQuery}${withoutQuery && !/\s$/.test(withoutQuery) ? " " : ""}@${agent.id} `,
    );
    setMentionsByRoom((previous) => ({
      ...previous,
      [draftKey]: [...new Set([...(previous[draftKey] ?? []), agent.id])],
    }));
    setMentionOpen(false);
    textarea.current?.focus();
  };
  const newRoom = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createRoom();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setCreating(false);
    }
  };
  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n" &&
        connected
      ) {
        event.preventDefault();
        void createRoom().catch((error) => setError((error as Error).message));
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [connected, createRoom, setError]);
  const send = async (continueTask = false) => {
    if (sending || !connected || (!text.trim() && !continueTask)) return;
    setSending(true);
    setError("");
    try {
      const targetRoom = roomId ?? (await createRoom());
      const content = continueTask ? "继续执行当前任务" : text.trim();
      if (!roomId && !continueTask) {
        setDrafts((previous) => ({ ...previous, [targetRoom]: text }));
        setMentionsByRoom((previous) => ({
          ...previous,
          [targetRoom]: previous[draftKey] ?? [],
        }));
      }
      const identity = sendIdentity.current;
      const id =
        identity?.roomId === targetRoom && identity.text === content
          ? identity.id
          : crypto.randomUUID();
      sendIdentity.current = { roomId: targetRoom, text: content, id };
      await api(`/rooms/${targetRoom}/messages`, {
        id,
        text: content,
        mentions: (mentionsByRoom[draftKey] ?? []).filter((id) =>
          content.split(/\s+/).includes(`@${id}`),
        ),
        ...(continueTask
          ? { intent: "continue", replyToTaskId: latestTask?.id }
          : task?.phase === "waitingHuman"
            ? { intent: "decision", replyToTaskId: task.id }
            : {}),
      });
      sendIdentity.current = null;
      if (!continueTask) {
        setDrafts((previous) => ({
          ...previous,
          [draftKey]: "",
          [targetRoom]: "",
        }));
        setMentionsByRoom((previous) => ({
          ...previous,
          [draftKey]: [],
          [targetRoom]: [],
        }));
      }
      atBottom.current = true;
      void workspace.refreshRooms().catch(() => {
        /* Polling will refresh the room title. */
      });
      textarea.current?.focus();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    if (!roomId || !task || stopping) return;
    setStopping(true);
    try {
      await api(`/rooms/${roomId}/stop`, {
        id: crypto.randomUUID(),
        taskId: task.id,
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setStopping(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (mentionOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (previous) =>
            (previous +
              (event.key === "ArrowDown" ? 1 : -1) +
              mentionCandidates.length) %
            Math.max(1, mentionCandidates.length),
        );
        return;
      }
      if (event.key === "Enter" && mentionCandidates[mentionIndex]) {
        event.preventDefault();
        addMention(mentionCandidates[mentionIndex]);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  const messages = snapshot?.messages ?? [];
  const title =
    snapshot?.room.title ??
    rooms.find((room) => room.id === roomId)?.title ??
    "新的群聊";
  const working = task && !["waitingHuman", "stopping"].includes(task.phase);
  const executing = agents.filter(
    (agent) => agentStatus(agent.id, snapshot, connected) === "执行中",
  );
  return (
    <Tooltip.Provider delay={350}>
      <div className={`workspace ${detailOpen ? "has-details" : ""}`}>
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside
          className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
          aria-label="群聊和成员"
        >
          <div className="sidebar-brand">
            <Logo />
            <span className="version-tag">WORKSPACE</span>
            <IconButton
              className="mobile-close"
              label="收起导航"
              onClick={() => setSidebarOpen(false)}
            >
              <X size={16} />
            </IconButton>
          </div>
          <div className="workspace-name">
            <span className="workspace-initial">S</span>
            <div>
              我的协作空间<small>PERSONAL WORKSPACE</small>
            </div>
            <span className="workspace-dot" />
          </div>
          <Button
            className="new-chat"
            onClick={() => {
              void newRoom();
            }}
            disabled={creating || !connected}
          >
            <Plus size={16} />
            新建群聊<span>⌘ N</span>
          </Button>
          <div className="sidebar-section-title">
            <span>群聊</span>
            <span>{rooms.length.toString().padStart(2, "0")}</span>
          </div>
          <nav className="room-list" aria-label="群聊列表">
            {rooms.length ? (
              rooms.map((room) => (
                <Button
                  key={room.id}
                  className={`room-button ${room.id === roomId ? "selected" : ""}`}
                  onClick={() => chooseRoom(room.id)}
                  aria-current={room.id === roomId ? "page" : undefined}
                >
                  <Hash size={16} />
                  <span>{room.title}</span>
                  {room.id === roomId && <i />}
                </Button>
              ))
            ) : (
              <p className="no-rooms">新建群聊，开始与团队协作</p>
            )}
          </nav>
          <div className="sidebar-section-title members-title">
            <span>团队成员</span>
            <span>{activeAgents.length || "—"}</span>
          </div>
          <div className="agent-list">
            {agents.length ? (
              agents.map((agent) => {
                const status = agentStatus(agent.id, snapshot, connected);
                return (
                  <Button
                    key={agent.id}
                    className={`agent-button ${detailOpen && selectedAgent === agent.id ? "selected" : ""}`}
                    onClick={() => openAgent(agent.id)}
                    aria-label={`查看${agent.name}的执行过程`}
                  >
                    <AgentAvatar agent={agent} small />
                    <span className="agent-button-copy">
                      <strong>{agent.name}</strong>
                      <span>
                        {agent.retired
                          ? "已移除的成员"
                          : agent.id === "A"
                            ? "规划 · 交付"
                            : agent.id === "B"
                              ? "核查 · 验证"
                              : "实现 · 构建"}
                      </span>
                    </span>
                    <span
                      className={`member-dot ${status === "执行中" ? "busy" : ""}`}
                      title={status}
                    />
                    <ChevronRight size={12} className="agent-chevron" />
                  </Button>
                );
              })
            ) : (
              <div className="members-pending">
                <Users size={18} />
                <span>
                  {connected ? "打开群聊后显示团队" : "连接后显示团队"}
                </span>
              </div>
            )}
          </div>
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Radio size={16} />
            </span>
            <p>
              每一位成员，过程可见。
              <br />
              <span>点击 Agent 查看执行记录</span>
            </p>
            <ArrowUpRight size={13} />
          </div>
          <footer className="sidebar-footer">
            <span className="user-avatar">H</span>
            <span>
              我的工作区<small>本地运行</small>
            </span>
            <span
              className={`connection-dot ${connected ? "" : "offline"}`}
              title={connected ? "服务已连接" : "连接中断"}
            />
          </footer>
        </aside>
        <main className="chat-main">
          <header className="chat-header">
            <IconButton
              className="mobile-menu"
              label="打开导航"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </IconButton>
            <div className="chat-title-icon">
              <Hash size={20} />
            </div>
            <div className="chat-title">
              <h1>{title}</h1>
              <span>和你的 Agent 团队一起，把事情做好。</span>
            </div>
            <div className="header-actions">
              <span className="private-label">
                <span className="tiny-dot" />
                本地工作区
              </span>
              <IconButton
                label={detailOpen ? "收起详情" : "查看任务详情"}
                onClick={() => {
                  if (detailOpen && !selectedAgent) setDetailOpen(false);
                  else {
                    setSelectedAgent(null);
                    setDetailOpen(true);
                  }
                }}
              >
                <PanelRight size={18} />
              </IconButton>
            </div>
          </header>
          <div className="team-bar">
            <div className="team-avatar-stack">
              {activeAgents.map((agent) => (
                <Button
                  key={agent.id}
                  className="stack-avatar-button"
                  aria-label={`查看${agent.name}的执行过程`}
                  onClick={() => openAgent(agent.id)}
                >
                  <AgentAvatar agent={agent} small />
                </Button>
              ))}
            </div>
            <span>
              {activeAgents.length
                ? `${activeAgents.length} 位 Agent`
                : "你的 Agent 团队"}
            </span>
            <span className="team-divider" />
            <span className="team-bar-hint">按需协作，各司其职</span>
            <span
              className={`connection-label ${connected ? "" : "disconnected"}`}
            >
              {connected ? (
                <>
                  <span className="tiny-dot" />
                  已连接
                </>
              ) : (
                <>
                  <WifiOff size={12} />
                  连接中断
                </>
              )}
            </span>
          </div>
          {!connected && (
            <div className="offline-banner" role="status">
              <WifiOff size={15} />
              暂时无法连接本地服务，正在重试。执行状态将在重新连接后更新。
            </div>
          )}
          {snapshot && !snapshot.modelConfigured && (
            <div className="config-banner">
              <CircleAlert size={15} />
              <span>
                模型尚未配置。请在项目的 .env 中配置模型服务，然后重启。
              </span>
            </div>
          )}
          <div
            className="chat-scroll"
            ref={chat}
            role="log"
            aria-label="群聊消息"
            aria-live="polite"
            aria-relevant="additions"
            onScroll={() => {
              const el = chat.current;
              if (el) {
                atBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                setShowScrollDown(!atBottom.current);
              }
            }}
          >
            {roomId && !snapshot ? (
              <div className="loading">
                <LoaderCircle className="spin" size={22} />
                <span>正在加载群聊…</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="welcome">
                <div className="welcome-emblem" aria-hidden="true">
                  <span className="emblem-line" />
                  <span className="emblem-node node-a">A</span>
                  <span className="emblem-node node-b">B</span>
                  <span className="emblem-node node-c">⌘</span>
                  <Logo compact />
                </div>
                <div className="welcome-eyebrow">
                  A LITTLE TEAM. A LOT POSSIBLE.
                </div>
                <h2>把想法交给你的团队。</h2>
                <p>
                  说说你想完成什么，让合适的 Agent 接手。
                  <br />
                  从一个问题，到一次完整交付。
                </p>
                <div className="starter-prompts">
                  {[
                    {
                      title: "一起想方案",
                      text: "帮我梳理一个项目的实施方案，列出关键步骤和风险。",
                      icon: <Layers size={17} />,
                      tone: "blue",
                    },
                    {
                      title: "核查一个想法",
                      text: "帮我核查这个方案的可行性，指出假设和需要验证的地方。",
                      icon: <Check size={17} />,
                      tone: "purple",
                    },
                    {
                      title: "着手做点什么",
                      text: "帮我把这个想法拆成可以执行的任务。",
                      icon: <TerminalIcon />,
                      tone: "green",
                    },
                  ].map((prompt) => (
                    <Button
                      className="starter-prompt"
                      key={prompt.title}
                      onClick={() => {
                        setText(prompt.text);
                        textarea.current?.focus();
                      }}
                    >
                      <span className={`prompt-icon ${prompt.tone}`}>
                        {prompt.icon}
                      </span>
                      <strong>{prompt.title}</strong>
                      <ArrowUpRight size={14} />
                    </Button>
                  ))}
                </div>
                <div className="welcome-foot">
                  <AtSign size={12} />
                  点名一位成员，或者直接开始聊天
                </div>
              </div>
            ) : (
              <div className="message-list">
                <div className="conversation-start">
                  <span />
                  {new Intl.DateTimeFormat("zh-CN", {
                    month: "long",
                    day: "numeric",
                  }).format(messages[0]?.at)}
                  <span />
                </div>
                {messages.map((message: Message) => {
                  const agent = agents.find(
                    (agent) => agent.id === message.author,
                  );
                  const isUser = message.kind === "user";
                  return (
                    <article
                      key={message.id}
                      className={`message ${isUser ? "from-user" : ""} ${message.kind === "notice" ? "notice-message" : ""}`}
                    >
                      {isUser ? (
                        <span className="message-user-avatar">H</span>
                      ) : (
                        <Button
                          className="message-avatar-button"
                          aria-label={`查看${agent?.name ?? "协调者"}的执行过程`}
                          onClick={() =>
                            agent
                              ? openAgent(agent.id)
                              : (setSelectedAgent(null), setDetailOpen(true))
                          }
                        >
                          <AgentAvatar
                            agent={
                              agent ?? { id: "facilitator", name: "协调者" }
                            }
                          />
                        </Button>
                      )}
                      <div className="message-content">
                        <div className="message-byline">
                          {isUser ? (
                            <strong>你</strong>
                          ) : (
                            <Button
                              onClick={() =>
                                agent
                                  ? openAgent(agent.id)
                                  : (setSelectedAgent(null),
                                    setDetailOpen(true))
                              }
                              className="author-button"
                            >
                              {agent?.name ?? "协调者"}
                              <span>AGENT</span>
                            </Button>
                          )}
                          <time>{time(message.at)}</time>
                          {message.kind === "final" && (
                            <span className="delivery-label">
                              <Check size={10} />
                              交付
                            </span>
                          )}
                        </div>
                        {message.kind === "help" && (
                          <div className="help-label">
                            请求{" "}
                            {agents.find(
                              (agent) => agent.id === message.recipient,
                            )?.name ?? message.recipient}{" "}
                            协助
                            <ArrowUpRight size={12} />
                          </div>
                        )}
                        <Suspense
                          fallback={
                            <div className="message-text">{message.text}</div>
                          }
                        >
                          <MessageText
                            text={message.text}
                            onAgent={openAgent}
                            agents={agents}
                          />
                        </Suspense>
                        {!isUser && agent && (
                          <Button
                            className="view-process"
                            onClick={() => openAgent(agent.id)}
                          >
                            <Radio size={12} />
                            查看执行过程
                            <ChevronRight size={12} />
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
          {showScrollDown && (
            <Button
              className="scroll-to-bottom"
              aria-label="滚动到最新消息"
              onClick={() => {
                chat.current?.scrollTo({
                  top: chat.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={16} />
            </Button>
          )}
          <div className="composer-area">
            {latestTask && (
              <div className="task-status-row">
                <Button
                  className="task-status-button"
                  onClick={() => {
                    setSelectedAgent(null);
                    setDetailOpen(true);
                  }}
                >
                  <span
                    className={`task-status-icon ${working && connected ? "is-working" : ""}`}
                  >
                    {working && connected ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : latestTask.outcome === "complete" ? (
                      <Check size={13} />
                    ) : (
                      <CircleAlert size={13} />
                    )}
                  </span>
                  <strong>
                    {connected ? phaseLabel(latestTask) : "连接中断"}
                  </strong>
                  <span className="status-summary">
                    {executing.length && connected
                      ? `${executing.map((agent) => agent.name).join("、")}正在工作`
                      : latestTask.goal}
                  </span>
                  <ChevronRight size={12} />
                </Button>
                {task && task.phase !== "stopping" ? (
                  <Button
                    className="stop-button"
                    onClick={() => {
                      void stop();
                    }}
                    disabled={stopping || !connected}
                  >
                    <Square size={9} fill="currentColor" />
                    停止
                  </Button>
                ) : latestTask &&
                  ["waitingHuman", "ended"].includes(latestTask.phase) &&
                  latestTask.outcome !== "complete" ? (
                  <Button
                    className="continue-button"
                    onClick={() => {
                      void send(true);
                    }}
                    disabled={sending || !connected}
                  >
                    继续执行
                    <ArrowUpRight size={12} />
                  </Button>
                ) : null}
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                <CircleAlert size={15} />
                <span>{error}</span>
                <Button
                  className="icon-button"
                  aria-label="关闭错误提示"
                  onClick={() => setError("")}
                >
                  <X size={14} />
                </Button>
              </div>
            )}
            <div className={`composer ${mentionOpen ? "mention-is-open" : ""}`}>
              <textarea
                ref={textarea}
                value={text}
                maxLength={32000}
                onChange={(event) => {
                  setText(event.target.value);
                  const match = /@([\w-]*)$/.test(event.target.value);
                  setMentionOpen(match);
                  setMentionIndex(0);
                }}
                onKeyDown={onKeyDown}
                disabled={!connected || sending}
                placeholder={
                  task
                    ? task.phase === "waitingHuman"
                      ? "回复成员，帮助团队继续…"
                      : "补充当前工作…"
                    : "发送消息，或 @ 点名一位成员…"
                }
                aria-label="群聊消息输入框"
                aria-expanded={mentionOpen}
                aria-controls={mentionOpen ? "mention-list" : undefined}
                aria-activedescendant={
                  mentionOpen
                    ? `mention-${mentionCandidates[mentionIndex]?.id}`
                    : undefined
                }
              />
              <div className="composer-toolbar">
                <Popover.Root
                  open={mentionOpen}
                  onOpenChange={(open) => setMentionOpen(open)}
                >
                  <Popover.Trigger
                    className="mention-trigger"
                    disabled={!activeAgents.length || sending}
                  >
                    <AtSign size={16} />
                    <span>点名成员</span>
                    <ChevronDown size={11} />
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Positioner
                      side="top"
                      align="start"
                      sideOffset={14}
                      className="popover-positioner"
                    >
                      <Popover.Popup
                        className="mention-popup"
                        initialFocus={false}
                      >
                        <div className="popover-label">
                          选择一位成员 <span>↑↓ 选择 · ↵ 确认</span>
                        </div>
                        <div
                          role="listbox"
                          id="mention-list"
                          aria-label="点名成员"
                        >
                          {mentionCandidates.length ? (
                            mentionCandidates.map((agent, index) => (
                              <Button
                                id={`mention-${agent.id}`}
                                key={agent.id}
                                role="option"
                                aria-selected={index === mentionIndex}
                                className={`mention-option ${index === mentionIndex ? "highlighted" : ""}`}
                                onMouseEnter={() => setMentionIndex(index)}
                                onClick={() => addMention(agent)}
                              >
                                <AgentAvatar agent={agent} small />
                                <strong>{agent.name}</strong>
                                <span>@{agent.id}</span>
                              </Button>
                            ))
                          ) : (
                            <p className="no-mention">没有匹配的成员</p>
                          )}
                        </div>
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
                <div className="composer-right">
                  <span className="send-hint">
                    Enter 发送 <span>·</span> Shift + Enter 换行
                  </span>
                  <Button
                    className="send-button"
                    disabled={!text.trim() || sending || !connected}
                    aria-label="发送消息"
                    onClick={() => {
                      void send();
                    }}
                  >
                    {sending ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <ArrowUp size={19} />
                    )}
                  </Button>
                </div>
              </div>
            </div>
            <div className="composer-foot">
              <span>
                <span className="tiny-dot" />
                {working && connected
                  ? "任务执行中，可以随时补充要求"
                  : "共同思考，逐步交付。"}
              </span>
              <span>由你的模型驱动</span>
            </div>
          </div>
        </main>
        {detailOpen && (
          <>
            <div
              className="details-backdrop"
              onClick={() => setDetailOpen(false)}
            />
            <Details
              key={selectedAgent ?? "task"}
              snapshot={snapshot}
              agent={selected}
              connected={connected}
              onClose={() => setDetailOpen(false)}
            />
          </>
        )}
      </div>
    </Tooltip.Provider>
  );
}
function TerminalIcon() {
  return (
    <span className="terminal-prompt" aria-hidden="true">
      &gt;_
    </span>
  );
}
