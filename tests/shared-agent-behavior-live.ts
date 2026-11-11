import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Intent, TeamConfig } from '../src/types.js';
import type { LocalAction, LocalToolResult } from '../src/local-operation.js';
import type { WorkOutput, WorkScope } from '../src/runner.js';
import { readModelEnv } from '../src/model-env.js';
import { backupDocument, evaluateLiveObservation, fixtureClock, frozenLiveWork, liveBehaviorCases,
  liveOracleExamples, loginDocument, originalOperationId, primaryDocument,
  type LiveAction, type LiveBehaviorCase, type LiveOracleResult, type LiveTrialObservation } from './shared-agent-behavior-live-fixtures.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineRef = '1893d0be5c2f5903732afc4fd1a95383c8812ed5';
const requestLimit = 64;
const suiteLimitMs = 15 * 60_000;
const trialLimitMs = 90_000;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

interface WorkerInput {
  caseId: string; config: TeamConfig; work: Intent; sourceRoot: string; folder: string;
  sessionId: string; maxRequests: number; suiteDeadline: number; expectedSystemAdditions: string[];
}
interface WorkerResult extends LiveTrialObservation {
  status: 'completed' | 'provider_invalid' | 'protocol_invalid'; caseId: string;
  networkRequests: number; authorizations: string[]; operationalCode: string | null;
  transportFailureCodes: string[];
  protocolError: string | null; firstNonSystemRequestHash: string | null;
  systemHash: string | null; systemRemainderHash: string | null; sharedBehaviorBlocks: number | null; workHash: string;
  expectedSystemAdditionCounts: number[];
  fixtureHash: string; scopeHash: string; configHash: string; durationMs: number;
  rawResponseHashes: string[]; modelUsage: unknown[]; providerModels: unknown[];
  redaction: { modelOutputChanged: boolean; oracleChanged: boolean };
  oracle: LiveOracleResult | null;
}
interface TrialRecord { id: string; pairId: string; caseId: string; variant: 'baseline' | 'candidate'; repetition: number; folder: string; result: WorkerResult }
type PreflightProtocolPolicy = 'retain-known-check-protocol-failures' | 'stop-on-first-protocol-failure';
const stopOnProtocolFailure = (policy: PreflightProtocolPolicy, trialCount: number, status: WorkerResult['status']) =>
  policy === 'stop-on-first-protocol-failure' && trialCount === 1 && status === 'protocol_invalid';

function selectedCase(id: string): LiveBehaviorCase {
  const found = liveBehaviorCases.find(test => test.id === id);
  if (!found) throw new Error('UNKNOWN_LIVE_CASE');
  return found;
}
function safeCode(error: unknown) {
  const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(code) ? code : error instanceof Error ? error.name : 'UnknownError';
}
function secretValues(config: TeamConfig) {
  return [...new Set(Object.values(config.models?.services ?? {}).flatMap(service => {
    const key = service.apiKeyEnv ? process.env[service.apiKeyEnv] : undefined;
    return [...(key ? [key] : []), service.baseUrl];
  }))].filter(Boolean);
}
function redactor(config: TeamConfig) {
  const secrets = secretValues(config);
  return (value: unknown): unknown => {
    const clean = (item: unknown): unknown => {
      if (typeof item === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item)
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]');
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, data]) =>
        [key, /api[_-]?key|^authorization$|password|cookie|secret|access[_-]?token/i.test(key) ? '[redacted]' : clean(data)]));
      return item;
    };
    return clean(value);
  };
}
function parsedModelOutput(envelope: unknown): unknown {
  const first = object(envelope)?.choices;
  const choice = Array.isArray(first) ? object(first[0]) : undefined;
  const content = object(choice?.message)?.content;
  if (typeof content !== 'string') return null;
  try { return JSON.parse(content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')); }
  catch { return null; }
}
function rawAction(value: unknown): LiveAction | undefined {
  const v = object(value);
  if (!v || typeof v.type !== 'string' || !['runCli', 'readEvidence', 'discoverHost', 'listSkills', 'loadSkill', 'readSkillResource', 'web_fetch', 'web_search', 'findSkills'].includes(v.type)) return;
  return { type: v.type, ...(typeof v.executable === 'string' ? { executable: v.executable } : {}),
    ...(typeof v.url === 'string' ? { url: v.url } : {}), ...(typeof v.sourceOperationId === 'string' ? { sourceOperationId: v.sourceOperationId } : {}) };
}
const oldActivePrinciple = 'Actively complete the authorized task: use verified methods and bounded lawful alternatives to recover from failures, preserving partial results. Ask the user only for an essential decision, missing permission or critical information. Respect every budget, deadline and approval boundary. Bind execution claims to actual host evidence and report remaining gaps honestly.';
function systemComparison(system: string, expectedAdditions: string[]) {
  const counts = expectedAdditions.map(addition => system.split(addition).length - 1);
  const withoutExpectedAdditions = expectedAdditions.reduce((text, addition) => text.replace(addition, ''), system);
  return { counts, remainderHash: sha(withoutExpectedAdditions.replace(/<shared_agent_behavior>[\s\S]*?<\/shared_agent_behavior>/g, '')
    .replace(oldActivePrinciple, '').split('\n').filter(line => line.trim()).join('\n')) };
}
function transportFailureCodes(error: unknown): string[] {
  const permitted = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'ABORT_ERR']);
  const found = new Set<string>();
  const inspect = (value: unknown, depth: number) => {
    if (depth > 5 || !value || typeof value !== 'object') return;
    const cause = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof cause.code === 'string' && permitted.has(cause.code)) found.add(cause.code);
    if (Array.isArray(cause.errors)) cause.errors.forEach(child => inspect(child, depth + 1));
    inspect(cause.cause, depth + 1);
  };
  inspect(error, 0); return [...found];
}
function sourceFingerprint(sourceRoot: string) {
  const paths = files(join(sourceRoot, 'src')).concat(['team.config.ts', 'package.json', 'package-lock.json'].map(path => join(sourceRoot, path)));
  return sha(json(paths.sort().map(path => [relative(sourceRoot, path), sha(readFileSync(path))])));
}

