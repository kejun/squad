import type {
  Artifact,
  BoardEntry,
  Intent,
  InputAnalysis,
  Message,
  Outcome,
  Phase,
  ReviewRound,
} from "../types.js";

export interface WebAgent {
  id: string;
  name: string;
  instructions: string;
  tools: string[];
  model: string | null;
  retired?: boolean;
}
export interface WebRoom {
  id: string;
  title: string;
  createdAt: number;
}
export interface ExecutionEvent {
  id: number;
  taskId: string;
  workId: string;
  agentId: string;
  at: number;
  kind:
    | "started"
    | "request"
    | "tool-start"
    | "tool-result"
    | "output"
    | "error"
    | "cancelled";
  title: string;
  detail: string;
}
export interface WebWork {
  id: string;
  agentId: string;
  taskId: string;
  kind: Intent["kind"];
  status: Intent["status"];
  attempt: number;
  requestCount: number;
  model: string | null;
  reason: string;
  epoch: number;
}
export interface WebTask {
  id: string;
  goal: string;
  owner: string;
  phase: Phase;
  outcome: Outcome | null;
  reason: string;
  usage: { ordinary: number; checks: number };
  limits: { ordinary: number; checks: number };
  artifacts: Artifact[];
  board: BoardEntry[];
  trace: { event: string; detail: string; at: number }[];
  inputAnalyses?: InputAnalysis[];
  review?: Pick<ReviewRound, "targets" | "completed" | "status">;
  assists?: WebAssistance[];
}
export interface WebAssistance {
  id: string;
  taskId: string;
  target: string;
  retryable: boolean;
  reason: string;
}
export interface RoomSnapshot {
  room: WebRoom;
  agents: WebAgent[];
  messages: Message[];
  tasks: WebTask[];
  activeTaskId: string | null;
  works: WebWork[];
  events: ExecutionEvent[];
  modelConfigured: boolean;
  serverTime: number;
}
