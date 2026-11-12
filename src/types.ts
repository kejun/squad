import type { HostRetryBatch, HostRetryRequest } from './host-retry.js';
import type { CheckDiagnostic, CheckDiagnosticRecord, CriterionJudgment, DeliveryAcceptance, DeliveryAssessment, DeliveryGap } from './delivery-acceptance.js';
import type { DeliveryEvidenceRef } from './task/evidence.js';
import type { HostSessionGrant } from './host-session.js';
import type { LocalCheckpoint, LocalEvent, LocalOperation, SkillBinding } from './local-operation.js';
import type { SourceItem } from './source-items.js';
import type { InputIntentSpec, MapReducePlan } from './input-intent.js';
import type { ResilienceEvent, ResiliencePolicy, TaskResilience } from './task/resilience.js';
import type { HostAcquisition, AcquisitionEvent, ResourceRequirement, ResourceIdentity } from './resource-acquisition.js';
export type { InputIntentSpec, InputReference } from './input-intent.js';

export interface Bot { id: string; name: string; instructions: string; tools: string[]; model?: string; localTools?: boolean }
export interface ModelService {
  baseUrl: string; model: string; apiKeyEnv?: string;
  jsonMode?: boolean; temperature?: number; maxTokens?: number; contextWindowTokens?: number; maxResponseBytes?: number;
  extraBody?: Record<string, unknown>;
}
export interface ModelConfiguration {
  default: string; facilitator?: string; check?: string; intent?: string; services: Record<string, ModelService>;
}
export interface ModelBinding { serviceId: string; service: ModelService }
export interface Limits {
  ordinary: number; checks: number; assists: number; replans: number; retries: number;
  workTimeoutMs: number; progressIntervalMs: number; repeatThreshold: number;
}
export interface TeamConfig {
  version: string; toolVersion: string; defaultBot: string; bots: Bot[]; limits: Limits;
  skillSearch?: { enabled: boolean };
  localTools?: { enabled: boolean };
  /** Shared read-only web tools; omitted means enabled. Credentials stay in the host environment. */
  webTools?: { enabled: boolean };
  inputAnalysis?: { enabled: boolean };
  resilience?: ResiliencePolicy;
  models?: ModelConfiguration;
}
export const localEnabled = (config: TeamConfig, target: string) => config.localTools?.enabled !== false
  && config.bots.find(bot => bot.id === target)?.localTools !== false;
