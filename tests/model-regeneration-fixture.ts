import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, OpenAICompatibleAdapter, SqliteStore, TeamEngine, WorkRunner, type Intent, type Store, type TeamConfig } from '../src/index.js';
import { configuration, Harness } from './helpers.js';

export type ModelKind = 'owner' | 'assistance' | 'facilitator' | 'check';
export interface CapturedModelRequest { model: string; messages: { role: string; content: string }[] }
export function regenerationConfig(limits: Partial<TeamConfig['limits']> = {}): TeamConfig {
  const config = configuration({ retries: 2, ...limits });
  config.models = { default: 'test', services: { test: { baseUrl: 'https://model.example/v1', model: 'model' } } };
  return config;
}
export function modelResponse(value: unknown, finish = 'stop'): Response {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
}
export function badModelOutput(name: string): unknown {
  const values: Record<string, unknown> = {
    answer类型: { type: 'answer', text: '误用了其他角色的协议' },
    decision类型: { type: 'decision', decision: { action: 'finish', reason: '不是检查协议' } },
    passed字符串: { type: 'check', passed: 'true', gaps: [] },
    verdict替代字段: { type: 'check', verdict: 'pass', gaps: [] },
    gaps缺失: { type: 'check', passed: true },
    gaps为null: { type: 'check', passed: true, gaps: null },
    gaps为字符串: { type: 'check', passed: true, gaps: '无' },
    gaps为对象数组: { type: 'check', passed: true, gaps: [{ text: '无' }] },
    JSON损坏: '{"type":"answer","text":', JSON数组: [],
    空答案: { type: 'answer', text: ' ' },
    缺少产物引用数组: { type: 'deliver', text: '方案' },
    网页工具参数错误: { type: 'web_search', query: ' ' },
    错误类型: { type: 'check', passed: true, gaps: [] },
    decision字段不完整: { type: 'decision', decision: { action: 'assist', reason: '缺少target等字段' } },
  };
  assert(Object.hasOwn(values, name), name); return values[name];
}
export function goodModelOutput(kind: ModelKind): unknown {
  return kind === 'check' ? { type: 'check', passed: true, gaps: [] }
    : kind === 'facilitator' ? { type: 'decision', decision: { action: 'continue', reason: '继续原任务' } }
    : { type: 'answer', text: '合法完整结果，依据 https://example.com/source' };
}

/** Actual WorkRunner + adapter + transactional state machine; only the HTTP provider is scripted. */
export class RegenerationFixture {
  readonly h: Harness;
  readonly directory?: string;
  readonly path?: string;
  currentStore: Store;
  readonly requests: CapturedModelRequest[] = [];
  replies: unknown[] = [];
  fallback: unknown;
  beforeResponse?: ((index: number) => void) | undefined;
  responseFactory?: ((index: number) => Response) | undefined;
  searches = 0;
  webCalls = 0;
  readonly adapter: OpenAICompatibleAdapter;

  constructor(readonly kind: ModelKind = 'check', limits: Partial<TeamConfig['limits']> = {}, sqlite = false) {
    if (sqlite) {
      this.directory = mkdtempSync(join(tmpdir(), 'squad-schema-'));
      this.path = join(this.directory, 'team.sqlite');
    }
    this.currentStore = this.path ? new SqliteStore(this.path) : new MemoryStore();
    this.h = new Harness(regenerationConfig(limits), this.currentStore);
    if (kind === 'check') {
      const owner = this.h.claim('owner');
      assert(this.h.event({ type: 'DELIVER', workId: owner.id, text: '完整方案，依据 https://example.com', artifactIds: [] }).ok);
    } else if (kind === 'facilitator') assert(this.h.event({ type: 'BLOCKED', reason: '需要协调' }).ok);
    else if (kind === 'assistance') assert(this.h.help().ok);
    this.fallback = goodModelOutput(kind);
    this.adapter = new OpenAICompatibleAdapter(this.h.config, {
      clock: () => this.h.now,
      transport: async (_url, init) => {
        const index = this.requests.length;
        this.requests.push(JSON.parse(String(init?.body)) as CapturedModelRequest);
        this.beforeResponse?.(index);
        return this.responseFactory?.(index) ?? modelResponse(this.replies.length ? this.replies.shift() : this.fallback);
      },
    });
  }
  runner() {
    return new WorkRunner(this.h.engine, this.adapter, () => this.h.now, async () => {
      this.searches++; return Response.json({ skills: [{ id: 'tool-reference', name: '已取得的工具资料', source: 'example/repo', installs: 1 }] });
    }, { search: async () => { this.webCalls++; throw new Error('Controlled tool failure'); },
      fetch: async () => { this.webCalls++; throw new Error('Controlled tool failure'); } });
  }
  async run() { return this.runner().runOne(this.h.room, this.h.task); }
  get repairs() { return this.h.context().trace.filter(trace => trace.event === 'MODEL_OUTPUT_REPAIR'); }
  get work(): Intent { const work = this.h.context().intents.find(work => work.kind === this.kind); assert(work); return work; }
  async reopen() {
    if (this.path) { this.currentStore.close(); this.currentStore = new SqliteStore(this.path); }
    this.h.engine = new TeamEngine(this.currentStore, this.h.config, () => this.h.now);
    this.h.engine.recover(this.h.room);
  }
  close() { this.currentStore.close(); if (this.directory) rmSync(this.directory, { recursive: true, force: true }); }
}
