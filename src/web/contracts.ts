import type { DeliveryGap } from '../delivery-acceptance.js';
import type {
  Artifact,
  ArtifactSourceMetadata,
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
  archived?: boolean;
  archiveVersion?: number;
  deletion?: WebRoomDeletion;
}
export interface WebRoomDeletion {
  id: string; version: number; status: 'preparing' | 'waiting' | 'deleting' | 'paused';
  reason: string; remaining: string[]; canRetry: boolean;
}
export interface DeletedRoom { roomId: string; deletionVersion: number; status: 'deleted' }
export interface WebBlockerAction {
  id: 'reply' | 'skip' | 'stop' | 'newWindow'; label: string; requiresText?: boolean;
  allowsExtraOrdinary?: boolean; allowsNewWindowMs?: boolean;
}
export interface WebBlocker {
  scope?: 'task' | 'cleanup';
  operation?: { workId: string; operationId: string; approvalId?: string };
  id: string; version: number; taskId: string; epoch: number; goalVersion: number;
  title: string; question: string; requiredHuman: boolean; status: 'open' | 'resolved' | 'skipped'; actions: WebBlockerAction[];
}
export interface WebOperationReview {
  operationId: string; sessionId: string; action: unknown; processState: string;
  receipt: unknown; workspaceRevision: string; files: unknown[]; filesTruncated: boolean; reviewDigest: string;
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
  supervision?: { status: 'running' | 'repairing' | 'waitingHuman' | 'cleaning' | 'faulted' | 'settled'; reason: string; nextWakeAt: number | null; hardDeadlineAt: number | null };
  delivery?: { epoch: number; goalVersion: number; revision: string; status: 'complete' | 'incomplete'; currentArtifactIds: string[]; reportArtifactId?: string };
  id: string;
  goal: string;
  owner: string;
  phase: Phase;
  outcome: Outcome | null;
  reason: string;
  usage: { ordinary: number; checks: number };
  limits: { ordinary: number; checks: number };
  artifacts: Artifact[];
  sourceArtifact?: ArtifactSourceMetadata;
  currentArtifactIds?: string[];
  /** Derived from the current candidate and its saved check result. */
  deliveryGaps?: DeliveryGap[];
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
  blockers?: WebBlocker[];
  deletedRooms?: DeletedRoom[];
  failedSandboxCommands?: WebFailedSandboxCommand[];
  hostApprovals?: WebHostApproval[];
  hostSessions?: { taskId: string; grantId: string; host: string; account: string }[];
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
export interface WebFailedSandboxCommand {
  taskId: string; workId: string; operationId: string; sourceRequestHash: string;
  executable: string; args: string[]; error: string; canRequest: boolean; unavailableReason: string;
  retry?: { id: string; status: 'pending' | 'active' | 'awaitingApproval' | 'running' | 'uncertain' | 'settled' | 'expired' | 'cancelled'; reason?: string; workId?: string; operationId?: string };
}
export interface WebHostApproval {
  taskId: string; workId: string; operationId: string; approvalId: string; expiresAt: number;
  executable: string; args: string[]; cwd: string; host: string; account: string; reason: string;
}