export interface Fence { epoch: number; goalVersion: number }
export interface Goal { text: string; constraints: string[]; criteria: string[]; requiredArtifacts: number; resourceRequirements?: ResourceRequirement[];
  /** Direct user/host obligations by stable partition id; never inferred authority from model prose. */
  partitionResources?: Record<string, ResourceIdentity[]>;
}
export type Phase = 'interpreting' | 'running' | 'waitingAssistance' | 'coordinating' | 'waitingHuman' | 'checking' | 'stopping' | 'ended';
export type Outcome = 'complete' | 'partial' | 'failed' | 'stopped';
export interface Message {
  id: string; author: string; text: string; kind: 'user' | 'help' | 'answer' | 'notice' | 'final';
  at: number; taskId: string; requestId?: string; recipient?: string; replyTo?: string;
  detailText?: string; artifactIds?: string[]; workId?: string;
}
export interface BoardEntry {
  id: string; revision: number; author: string; text: string;
  kind: 'evidence' | 'hypothesis' | 'opinion' | 'decision' | 'deadEnd';
  sources: string[]; verified: boolean; goalVersion: number;
}
export interface ArtifactDraft { name: string; content: string; replacesArtifactId?: string; sourceItems?: SourceItem[] }
export interface Artifact {
  id: string; name: string; content: string; goalVersion: number; author?: string; workId?: string;
  documentId?: string; revision?: number; replacesArtifactId?: string; sourceItems?: SourceItem[];
}
export interface ArtifactReference { sourceTaskId: string; artifactId: string }
/** Trusted immutable input, separate from current-task artifacts and bounded room history. */
export interface ArtifactSource extends ArtifactReference {
  documentId: string; revision: number; name: string; owner: string; publishedAt: number;
  publicationRevision?: string; content: string; contentHash: string;
}
export type ArtifactSourceMetadata = Omit<ArtifactSource, 'content'>;
export function artifactSourceMetadata(source: ArtifactSource): ArtifactSourceMetadata {
  const { content: _content, ...metadata } = source;
  return metadata;
}
export interface Assistance extends Fence {
  id: string; target: string; question: string; expected: string; refs: string[];
  status: 'pending' | 'running' | 'answered' | 'success' | 'partial' | 'failed' | 'timeout' | 'cancelled';
  resultId?: string; answer?: string; consumed: boolean;
  summary?: string; artifactIds?: string[];
  reviewId?: string;
  requestedBy?: string; requiredTools?: string[]; retryOf?: string;
}
export type WorkKind = 'interpretation' | 'owner' | 'assistance' | 'facilitator' | 'discussionSummary' | 'check' | 'cancel' | 'tool';
export const modelOutputIssues = ['invalid_json', 'invalid_object', 'invalid_type', 'check_passed_boolean', 'check_gaps_strings', 'invalid_work_output', 'invalid_decision', 'invalid_tool_request', 'invalid_input_intent'] as const;
export type ModelOutputIssue = typeof modelOutputIssues[number];
export const toolFailureCodes = ['WEB_TOOL_UNSUPPORTED_RESOURCE', 'WEB_TOOL_CONFIGURATION_UNAVAILABLE', 'WEB_TOOL_UNAVAILABLE',
  'WEB_TOOL_TIMEOUT', 'WEB_TOOL_CONVERSION_FAILED', 'WEB_TOOL_HTTP_ERROR', 'WEB_TOOL_RATE_LIMITED'] as const;
export type ToolFailureCode = typeof toolFailureCodes[number];
export type WebToolKind = 'web_search' | 'web_fetch';
export interface ToolFailureFeedback { tool: WebToolKind; code: ToolFailureCode }
export interface Intent extends Fence {
  hostAcquisitions?: HostAcquisition[];
  id: string; kind: WorkKind; target: string; payload: Record<string, unknown>;
  status: 'pending' | 'inflight' | 'done' | 'cancelled' | 'uncertain';
  replay: 'safe' | 'idempotent' | 'unsafe'; attempt: number; deadline: number | null;
  bucket: 'ordinary' | 'checks' | 'none';
  requestCount: number;
  model?: ModelBinding;
  /** Independent, read-only discussion lane; never a primary assistance dependency. */
  discussionId?: string;
  localOperations?: LocalOperation[];
  localCheckpoint?: LocalCheckpoint;
  localSkills?: SkillBinding[];
  /** Task-local settled evidence selected by the host for this assignment. */
  evidenceRefs?: string[];
  /** Persisted format-repair authorization; never stores the rejected model body. */
  outputRepair?: { count: number; issue: ModelOutputIssue };
  /** The independently checked criteria for this work's fixed candidate revision. */
  criteriaResults?: CriterionJudgment[];
  /** Bounded check failures, retained across recovery without rejected model text. */
  checkDiagnostics?: CheckDiagnosticRecord[];
  /** Known Web failures already returned for an alternative decision; never stores provider text. */
  toolRecovery?: { failures: (ToolFailureFeedback & { requestId: string; attempt: number; at?: number })[] };
}
export interface Reply { ok: boolean; code: string; detail: string }
export interface InputNote { id: string; text: string; applied: boolean }
export type InputAction = InputIntentSpec['action'];
/** Interpretation of direct user input, distinct from an executable Intent. Optional on legacy snapshots. */
export interface InputAnalysis extends Fence {
  id: string; rawText: string; action: InputAction; source: 'rule' | 'model';
  status: 'pending' | 'inflight' | 'resolved' | 'clarification' | 'failed' | 'cancelled';
  spec?: InputIntentSpec; workId?: string; error?: string; decompositionApplied?: boolean;
}
export interface RecordedResult extends Fence { requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string; consumed: boolean; summary?: string; artifactIds?: string[]; workId?: string }
export interface PartitionRecovery { discussionId: string; partitionId: string; sourceOperationIds: string[] }
export interface PartitionResolution extends PartitionRecovery, Fence {
  candidateRevision: string; checkWorkId: string; criterionId: string; owner: string; at: number;
}
export interface Candidate {
  text: string; artifactIds: string[]; goalVersion: number; summary?: string; workId?: string;
  revision?: string; requiresBoundCheck?: boolean; backgroundArtifactIds?: string[]; acceptance?: DeliveryAcceptance;
  deliveryIssue?: { code: string; detail?: string };
  partitionRecoveries?: PartitionRecovery[];
}
export interface DeliveryCycle {
  stage: DeliveryStage;
  requests: number;
  retry?: { workId: string; status: 'reserved' | 'used' };
  revisionUsed: boolean;
  /** Missing on legacy snapshots, whose spent single revision stays spent. */
  revisions?: { used: number; limit: number };
  evidence?: DeliveryEvidenceRef[];
}
export type DeliveryStage =
  | { kind: 'drafting' }
  | { kind: 'candidate'; candidateRevision: string }
  | { kind: 'checking'; candidateRevision: string; checkWorkId: string }
  | { kind: 'revising'; baseRevision: string | null; ownerWorkId: string }
  | { kind: 'published'; candidateRevision: string }
  | { kind: 'incomplete'; candidateRevision: string | null; reason: string };