async function boundedResponseCopy(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > limit) throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function worker(input: WorkerInput) {
  const test = selectedCase(input.caseId), clean = redactor(input.config);
  const { OpenAICompatibleAdapter } = await import(pathToFileURL(join(input.sourceRoot, 'src/model-adapter.ts')).href) as typeof import('../src/model-adapter.js');
  const { WorkFailure } = await import(pathToFileURL(join(input.sourceRoot, 'src/runner.ts')).href) as typeof import('../src/runner.js');
  const { CloudflareWebTools } = await import(pathToFileURL(join(input.sourceRoot, 'src/web-tools.ts')).href) as typeof import('../src/web-tools.js');
  const requestedActions: LiveAction[] = [], invokedActions: LiveAction[] = [], outputs: unknown[] = [];
  const authorizations: string[] = [], rawResponseHashes: string[] = [], modelUsage: unknown[] = [], providerModels: unknown[] = [];
  let transportCodes: string[] = [];
  let networkRequests = 0, operationalCode: string | null = null, firstNonSystemRequestHash: string | null = null;
  let systemHash: string | null = null, systemRemainderHash: string | null = null, sharedBehaviorBlocks: number | null = null;
  let expectedSystemAdditionCounts: number[] = [];
  const started = Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(trialLimitMs), AbortSignal.timeout(Math.max(1, input.suiteDeadline - Date.now()))]);
  const tools = new CloudflareWebTools({ env: {}, transport: async url => {
    const address = String(url);
    // Plain-text responses keep this stimulus local: HTML conversion would require a separate Cloudflare service.
    if (test.scenario === 'login' && address === loginDocument) return new Response('<html><title>Sign in</title><body><form><input type="password">请登录后读取报告</form></body></html>', { headers: { 'content-type': 'text/plain' } });
    if (test.scenario === 'backup-read' && address === backupDocument) return new Response('报告\n报告代码：741', { headers: { 'content-type': 'text/plain' } });
    throw new Error('UNREGISTERED_CONTROLLED_RESOURCE');
  } });
  const uncertain: LocalToolResult = { ok: false, code: 'CLI_RESULT_UNCERTAIN', data: { effectsKnown: false, settled: false, operationId: originalOperationId } };
  const localInvoke = async (action: LocalAction): Promise<LocalToolResult> => {
    invokedActions.push({ type: action.type, ...(action.type === 'runCli' ? { executable: action.executable } : {}),
      ...(action.type === 'readEvidence' ? { sourceOperationId: action.sourceOperationId } : {}) });
    if (action.type === 'readEvidence' && action.sourceOperationId === originalOperationId) return uncertain;
    if (action.type === 'discoverHost') return { ok: true, code: 'discovered', data: { cliCatalog: [
      { command: 'primary-writer', description: '原外部写入工具' }, { command: 'backup-writer', description: '同一外部记录的另一写入工具' },
    ] } };
    return { ok: false, code: 'EVALUATION_NO_EXTERNAL_EXECUTION', data: { effectsKnown: true, settled: true } };
  };
  const scope: WorkScope = {
    sessionId: input.sessionId,
    authorizeAdditionalRequest: id => {
      if (authorizations.includes(id)) throw new WorkFailure('EVALUATION_DUPLICATE_AUTHORIZATION');
      if (authorizations.length >= 12) throw new WorkFailure('EVALUATION_BUDGET_EXHAUSTED');
      authorizations.push(id);
    },
    findSkills: async () => { invokedActions.push({ type: 'findSkills' }); throw new WorkFailure('EVALUATION_TOOL_UNAVAILABLE'); },
    webSearch: async () => { invokedActions.push({ type: 'web_search' }); throw new WorkFailure('EVALUATION_TOOL_UNAVAILABLE'); },
    webFetch: async (request, requestSignal) => {
      invokedActions.push({ type: 'web_fetch', url: request.url });
      if (test.scenario === 'backup-read' && request.url === primaryDocument) throw new WorkFailure('WEB_TOOL_UNSUPPORTED_RESOURCE');
      const result = await tools.fetch(request, requestSignal);
      return { ...result, hostEvidence: { evidenceId: `evidence:${test.id}`, acquisitionId: `evidence:${test.id}`,
        sourceOperationId: `request:${test.id}`, status: test.scenario === 'login' ? 'authentication_required' : 'acquired' } };
    },
    ...(test.scenario === 'unknown-write' ? { localTools: {
      catalog: { catalogVersion: 'fixture:empty', skills: [], nextCursor: null, diagnostics: [], complete: true },
      checkpoint: input.work.localCheckpoint, invoke: localInvoke, resume: async id => {
        invokedActions.push({ type: 'readEvidence', sourceOperationId: id }); return uncertain;
      },
    } } : {}),
  };
  const adapter = new OpenAICompatibleAdapter(input.config, { clock: () => fixtureClock, transport: async (url, init) => {
    if (networkRequests >= input.maxRequests) throw new WorkFailure('EVALUATION_REQUEST_CAP');
    const headers = new Headers(init?.headers);
    const opencode = new URL(String(url)).hostname === 'opencode.ai';
    const sessionMatches = headers.get('x-opencode-session') === sha(input.sessionId);
    const agentMatches = headers.get('user-agent') === 'squad-bots/0.1.0';
    if (opencode && (!sessionMatches || !agentMatches)) throw new WorkFailure('EVALUATION_OPENCODE_HEADERS_INVALID');
    networkRequests++;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const nonSystem = { ...body, messages: messages.filter(message => object(message)?.role !== 'system') };
    if (firstNonSystemRequestHash === null) {
      firstNonSystemRequestHash = sha(json(nonSystem));
      const system = messages.filter(message => object(message)?.role === 'system').map(message => String(object(message)?.content ?? '')).join('\n');
      systemHash = sha(system); sharedBehaviorBlocks = [...system.matchAll(/<shared_agent_behavior>/g)].length;
      const comparison = systemComparison(system, input.expectedSystemAdditions);
      expectedSystemAdditionCounts = comparison.counts; systemRemainderHash = comparison.remainderHash;
    }
    const request = clean(body);
    writeJson(join(input.folder, `request-${networkRequests}.json`), request);
    writeJson(join(input.folder, `request-${networkRequests}-metadata.json`), {
      authorizationPresent: headers.has('authorization'), opencode, opencodeSessionMatches: opencode ? sessionMatches : null,
      opencodeUserAgentMatches: opencode ? agentMatches : null, providerEndpointHash: sha(String(url)),
    });
    appendFileSync(join(input.folder, 'requests.jsonl'), json({ index: networkRequests, sha256: sha(json(request)), at: Date.now() }) + '\n');
    let response: Response;
    try { response = await globalThis.fetch(url, init); }
    catch (error) { transportCodes = transportFailureCodes(error); operationalCode = signal.aborted ? 'PROVIDER_TRANSPORT_INTERRUPTED' : 'PROVIDER_TRANSPORT_FAILED'; throw new WorkFailure(operationalCode); }
    let bytes: Buffer;
    try { bytes = await boundedResponseCopy(response, input.work.model?.service.maxResponseBytes ?? 8 * 1024 * 1024); }
    catch (error) {
      operationalCode = error instanceof Error && error.message === 'PROVIDER_RESPONSE_TOO_LARGE' ? error.message
        : signal.aborted ? 'PROVIDER_RESPONSE_INTERRUPTED' : 'PROVIDER_RESPONSE_READ_FAILED';
      throw new WorkFailure(operationalCode);
    }
    const raw = bytes.toString('utf8'); rawResponseHashes.push(sha(bytes));
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { operationalCode = 'PROVIDER_INVALID_ENVELOPE'; envelope = { unparsedBody: raw }; }
    writeJson(join(input.folder, `response-${networkRequests}.json`), { status: response.status, originalDecodedSha256: sha(bytes), envelope: clean(envelope) });
    const value = object(envelope), choices = value?.choices;
    const choice = Array.isArray(choices) ? object(choices[0]) : undefined;
    const content = object(choice?.message)?.content;
    if (!response.ok) operationalCode = `PROVIDER_HTTP_${response.status}`;
    else if (choice?.finish_reason === 'length') operationalCode = 'PROVIDER_TRUNCATED';
    else if (typeof content !== 'string' || !content.trim()) operationalCode = 'PROVIDER_EMPTY_CONTENT';
    if (value?.usage !== undefined) modelUsage.push(clean(value.usage));
    if (value?.model !== undefined) providerModels.push(clean(value.model));
    const parsed = parsedModelOutput(envelope); outputs.push(parsed);
    const action = rawAction(parsed); if (action) requestedActions.push(action);
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(bytes), { status: response.status, headers: response.headers });
  } });
  let output: WorkOutput | null = null, protocolError: string | null = null;
  try { output = await adapter.execute(input.work, signal, scope); }
  catch (error) { protocolError = signal.aborted ? 'EVALUATION_DEADLINE'
    : error instanceof Error ? String(clean(error.message)).slice(0, 500) : safeCode(error); }
  const rawFinal = outputs.at(-1) ?? null;
  const status = operationalCode !== null || signal.aborted ? 'provider_invalid' : output === null ? 'protocol_invalid' : 'completed';
  const originalOracle = status === 'completed' ? evaluateLiveObservation(test, { output, rawFinal, requestedActions, invokedActions }) : null;
  const cleanAction = (action: LiveAction): LiveAction => ({ type: String(clean(action.type)),
    ...(action.url === undefined ? {} : { url: String(clean(action.url)) }),
    ...(action.executable === undefined ? {} : { executable: String(clean(action.executable)) }),
    ...(action.sourceOperationId === undefined ? {} : { sourceOperationId: String(clean(action.sourceOperationId)) }) });
  const savedObservation = { output: clean(output), rawFinal: clean(rawFinal), requestedActions: requestedActions.map(cleanAction), invokedActions: invokedActions.map(cleanAction) };
  const savedOracle = status === 'completed' ? evaluateLiveObservation(test, savedObservation) : null;
  const redaction = { modelOutputChanged: json(clean({ output, rawFinal })) !== json({ output, rawFinal }), oracleChanged: json(originalOracle) !== json(savedOracle) };
  const result: WorkerResult = {
    status, caseId: test.id, ...savedObservation,
    networkRequests, authorizations, operationalCode, transportFailureCodes: transportCodes, protocolError, firstNonSystemRequestHash,
    systemHash, systemRemainderHash, sharedBehaviorBlocks, expectedSystemAdditionCounts, workHash: sha(json(input.work)),
    fixtureHash: sha(json(input.work.payload)), scopeHash: sha(json({ scenario: test.scenario, checkpoint: input.work.localCheckpoint ?? null, sessionId: input.sessionId })),
    configHash: sha(json(input.config)), durationMs: Date.now() - started, rawResponseHashes, modelUsage, providerModels,
    redaction, oracle: redaction.oracleChanged ? null : originalOracle,
  };
  writeJson(join(input.folder, 'result.json'), clean(result));
}

