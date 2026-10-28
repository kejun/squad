import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore, OpenAICompatibleAdapter, SqliteStore, TeamEngine, WorkRunner,
  type InputAction, type InputIntentSpec, type Intent, type Store, type Submission, type TaskEvent, type TeamConfig,
} from '../src/index.js';
import { configuration, type EventBody } from './helpers.js';
import { modelResponse } from './model-regeneration-fixture.js';

export const complexInput = '请比较这两个设计方案；必须仅使用公开资料并保留出处；分别列出成本与恢复风险，最后交付 Markdown 计划。';
export function intentConfig(limits: Partial<TeamConfig['limits']> = {}): TeamConfig {
  return { ...configuration({ retries: 1, ...limits }), models: { default: 'test',
    services: { test: { baseUrl: 'https://model.example/v1', model: 'shared-model' } } } };
}
export function parsedIntent(action: InputAction = 'request', change: Partial<InputIntentSpec> = {}): InputIntentSpec {
  return { action, objective: '比较两个设计方案并制定计划', constraints: ['仅使用公开资料并保留出处'],
    expectedOutputs: ['Markdown 计划'], acceptanceCriteria: ['分别说明成本与恢复风险'], references: [],
    confidence: 0.95, clarification: null, ...change };
}
export interface IntentRequest { kind: Intent['kind']; model: string; messages: { role: string; content: string }[]; context: Record<string, unknown> }

/** Real engine, store, WorkRunner and compatible adapter; only provider HTTP is scripted. */
export class InputIntentFixture {
  now = 100; seq = 0; room = 'input-room'; task = 'task:input-1';
  readonly directory?: string;
  readonly path?: string;
  store: Store;
  engine: TeamEngine;
  readonly requests: IntentRequest[] = [];
  replies: unknown[] = [];
  response?: ((request: IntentRequest) => Response) | undefined;
  beforeResponse?: ((request: IntentRequest) => void) | undefined;
  readonly adapter: OpenAICompatibleAdapter;
  constructor(readonly config = intentConfig(), sqlite = false) {
    if (sqlite) { this.directory = mkdtempSync(join(tmpdir(), 'squad-intent-')); this.path = join(this.directory, 'team.sqlite'); }
    this.store = this.path ? new SqliteStore(this.path) : new MemoryStore();
    this.engine = new TeamEngine(this.store, config, () => this.now);
    this.adapter = new OpenAICompatibleAdapter(config, { clock: () => this.now, transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: IntentRequest['messages'] };
      const kind = /executing (\w+) work/.exec(body.messages[0]!.content)?.[1] as Intent['kind'];
      const context = (JSON.parse(body.messages[1]!.content) as { context: Record<string, unknown> }).context;
      const request = { ...body, kind, context };
      this.requests.push(request); this.beforeResponse?.(request);
      if (this.response) return this.response(request);
      const input = context.input as { action: InputAction } | undefined;
      const output = this.replies.length ? this.replies.shift() : kind === 'interpretation'
        ? { type: 'interpretation', spec: parsedIntent(input!.action) }
        : kind === 'check' ? { type: 'check', passed: true, gaps: [] }
        : kind === 'facilitator' ? { type: 'decision', decision: { action: 'continue', reason: '按原目标继续' } }
        : { type: 'answer', text: '完整方案与成本风险，来源 https://example.com/source' };
      return output instanceof Response ? output : modelResponse(output);
    } });
  }
  submit(text = complexInput, change: Partial<Submission> = {}) {
    const result = this.engine.submit(this.room, { id: 'input-1', text, ...change });
    if (result.taskId) this.task = result.taskId;
    return result;
  }
  event(input: EventBody) {
    return this.engine.send(this.room, this.task, { ...input, id: input.id ?? `intent-event:${++this.seq}`, at: input.at ?? this.now } as TaskEvent);
  }
  view() { const view = this.engine.view(this.room, this.task); assert(view); return view; }
  context() { return this.view().context; }
  get work() { const work = this.context().intents.filter(work => work.kind === 'interpretation').at(-1); assert(work); return work; }
  claim() { const work = this.engine.claim(this.room, this.task, this.work.id); assert(work); return work; }
  result(work = this.work, spec = parsedIntent(), id = `result:${work.id}`) {
    return this.event({ type: 'INTERPRETATION_RESULT', id, inputId: (work.payload.input as { id: string }).id,
      spec, workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion } });
  }
  run() { return new WorkRunner(this.engine, this.adapter, () => this.now).runOne(this.room, this.task); }
  async parse() { assert(this.submit().ok); assert.equal(this.view().phase, 'interpreting'); await this.run(); assert.equal(this.view().phase, 'running'); }
  prepare(kind: Intent['kind']) {
    if (kind === 'assistance') assert(this.event({ type: 'HELP', requestId: 'intent-help', caller: this.context().owner, target: 'B', question: '核对恢复风险', expected: '出处与限制' }).ok);
    if (kind === 'facilitator') assert(this.event({ type: 'BLOCKED', reason: '需要选择后续计划' }).ok);
    if (kind === 'check') assert(this.event({ type: 'DELIVER', text: '完整可验收结果', artifactIds: [] }).ok);
  }
  reopen(config = this.config) {
    if (this.path) { this.store.close(); this.store = new SqliteStore(this.path); }
    this.engine = new TeamEngine(this.store, config, () => this.now); this.engine.recover(this.room);
  }
  close() { this.store.close(); if (this.directory) rmSync(this.directory, { recursive: true, force: true }); }
}