export interface PublishedDelivery { revision?: string; goalVersion: number; artifactIds: string[]; at: number }
export interface ConversationHistory {
  messages: Message[];
  artifacts: (Artifact & { taskId: string })[];
  board: (BoardEntry & { taskId: string })[];
  tasks?: { taskId: string; goal: Goal; owner: string; outcome: Outcome | null }[];
  truncated: boolean;
}
export interface ReviewRound extends Fence {
  id: string; request: string; targets: string[]; completed: string[];
  status: 'pending' | 'reviewing' | 'summarizing' | 'complete' | 'cancelled';
  question?: string; expected?: string; incomplete?: string;
}
export interface DiscussionRound extends Fence {
  mapReduce?: MapReducePlan & { inputId: string; assignments: { partitionId: string; target: string; workId?: string; attempt?: number }[];
    scheduling?: import('./task/map-scheduling.js').MapSchedulingState;
    concurrency?: number; queue?: MapPartitionRun[] };
  id: string; request: string; targets: string[];
  status: 'planning' | 'collecting' | 'summarizing' | 'ready' | 'delivered' | 'cancelled';
  skipped: { target: string; reason: string }[];
  results: { target: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string; artifactIds: string[];
    reportedStatus?: 'success' | 'partial' | 'failed' | 'timeout'; missingResources?: ResourceIdentity[]; sourceOperationIds?: string[];
    resourceSources?: { acquisitionId: string; operationId: string; workId: string; attempt: number; at: number; reused: boolean }[];
    id?: string; partitionId?: string; attempt?: number; workId?: string }[];
  question?: string; expected?: string; summary?: string; incomplete?: string;
}
export interface MapPartitionRun {
  partitionId: string; attempt: number; deadline: number;
  status: 'queued' | 'running' | 'uncertain' | 'succeeded' | 'partial' | 'failed' | 'timeout' | 'cancelled';
  workId?: string; target?: string; resultRef?: string; reason?: string;
  /** A later, independently checked recovery; the original attempt status stays unchanged. */
  resolution?: PartitionResolution;
}
export interface TaskContext extends Fence {
  /** Persisted supervision; absent only on pre-supervision snapshots. */
  resilience?: TaskResilience;
  schemaVersion: 1; taskId: string; owner: string; config: TeamConfig; goal: Goal;
  messages: Message[]; board: BoardEntry[]; boardHistory: BoardEntry[]; artifacts: Artifact[]; assists: Assistance[];
  intents: Intent[]; trace: { event: string; detail: string; at: number }[];
  inputs: InputNote[]; consumedResults: string[]; processedSignals: string[]; progressRefs: string[];
  lateResults: TaskEvent[];
  results: RecordedResult[];
  usage: { ordinary: number; checks: number; assists: number; replans: number; retries: number };
  /** Read compatibility for snapshots written before bounded checking. */
  deliveryGaps?: DeliveryGap[]; deliveryAssessments?: DeliveryAssessment[];
  deliveryCycle?: DeliveryCycle;
  candidate: Candidate | null; publishedDelivery?: PublishedDelivery; outcome: Outcome | null; reason: string;
  stopped: boolean; nextSeq: number; lastActivityAt: number; lastProgressAt: number;
  nextCheckAt: number; repeat: { fingerprint: string; count: number };
  deferredCoordination: boolean; reply: Reply;
  history?: ConversationHistory;
  sourceArtifact?: ArtifactSource;
  review?: ReviewRound;
  discussion?: DiscussionRound;
  inputAnalyses?: InputAnalysis[];
  localSkillVersions?: SkillBinding[];
  hostSession?: HostSessionGrant | undefined;
  hostRetryRequests?: HostRetryRequest[];
  hostRetryBatch?: HostRetryBatch | undefined;
}
export interface TaskInput { taskId: string; owner: string; config: TeamConfig; goal: Goal; at: number; message: Message; history?: ConversationHistory; reviewTargets?: string[]; sourceArtifact?: ArtifactSource }
export interface Envelope { id: string; at: number; fence?: Fence; workId?: string; attempt?: number }
export type Decision =
  | { action: 'continue'; reason: string }
  | { action: 'assist'; target: string; question: string; expected: string; reason: string }
  | { action: 'review'; question: string; expected: string; reason: string }
  | { action: 'replan'; plan: string; reason: string }
  | { action: 'askUser'; question: string; reason: string }
  | { action: 'finish'; reason: string };
