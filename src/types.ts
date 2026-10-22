export interface Bot { id: string; name: string; instructions: string; tools: string[] }
export interface Limits {
  ordinary: number; checks: number; assists: number; replans: number; retries: number;
  workTimeoutMs: number; progressIntervalMs: number; repeatThreshold: number;
}
export interface TeamConfig {
  version: string; toolVersion: string; defaultBot: string; bots: Bot[]; limits: Limits;
}
export interface Fence { epoch: number; goalVersion: number }
export interface Goal { text: string; constraints: string[]; criteria: string[]; requiredArtifacts: number }
export type Phase = 'running' | 'waitingAssistance' | 'coordinating' | 'waitingHuman' | 'checking' | 'stopping' | 'ended';
export type Outcome = 'complete' | 'partial' | 'failed' | 'stopped';
export interface Message {
  id: string; author: string; text: string; kind: 'user' | 'help' | 'answer' | 'notice' | 'final';
  at: number; taskId: string; requestId?: string; recipient?: string; replyTo?: string;
}
export interface BoardEntry {
  id: string; revision: number; author: string; text: string;
  kind: 'evidence' | 'hypothesis' | 'opinion' | 'decision' | 'deadEnd';
  sources: string[]; verified: boolean; goalVersion: number;
}
export interface Artifact { id: string; name: string; content: string; goalVersion: number }
export interface Assistance extends Fence {
  id: string; target: string; question: string; expected: string; refs: string[];
  status: 'pending' | 'running' | 'answered' | 'success' | 'partial' | 'failed' | 'timeout' | 'cancelled';
  resultId?: string; answer?: string; consumed: boolean;
}
export type WorkKind = 'owner' | 'assistance' | 'facilitator' | 'check' | 'cancel' | 'tool';
export interface Intent extends Fence {
  id: string; kind: WorkKind; target: string; payload: Record<string, unknown>;
  status: 'pending' | 'inflight' | 'done' | 'cancelled' | 'uncertain';
  replay: 'safe' | 'idempotent' | 'unsafe'; attempt: number; deadline: number | null;
  bucket: 'ordinary' | 'checks' | 'none';
  requestCount: number;
}
export interface Reply { ok: boolean; code: string; detail: string }
export interface InputNote { id: string; text: string; applied: boolean }
export interface RecordedResult extends Fence { requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string; consumed: boolean }
export interface Candidate { text: string; artifactIds: string[]; goalVersion: number }
export interface TaskContext extends Fence {
  schemaVersion: 1; taskId: string; owner: string; config: TeamConfig; goal: Goal;
  messages: Message[]; board: BoardEntry[]; boardHistory: BoardEntry[]; artifacts: Artifact[]; assists: Assistance[];
  intents: Intent[]; trace: { event: string; detail: string; at: number }[];
  inputs: InputNote[]; consumedResults: string[]; processedSignals: string[]; progressRefs: string[];
  lateResults: TaskEvent[];
  results: RecordedResult[];
  usage: { ordinary: number; checks: number; assists: number; replans: number; retries: number };
  candidate: Candidate | null; outcome: Outcome | null; reason: string;
  stopped: boolean; nextSeq: number; lastActivityAt: number; lastProgressAt: number;
  nextCheckAt: number; repeat: { fingerprint: string; count: number };
  deferredCoordination: boolean; reply: Reply;
}
export interface TaskInput { taskId: string; owner: string; config: TeamConfig; goal: Goal; at: number; message: Message }
export interface Envelope { id: string; at: number; fence?: Fence; workId?: string }
export type Decision =
  | { action: 'continue'; reason: string }
  | { action: 'assist'; target: string; question: string; expected: string; reason: string }
  | { action: 'replan'; plan: string; reason: string }
  | { action: 'askUser'; question: string; reason: string }
  | { action: 'finish'; reason: string };
export type TaskEvent = Envelope & (
  | { type: 'HELP'; requestId: string; caller: string; target: string; question: string; expected: string; refs?: string[]; requiredTools?: string[] }
  | { type: 'HELP_RESULT'; requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string }
  | { type: 'RECORD_RESULT'; requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string }
  | { type: 'BLOCKED'; reason: string }
  | { type: 'COORDINATE'; decision: Decision }
  | { type: 'USER_INPUT'; text: string; goal?: Goal; decision?: boolean }
  | { type: 'HUMAN_DECISION'; text: string }
  | { type: 'BOUNDARY' }
  | { type: 'HANDOFF'; owner: string }
  | { type: 'WAIT_USER'; question: string }
  | { type: 'DELIVER'; text: string; artifactIds: string[] }
  | { type: 'CHECK_RESULT'; passed: boolean; gaps: string[]; resultId: string }
  | { type: 'STOP' }
  | { type: 'SETTLE'; intentId: string }
  | { type: 'CONTINUE'; extraOrdinary?: number }
  | { type: 'TICK' }
  | { type: 'ACTIVITY'; text: string }
  | { type: 'PROGRESS'; detail: string; refs: string[] }
  | { type: 'FAILURE_SIGNAL'; operation: string; parameters: string; resource: string; error: string; result: string }
  | { type: 'BOARD_WRITE'; author: string; entryId: string; baseRevision?: number; text: string; kind: BoardEntry['kind']; sources: string[] }
  | { type: 'ARTIFACT'; artifact: Omit<Artifact, 'goalVersion'> }
  | { type: 'CLAIM'; intentId: string }
  | { type: 'CONSUME'; intentId: string }
  | { type: 'WORK_FAILED'; intentId: string; reason: string; transient: boolean; resultUncertain?: boolean }
  | { type: 'RECOVER'; config: TeamConfig }
  | { type: 'EXHAUSTED'; reason: string }
  | { type: 'RECONCILE'; intentId: string; resolution: 'confirmed' | 'notExecuted'; detail: string }
  | { type: 'TOOL'; tool: string; replay: Intent['replay']; payload: Record<string, unknown> }
);

export function validateConfig(config: TeamConfig): void {
  if (!config.version || !config.toolVersion || !config.bots.length) throw new Error('Invalid team configuration');
  const ids = config.bots.map(b => b.id);
  if (ids.some(id => !id || id === 'user' || id === 'facilitator') || new Set(ids).size !== ids.length || !ids.includes(config.defaultBot)) throw new Error('Invalid bot identities');
  for (const key of ['ordinary', 'checks', 'assists', 'replans', 'retries', 'workTimeoutMs', 'progressIntervalMs', 'repeatThreshold'] as const) {
    const value = config.limits[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing finite limit: ${key}`);
  }
  if (config.limits.workTimeoutMs === 0 || config.limits.progressIntervalMs === 0 || config.limits.repeatThreshold === 0) throw new Error('Deadlines and repeat threshold must be positive');
}