function selfCheck() {
  const addition = 'Explicit check-only source guidance.';
  const baseline = systemComparison(`Role.\n${oldActivePrinciple}\nProtocol.`, [addition]);
  const candidate = `Role.\n<shared_agent_behavior>Shared behavior.</shared_agent_behavior>\nProtocol.\n${addition}`;
  const comparable = (system: string) => {
    const current = systemComparison(system, [addition]);
    return baseline.counts[0] === 0 && current.counts[0] === 1 && baseline.remainderHash === current.remainderHash;
  };
  assert(comparable(candidate), 'The exact preregistered addition must preserve comparison');
  assert(!comparable(candidate.replace(addition, '')), 'A missing addition must invalidate comparison');
  assert(!comparable(candidate + '\n' + addition), 'A repeated addition must invalidate comparison');
  assert(!comparable(candidate + '\nUnregistered directive.'), 'An undeclared system difference must invalidate comparison');
  assert(stopOnProtocolFailure('stop-on-first-protocol-failure', 1, 'protocol_invalid'));
  assert(!stopOnProtocolFailure('stop-on-first-protocol-failure', 2, 'protocol_invalid'));
  assert(!stopOnProtocolFailure('retain-known-check-protocol-failures', 1, 'protocol_invalid'));
  const results = liveBehaviorCases.map(test => {
    const examples = liveOracleExamples(test);
    const positive = evaluateLiveObservation(test, examples.good), negative = evaluateLiveObservation(test, examples.bad);
    assert(positive.hardPassed, `${test.id} positive failed: ${positive.failures.join('; ')}`);
    assert(!negative.hardPassed, `${test.id} explicit faulty output escaped the oracle`);
    return { caseId: test.id, positive: true, negativeDetected: true, manualQuestions: test.manualQuestions.length };
  });
  return { status: 'passed', layer: 'evaluator controls only; not prompt behavior',
    systemDifferenceControls: { exactAdditionAccepted: true, missingDetected: true, duplicateDetected: true, undeclaredDifferenceDetected: true },
    preflightPolicyControls: { originalStops: true, laterFailureRetained: true, targetedFirstFailureRetained: true }, cases: results };
}

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
function readback(evidence: string) {
  const manifest = JSON.parse(readFileSync(join(evidence, 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[]; trials: string[]; expectedTrials: number; networkRequests: number; priorProviderRequests?: number; totalProviderRequests?: number };
  assert(manifest.networkRequests <= requestLimit, 'Recorded model request count exceeds the hard limit');
  const totalRequests = (manifest.priorProviderRequests ?? 0) + manifest.networkRequests;
  assert(totalRequests <= requestLimit, 'Prior batches must remain inside the shared hard limit');
  if (manifest.totalProviderRequests !== undefined) assert.equal(manifest.totalProviderRequests, totalRequests);
  for (const item of manifest.files) { assert(!item.path.startsWith('/') && !item.path.split('/').includes('..')); assert.equal(sha(readFileSync(join(evidence, item.path))), item.sha256, item.path); }
  assert.equal(new Set(manifest.trials).size, manifest.trials.length);
  for (const path of manifest.trials) {
    const result = JSON.parse(readFileSync(join(evidence, path), 'utf8')) as WorkerResult;
    if (result.status === 'completed' && !result.redaction.oracleChanged) assert.deepEqual(evaluateLiveObservation(selectedCase(result.caseId), result), result.oracle, 'Oracle result must be reproducible from saved observations');
  }
  return { status: 'passed', layer: 'evidence hash and deterministic-oracle readback', artifacts: manifest.files.length, trials: manifest.trials.length,
    completeTrialSet: manifest.trials.length === manifest.expectedTrials };
}

async function runLive(args: string[]) {
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const repeats = Number(option('--repeats') ?? 2);
  const priorBatch = option('--prior-batch') ? resolve(option('--prior-batch')!) : null;
  const priorRun = priorBatch ? JSON.parse(readFileSync(join(priorBatch, 'run.json'), 'utf8')) as { networkRequests: number; priorProviderRequests?: number } : null;
  const priorProviderRequests = priorRun ? priorRun.networkRequests + (priorRun.priorProviderRequests ?? 0) : 0;
  assert(Number.isInteger(priorProviderRequests) && priorProviderRequests >= 0 && priorProviderRequests < requestLimit, 'Prior real provider requests must be retained in the shared request budget');
  const requestBudget = Number(option('--max-requests') ?? requestLimit - priorProviderRequests);
  const studyKind = args.includes('--controlled-provider') ? 'controlled-provider-harness' : 'live-provider';
  assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 4, 'Use at most four preregistered paired repetitions');
  assert(Number.isInteger(requestBudget) && requestBudget > 0 && requestBudget + priorProviderRequests <= requestLimit, 'Per-run and prior requests must fit the global hard limit');
  const selectedIds = option('--cases')?.split(',');
  if (selectedIds) { assert.equal(new Set(selectedIds).size, selectedIds.length); selectedIds.forEach(selectedCase); }
  const tests = selectedIds ? liveBehaviorCases.filter(test => selectedIds.includes(test.id)) : liveBehaviorCases;
  const systemAdditionPath = option('--expected-system-addition-file');
  const expectedSystemAdditions = systemAdditionPath ? [readFileSync(resolve(systemAdditionPath), 'utf8').trim()] : [];
  if (expectedSystemAdditions.length) {
    assert(tests.every(test => test.kind === 'check'), 'An extra system addition must be a separately preregistered check-only study');
    assert(expectedSystemAdditions.every(text => text.length > 0 && text.length <= 8000 && !text.includes('<shared_agent_behavior>')), 'Expected addition must be an explicit bounded directive, separate from the shared block');
  }
  assert(repeats <= 2 || expectedSystemAdditions.length > 0, 'More than two repetitions require the separately preregistered check-only follow-up');
  const preflightProtocolPolicy = expectedSystemAdditions.length ? 'retain-known-check-protocol-failures' : 'stop-on-first-protocol-failure';
  const evidence = resolve(option('--evidence') ?? join(root, 'reports/shared-agent-behavior-live', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
  assert(!existsSync(evidence), 'Evidence directory must be new'); mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeJson(join(evidence, 'oracle-controls.json'), selfCheck());
  writeJson(join(evidence, 'expected-system-additions.json'), expectedSystemAdditions.map(text => ({ text, sha256: sha(text) })));
  const env = readModelEnv();
  const missing = ['MODEL_BASE_URL', 'MODEL_NAME'].filter(key => !env[key]?.trim());
  if (missing.length || !args.includes('--run')) {
    const status = missing.length ? 'blocked' : 'configured-not-probed';
    writeJson(join(evidence, 'run.json'), { status, studyKind, code: missing.length ? 'LIVE_MODEL_CONFIGURATION_MISSING' : 'PREFLIGHT_ONLY', missing, providerRequestsIssued: 0,
      layer: 'No real-model effect has been measured; use --run for explicit live execution', oracleControls: 'passed' });
    writeJson(join(evidence, 'manifest.json'), { version: 1, files: files(evidence).map(path => ({ path: relative(evidence, path), sha256: sha(readFileSync(path)) })),
      trials: [], expectedTrials: tests.length * repeats * 2, networkRequests: 0 });
    if (missing.length) process.exitCode = 78;
    console.log(json({ status, missing, providerRequestsIssued: 0, evidence })); return;
  }
  const { createTeamConfig } = await import('../team.config.js');
  const config = createTeamConfig(env); config.skillSearch = { enabled: false };
  config.limits = { ...config.limits, ordinary: 12, checks: 1, assists: 2, replans: 1, retries: 0, workTimeoutMs: trialLimitMs };
  const clean = redactor(config), started = Date.now(), suiteDeadline = started + suiteLimitMs;
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const temporary = mkdtempSync(join(tmpdir(), 'squad-prompt-live-')), baseline = join(temporary, 'baseline');
  const trials: TrialRecord[] = [], runId = randomUUID(); let issued = 0, baselineCreated = false, cleanup = false;
  let fingerprints: { baseline: string; candidate: string } | null = null;
  let runError: string | null = null;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', baseline, baselineRef], { cwd: root, stdio: 'pipe' }); baselineCreated = true;
    symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'dir');
    fingerprints = { baseline: sourceFingerprint(baseline), candidate: sourceFingerprint(root) };
    evaluation: for (let repetition = 1; repetition <= repeats; repetition++) for (const test of tests) {
      if (issued >= requestBudget || Date.now() >= suiteDeadline) break evaluation;
      const work = frozenLiveWork(test, config), pairId = `${test.id}:r${repetition}`;
      const variants = repetition % 2 ? ['baseline', 'candidate'] as const : ['candidate', 'baseline'] as const;
      for (const variant of variants) {
        if (issued >= requestBudget || Date.now() >= suiteDeadline) break evaluation;
        assert.equal(sourceFingerprint(variant === 'baseline' ? baseline : root), fingerprints[variant], 'Evaluation source changed; preserve the incomplete study');
        const id = `${test.id}-r${repetition}-${variant}`, folder = join(evidence, id); mkdirSync(folder);
        const input: WorkerInput = { caseId: test.id, config, work, sourceRoot: variant === 'baseline' ? baseline : root, folder,
          sessionId: `${runId}:${pairId}`, maxRequests: requestBudget - issued, suiteDeadline, expectedSystemAdditions };
        const inputPath = join(temporary, 'input.json'); writeJson(inputPath, input);
        const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--worker', inputPath], {
          cwd: root, env: process.env, encoding: 'utf8', timeout: Math.max(1, Math.min(trialLimitMs + 15_000, suiteDeadline - Date.now())), maxBuffer: 1024 * 1024,
        });
        rmSync(inputPath, { force: true });
        writeJson(join(folder, 'process.json'), { exitCode: child.status, signal: child.signal, error: child.error ? safeCode(child.error) : null,
          stdout: clean(child.stdout), stderr: clean(child.stderr) });
        const journal = join(folder, 'requests.jsonl');
        issued += existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).length : 0;
        const resultPath = join(folder, 'result.json');
        if (!existsSync(resultPath)) { runError = 'TRIAL_PROCESS_INCOMPLETE'; break evaluation; }
        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as WorkerResult;
        trials.push({ id, pairId, caseId: test.id, variant, repetition, folder: relative(evidence, folder), result });
        console.log(json({ caseId: test.id, repetition, variant, status: result.status, hardContractPassed: result.oracle?.hardPassed ?? null,
          manualQuestions: result.oracle?.manualReviewRequired.length ?? 0, requests: result.networkRequests }));
        if (result.status === 'provider_invalid') { runError = 'PROVIDER_SAMPLE_INVALID_NO_AUTOMATIC_RETRY'; break evaluation; }
        if (stopOnProtocolFailure(preflightProtocolPolicy, trials.length, result.status)) {
          runError = 'INITIAL_MODEL_PROTOCOL_INVALID_NO_AUTOMATIC_RETRY'; break evaluation;
        }
      }
      if (runError) break;
    }
  } catch (error) { runError = safeCode(error); }
  finally {
    if (baselineCreated) execFileSync('git', ['worktree', 'remove', '--force', baseline], { cwd: root, stdio: 'pipe' });
    rmSync(temporary, { recursive: true, force: true }); cleanup = !existsSync(temporary);
  }
  assert(issued <= requestBudget); assert(cleanup);
  const pairs = [...new Set(trials.map(trial => trial.pairId))].map(pairId => {
    const group = trials.filter(trial => trial.pairId === pairId), a = group.find(trial => trial.variant === 'baseline'), b = group.find(trial => trial.variant === 'candidate');
    const equal = !!a && !!b && a.result.fixtureHash === b.result.fixtureHash && a.result.scopeHash === b.result.scopeHash && a.result.configHash === b.result.configHash
      && a.result.workHash === b.result.workHash && a.result.firstNonSystemRequestHash !== null
      && a.result.firstNonSystemRequestHash === b.result.firstNonSystemRequestHash && a.result.systemRemainderHash === b.result.systemRemainderHash
      && a.result.sharedBehaviorBlocks === 0 && b.result.sharedBehaviorBlocks === 1 && a.result.systemHash !== b.result.systemHash
      && a.result.expectedSystemAdditionCounts.length === expectedSystemAdditions.length
      && b.result.expectedSystemAdditionCounts.length === expectedSystemAdditions.length
      && a.result.expectedSystemAdditionCounts.every(count => count === 0) && b.result.expectedSystemAdditionCounts.every(count => count === 1);
    return { pairId, comparableInputs: equal, baselineStatus: a?.result.status ?? null, candidateStatus: b?.result.status ?? null,
      baselineHardPassed: a?.result.oracle?.hardPassed ?? null, candidateHardPassed: b?.result.oracle?.hardPassed ?? null };
  });
  const review = trials.filter(trial => trial.result.oracle?.manualReviewRequired.length).map(trial => ({ reviewId: sha(`${runId}:${trial.id}`).slice(0, 20), caseId: trial.caseId,
    input: selectedCase(trial.caseId).objective, output: trial.result.output, questions: trial.result.oracle!.manualReviewRequired, humanVerdict: null }));
  writeJson(join(evidence, 'blind-review.json'), review.sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
  writeJson(join(evidence, 'review-key.json'), trials.map(trial => ({ reviewId: sha(`${runId}:${trial.id}`).slice(0, 20), trialId: trial.id, variant: trial.variant })));
  const expectedTrials = tests.length * repeats * 2;
  const executionStatus = runError || trials.length !== expectedTrials ? 'incomplete' : pairs.some(pair => !pair.comparableInputs) ? 'invalid-comparison'
    : trials.some(trial => trial.result.status === 'provider_invalid' || trial.result.redaction.oracleChanged) ? 'inconclusive-provider-or-redacted-samples' : 'completed';
  const candidate = trials.filter(trial => trial.variant === 'candidate');
  const automaticContractsStatus = candidate.some(trial => trial.result.status === 'protocol_invalid' || trial.result.oracle?.hardPassed === false) ? 'failed'
    : candidate.length !== tests.length * repeats ? 'incomplete'
    : candidate.some(trial => trial.result.status === 'provider_invalid' || trial.result.redaction.oracleChanged) ? 'unconfirmed' : 'passed';
  const behaviorConclusion = studyKind === 'controlled-provider-harness' ? 'not-a-real-model-effect-test'
    : executionStatus !== 'completed' ? 'effect-not-confirmed'
    : automaticContractsStatus === 'failed' ? 'automatic-contract-violation-observed'
    : review.length ? 'manual-review-pending' : 'automatic-contracts-passed-improvement-not-established';
  const summary = { status: executionStatus, automaticContractsStatus, behaviorConclusion,
    studyKind,
    sourceHead, baselineRef, sourceFingerprints: fingerprints, evaluatorSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    transportEnvironment: { nodeVersion: process.version, environmentProxyEnabled: process.env.NODE_USE_ENV_PROXY === '1', systemCaEnabled: process.env.NODE_USE_SYSTEM_CA === '1',
      httpProxyPresent: Boolean(process.env.HTTP_PROXY), httpsProxyPresent: Boolean(process.env.HTTPS_PROXY) },
    fixtureSha256: sha(readFileSync(join(root, 'tests/shared-agent-behavior-live-fixtures.ts'))),
    expectedSystemAdditionHashes: expectedSystemAdditions.map(text => sha(text)),
    preflightProtocolPolicy,
    runId, selectedCaseIds: tests.map(test => test.id), expectedTrials, actualTrials: trials.length, networkRequests: issued, requestLimit: requestBudget,
    globalRequestLimit: requestLimit, priorBatch, priorProviderRequests, totalProviderRequests: priorProviderRequests + issued,
    remainingProviderRequests: requestLimit - priorProviderRequests - issued, pairs, cleanup, runError,
    automatic: { baselineHardPassed: trials.filter(trial => trial.variant === 'baseline' && trial.result.oracle?.hardPassed).length,
      candidateHardPassed: trials.filter(trial => trial.variant === 'candidate' && trial.result.oracle?.hardPassed).length,
      baselineSamples: trials.filter(trial => trial.variant === 'baseline').length, candidateSamples: candidate.length, expectedSamplesPerVariant: tests.length * repeats,
      candidateHardFailed: candidate.filter(trial => trial.result.oracle?.hardPassed === false).length,
      candidateProtocolInvalid: candidate.filter(trial => trial.result.status === 'protocol_invalid').length,
      eligibleSamples: trials.filter(trial => trial.result.status === 'completed' && !trial.result.redaction.oracleChanged).length,
      providerInvalidSamples: trials.filter(trial => trial.result.status === 'provider_invalid').length,
      protocolInvalidSamples: trials.filter(trial => trial.result.status === 'protocol_invalid').length,
      redactionExcludedSamples: trials.filter(trial => trial.result.redaction.oracleChanged).length },
    manualReview: { items: review.length, completed: 0, status: 'not-reviewed' },
    limits: ['Controlled tool stimuli with real model choices; not full Engine/OS end-to-end',
      'Small paired sample, no calibrated correctness rate or causal cross-task claim', 'Unspecified provider defaults, routing and cache behavior remain unverified',
      'Open prose semantics require the separate blind review; hard-contract pass is not a semantic pass'] };
  writeJson(join(evidence, 'run.json'), summary);
  const artifacts = files(evidence).map(path => ({ path: relative(evidence, path), sha256: sha(readFileSync(path)) }));
  writeJson(join(evidence, 'manifest.json'), { version: 1, files: artifacts, trials: trials.map(trial => join(trial.folder, 'result.json')), expectedTrials, networkRequests: issued,
    priorBatch, priorProviderRequests, totalProviderRequests: priorProviderRequests + issued, globalRequestLimit: requestLimit, requestBudget, preflightProtocolPolicy });
  const checked = readback(evidence); writeJson(join(evidence, 'readback.json'), checked);
  console.log(json({ status: summary.status, expectedTrials, actualTrials: trials.length, requests: issued, evidence, cleanup,
    automaticContractsStatus, behaviorConclusion, hardContracts: summary.automatic, manualReviewRequired: review.length, evidenceReadback: checked.status,
    exitMeaning: 'Execution completion only; exit0 is not semantic correctness or improvement validation' }));
  if (summary.status !== 'completed') process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') { assert(args[1]); await worker(JSON.parse(readFileSync(args[1], 'utf8')) as WorkerInput); return; }
  if (args[0] === '--self-check') { console.log(json(selfCheck())); return; }
  if (args[0] === '--verify-evidence') { assert(args[1]); console.log(json(readback(resolve(args[1])))); return; }
  await runLive(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(json({ status: 'failed', code: safeCode(error), providerValuesRedacted: true })); process.exitCode = 1; });
}