export type TaskEvent = Envelope & (
  | AcquisitionEvent
  | ResilienceEvent
  | { type: 'REVOKE_HOST_SESSION'; grantId: string }
  | { type: 'HOST_RETRY_EXPIRE' }
  | { type: 'HOST_RETRY_RECONCILE' }
  | { type: 'REQUEST_HOST_RETRY'; sourceWorkId: string; sourceOperationId: string; sourceRequestHash: string; requestHash: string; currentConfig?: TeamConfig }
  | LocalEvent
  | { type: 'DISCUSSION_PLAN'; discussionId: string; decision: Decision }
  | { type: 'DISCUSSION_RESULT'; discussionId: string; text: string; status: 'success' | 'partial' | 'failed'; summary?: string; artifacts?: ArtifactDraft[] }
  | { type: 'DISCUSSION_HANDOFF' }
  | { type: 'INTERPRETATION_RESULT'; inputId: string; spec: InputIntentSpec }
  | { type: 'REGENERATE_MODEL_OUTPUT'; intentId: string; issue: ModelOutputIssue }
  | { type: 'RECORD_TOOL_FAILURE'; intentId: string; requestId: string; tool: WebToolKind; code: ToolFailureCode }
  | { type: 'HELP'; requestId: string; caller: string; target: string; question: string; expected: string; refs?: string[]; requiredTools?: string[] }
  | { type: 'HELP_RESULT'; requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string; summary?: string; artifactIds?: string[] }
  | { type: 'RECORD_RESULT'; requestId: string; resultId: string; status: 'success' | 'partial' | 'failed' | 'timeout'; answer: string; summary?: string; artifacts?: ArtifactDraft[] }
  | { type: 'RETRY_ASSISTANCE'; requestId: string; text: string; config?: TeamConfig }
  | { type: 'BLOCKED'; reason: string }
  | { type: 'COORDINATE'; decision: Decision }
  | { type: 'USER_INPUT'; text: string; goal?: Goal; decision?: boolean; history?: ConversationHistory; reviewTargets?: string[] }
  | { type: 'HUMAN_DECISION'; text: string; history?: ConversationHistory; reviewTargets?: string[] }
  | { type: 'BOUNDARY' }
  | { type: 'HANDOFF'; owner: string }
  | { type: 'WAIT_USER'; question: string }
  | { type: 'DELIVER'; text: string; artifactIds: string[]; backgroundArtifactIds?: string[]; summary?: string; artifacts?: ArtifactDraft[]; partitionRecoveries?: PartitionRecovery[] }
  | { type: 'CHECK_RESULT'; resultId: string; candidateRevision?: string; criteriaResults?: CriterionJudgment[]; passed?: boolean; gaps?: string[] }
  | { type: 'STOP'; text?: string }
  | { type: 'SETTLE'; intentId: string }
  | { type: 'CONTINUE'; extraOrdinary?: number; text?: string; currentConfig?: TeamConfig; newWindowMs?: number }
  | { type: 'TICK' }
  | { type: 'ACTIVITY'; text: string }
  | { type: 'PROGRESS'; detail: string; refs: string[] }
  | { type: 'FAILURE_SIGNAL'; operation: string; parameters: string; resource: string; error: string; result: string }
  | { type: 'BOARD_WRITE'; author: string; entryId: string; baseRevision?: number; text: string; kind: BoardEntry['kind']; sources: string[] }
  | { type: 'ARTIFACT'; artifact: Omit<Artifact, 'goalVersion' | 'documentId' | 'revision' | 'replacesArtifactId'> }
  | { type: 'CLAIM'; intentId: string }
  /** Host-only actor protocol; public command and sandbox adapters must not authorize it. */
  | { type: 'EXECUTION_START'; intentId: string; attempt: number }
  | { type: 'EXECUTION_RECONCILE' }
  | { type: 'CONSUME'; intentId: string; capability?: 'web_search' | 'web_fetch' }
  | { type: 'WORK_FAILED'; intentId: string; reason: string; transient: boolean; code?: string; resultUncertain?: boolean; checkDiagnostic?: CheckDiagnostic }
  | { type: 'RECOVER'; config: TeamConfig }
  | { type: 'EXHAUSTED'; reason: string }
  | { type: 'RECONCILE'; intentId: string; resolution: 'confirmed' | 'notExecuted'; detail: string }
  | { type: 'TOOL'; tool: string; replay: Intent['replay']; payload: Record<string, unknown> }
);

export function validateConfig(config: TeamConfig): void {
  if (!config.version || !config.toolVersion || !config.bots.length) throw new Error('Invalid team configuration');
  if (config.skillSearch !== undefined && (!config.skillSearch || typeof config.skillSearch.enabled !== 'boolean')) throw new Error('Invalid skill search configuration');
  if (config.webTools !== undefined && (!config.webTools || typeof config.webTools.enabled !== 'boolean')) throw new Error('Invalid web tools configuration');
  if (config.inputAnalysis !== undefined && (!config.inputAnalysis || typeof config.inputAnalysis.enabled !== 'boolean')) throw new Error('Invalid input analysis configuration');
  if (config.localTools !== undefined && typeof config.localTools.enabled !== 'boolean') throw new Error('Invalid local tools configuration');
  if (config.resilience !== undefined) {
    if (!config.resilience || typeof config.resilience !== 'object') throw new Error('Invalid resilience configuration');
    for (const key of ['automaticTimeoutMs', 'repairTimeoutMs', 'cancelGraceMs', 'repairLimit'] as const) {
      const value = config.resilience[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === 'repairLimit' ? 0 : 1))) throw new Error(`Invalid resilience limit: ${key}`);
    }
    if (config.resilience.allowMissingContent !== undefined && typeof config.resilience.allowMissingContent !== 'boolean') throw new Error('Invalid missing-content policy');
  }
  if (config.bots.some(b => b.localTools !== undefined && typeof b.localTools !== 'boolean')) throw new Error('Invalid bot local tools configuration');
  validateModels(config);
  const ids = config.bots.map(b => b.id);
  if (ids.some(id => !id || id === 'user' || id === 'facilitator') || new Set(ids).size !== ids.length || !ids.includes(config.defaultBot)) throw new Error('Invalid bot identities');
  for (const key of ['ordinary', 'checks', 'assists', 'replans', 'retries', 'workTimeoutMs', 'progressIntervalMs', 'repeatThreshold'] as const) {
    const value = config.limits[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Missing finite limit: ${key}`);
  }
  if (config.limits.workTimeoutMs === 0 || config.limits.progressIntervalMs === 0 || config.limits.repeatThreshold === 0) throw new Error('Deadlines and repeat threshold must be positive');
}

export function validateModels(config: TeamConfig): void {
  const models = config.models;
  if (!models) {
    if (config.bots.some(bot => bot.model !== undefined)) throw new Error('Model services are not configured');
    return;
  }
  if (!models.services || typeof models.services !== 'object' || Array.isArray(models.services)) throw new Error('Invalid model services');
  for (const id of [models.default, models.facilitator ?? models.default, models.check ?? models.facilitator ?? models.default, models.intent ?? models.facilitator ?? models.default, ...config.bots.map(bot => bot.model ?? models.default)]) {
    if (typeof id !== 'string' || !Object.hasOwn(models.services, id)) throw new Error('Unknown model service');
  }
  for (const [id, service] of Object.entries(models.services)) {
    if (!id.trim() || !service || typeof service.baseUrl !== 'string' || typeof service.model !== 'string' || !service.model.trim()) throw new Error('Invalid model service');
    let url: URL;
    try { url = new URL(service.baseUrl); } catch { throw new Error('Invalid model base URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid model base URL');
    if (service.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(service.apiKeyEnv)) throw new Error('Invalid API key environment variable');
    if (service.jsonMode !== undefined && typeof service.jsonMode !== 'boolean') throw new Error('Invalid model JSON mode');
    if (service.temperature !== undefined && (!Number.isFinite(service.temperature) || service.temperature < 0 || service.temperature > 2)) throw new Error('Invalid model temperature');
    if (service.maxTokens !== undefined && (!Number.isSafeInteger(service.maxTokens) || service.maxTokens <= 0)) throw new Error('Invalid model token limit');
    if (service.maxResponseBytes !== undefined && (!Number.isSafeInteger(service.maxResponseBytes) || service.maxResponseBytes <= 0)) throw new Error('Invalid model response byte limit');
    if (service.contextWindowTokens !== undefined && (!Number.isSafeInteger(service.contextWindowTokens) || service.contextWindowTokens <= 0)) throw new Error('Invalid model context window');
    if (service.extraBody !== undefined) {
      if (!service.extraBody || typeof service.extraBody !== 'object' || Array.isArray(service.extraBody)) throw new Error('Invalid extra model parameters');
      const reserved = ['model', 'messages', 'stream', 'response_format', 'tools', 'tool_choice', 'n', 'api_key', 'apiKey'];
      if (reserved.some(key => Object.hasOwn(service.extraBody!, key))) throw new Error('Reserved model parameter');
      const checkValue = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(checkValue))
        || (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(checkValue));
      if (!checkValue(service.extraBody)) throw new Error('Model parameters must be JSON values');
    }
  }
}
