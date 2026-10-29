import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { After, Given, When, Then } from '@cucumber/cucumber';
import { WorkRunner, TeamEngine, SqliteStore, type WebToolResult, type WebFetchToolOutput, type WorkAdapter } from '../../src/index.js';
import { WebService } from '../../src/web/service.js';
import type { RoomSnapshot } from '../../src/web/contracts.js';
import { configuration, Harness } from '../helpers.js';
import { webFixture, webModelConfig, scriptedModel, webEnv, sourceUrl, answer } from '../web-tools-fixture.js';
import type { SpecWorld } from './steps.js';

interface WebState {
  fixture: ReturnType<typeof webFixture>;
  model?: ReturnType<typeof scriptedModel>;
  constraint?: string;
  error?: string;
  url?: string;
  pages?: WebToolResult<WebFetchToolOutput>[];
  expected?: string;
  runner?: WorkRunner;
  running?: Promise<boolean>;
  directory?: string;
  database?: string;
  store?: SqliteStore;
  host?: WebService;
  room?: string;
  snapshot?: RoomSnapshot;
}
const states = new WeakMap<SpecWorld, WebState>();
const s = (w: SpecWorld) => { const state = states.get(w); assert(state); return state; };
function setup(w: SpecWorld, fixture = webFixture()) { states.set(w, { fixture }); return s(w); }
function driver(w: SpecWorld, adapter: WorkAdapter) { return new WorkRunner(w.h.engine, adapter, () => w.h.now, undefined, s(w).fixture.tools); }
async function requestSearch(w: SpecWorld) {
  await driver(w, { execute: async (work, signal, scope) => {
    if (s(w).constraint === '已停止') w.h.event({ type: 'STOP' });
    if (s(w).constraint === '工作过期') w.h.now = work.deadline!;
    if (s(w).constraint === '旧目标版本') work.goalVersion--;
    try { await scope.webSearch({ query: 'SDK' }, signal); }
    catch (error) { s(w).error = String(error); throw error; }
    return answer;
  } }).runOne(w.h.room, w.h.task);
}
After(async function (this: SpecWorld) {
  const state = states.get(this);
  if (!state) return;
  await state.host?.close(); state.store?.close();
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
});

Given('网页工具已配置且任务由{string}负责', function (this: SpecWorld, member: string) {
  setup(this); const config = webModelConfig(); config.defaultBot = member;
  this.h = new Harness(config); s(this).model = scriptedModel(config);
});
When('模型依次请求网页搜索、网页抓取和提交答案', async function (this: SpecWorld) { await driver(this, s(this).model!.adapter).runOne(this.h.room, this.h.task); });
Then('搜索与抓取应调用 Cloudflare Agents SDK 并保留来源', function (this: SpecWorld) {
  const { calls } = s(this).fixture;
  assert.equal(calls.length, 2); assert(calls[0]!.url.endsWith('/ai/websearch/')); assert.equal(calls[1]!.url, sourceUrl);
  assert.equal(JSON.parse(String(calls[0]!.init!.body)).limit, 5);
  assert(s(this).model!.requests[1]!.messages.some(m => m.content.includes(sourceUrl)));
  assert(s(this).model!.requests[2]!.messages.some(m => m.content.includes('untrusted_web_content')));
  assert.equal(this.h.context().candidate?.text, `依据 ${sourceUrl}`);
});
Then('三次模型请求与两次联网工具请求应消耗五次普通额度', function (this: SpecWorld) {
  assert.equal(s(this).model!.requests.length, 3); assert.equal(this.h.context().usage.ordinary, 5); assert.equal(this.h.view().phase, 'checking');
});
Given('网页工具工作受到{string}约束', function (this: SpecWorld, constraint: string) {
  setup(this).constraint = constraint;
  const config = configuration({ ordinary: constraint === '普通额度耗尽' ? 1 : constraint === '评审汇总保留额度' ? 3 : 30 });
  if (constraint === '工具关闭') config.webTools = { enabled: false };
  this.h = new Harness(config);
  if (constraint === '评审汇总保留额度') {
    this.h.event({ type: 'USER_INPUT', text: '请 B 评审', reviewTargets: ['B'] });
    this.h.event({ type: 'BOUNDARY' });
    const work = this.h.claim('facilitator');
    this.h.event({ type: 'COORDINATE', workId: work.id, decision: { action: 'review', reason: '用户请求', question: '核对方案', expected: '来源' } });
  }
});
When('工作请求网页搜索', async function (this: SpecWorld) { await requestSearch(this); });
Then('应拒绝联网且保留{string}原因', function (this: SpecWorld, reason: string) { assert.equal(s(this).fixture.calls.length, 0); assert(s(this).error?.includes(reason), s(this).error); });

Given('网页以{string}返回长正文', function (this: SpecWorld, format: string) {
  const state = setup(this, webFixture({ pageChars: 40 }));
  const text = '已验证的来源段落。\n'.repeat(10);
  state.fixture.state.type = ({ Markdown: 'text/markdown', JSON: 'application/json', HTML: 'text/html', PDF: 'application/pdf' } as Record<string, string>)[format]!;
  state.fixture.state.content = format === 'JSON' ? JSON.stringify({ text }) : format === 'HTML' ? `<p>${text}</p>` : format === 'PDF' ? '%PDF-fixture' : text;
  state.fixture.state.converted = text;
  state.expected = format === 'JSON' ? JSON.stringify({ text }, null, 2) : text.trimEnd();
});
When('抓取第一页并使用返回的偏移量继续读取', async function (this: SpecWorld) {
  const state = s(this); state.pages = [];
  let offset = 0;
  for (let n = 0; n < 30; n++) {
    const page = await state.fixture.tools.fetch({ url: sourceUrl, offset }, new AbortController().signal);
    state.pages.push(page);
    if (page.output.nextOffset === null) return;
    assert(page.output.nextOffset > offset); offset = page.output.nextOffset;
  }
  assert.fail('Pagination did not terminate');
});
Then('每页应有界且合起来保留完整正文与 HTTP 状态', function (this: SpecWorld) {
  const pages = s(this).pages!; assert(pages.length > 1);
  for (const page of pages) { assert(page.output.content.length <= 40); assert.equal(page.output.status, 200); assert.equal(page.output.finalUrl, sourceUrl); }
  assert.equal(pages.map(page => page.output.content).join('').trimEnd(), s(this).expected);
});
Then('网页正文应被标记为不可信资料', function (this: SpecWorld) { for (const page of s(this).pages!) assert(page.text.includes('<untrusted_web_content>')); });

Given('网页请求使用{string}', function (this: SpecWorld, url: string) {
  const state = setup(this); state.url = url === '公网重定向到私网' ? sourceUrl : url;
  if (url === '公网重定向到私网') state.fixture.state.redirect = 'http://169.254.169.254/latest/meta-data';
});
When('通过网页工具执行抓取', async function (this: SpecWorld) {
  try { await s(this).fixture.tools.fetch({ url: s(this).url! }, new AbortController().signal); }
  catch (error) { s(this).error = String(error); }
});
Then('应拒绝不允许的地址且不得向该目标发出 HTTP 请求', function (this: SpecWorld) {
  assert(s(this).error?.includes('web_fetch_disallowed'), s(this).error);
  assert(s(this).fixture.calls.every(call => call.url === sourceUrl));
});

Given('联网服务出现{string}', function (this: SpecWorld, error: string) {
  const state = setup(this, webFixture({ timeoutMs: 30, ...(error === '未配置凭据' ? { env: {} } : {}) }));
  this.h = new Harness(configuration({ retries: 0 }));
  if (error === '搜索鉴权失败') state.fixture.state.searchStatus = 401;
  if (error === '搜索限流') { state.fixture.state.searchStatus = 429; state.fixture.state.errorCode = 'web_search_rate_limited'; }
  if (error === '搜索超时') state.fixture.state.wait = true;
});
Then('工作应明确失败并保留安全错误代码', function (this: SpecWorld) {
  assert(s(this).error?.match(/WEB_TOOLS_NOT_CONFIGURED|web_search_(unauthorized|rate_limited|timeout)/), s(this).error);
  assert.equal(this.h.view().phase, 'waitingHuman'); assert.equal(this.h.context().candidate, null);
});
Then('任务记录不应包含 Cloudflare 密钥或供应商原始错误正文', function (this: SpecWorld) {
  const text = JSON.stringify(this.h.store.read(this.h.room)); assert(!text.includes(webEnv.CLOUDFLARE_API_TOKEN)); assert(!text.includes('raw-provider-echo'));
});

Given('{string}请求正在等待响应', async function (this: SpecWorld, tool: string) {
  const state = setup(this); state.fixture.state.wait = true;
  const started = new Promise<void>(resolve => { state.fixture.state.notify = resolve; });
  state.runner = driver(this, { execute: async (_work, signal, scope) => {
    if (tool === 'web_search') await scope.webSearch({ query: 'SDK' }, signal);
    else await scope.webFetch({ url: sourceUrl }, signal);
    return answer;
  } });
  state.running = state.runner.runOne(this.h.room, this.h.task); await started;
});
When('用户停止联网任务并执行取消意图', async function (this: SpecWorld) {
  this.h.event({ type: 'STOP' }); await s(this).runner!.runOne(this.h.room, this.h.task); await s(this).running;
});
Then('联网请求应收到取消信号且不发布迟到答案', function (this: SpecWorld) {
  assert(s(this).fixture.state.aborted); assert.equal(this.h.context().outcome, 'stopped');
  assert(!this.h.context().messages.some(m => m.kind === 'final'));
});

Given('一个正在执行的联网任务已保存到 SQLite', function (this: SpecWorld) {
  const state = setup(this); state.directory = mkdtempSync(join(tmpdir(), 'squad-web-tools-')); state.database = join(state.directory, 'team.sqlite');
  state.store = new SqliteStore(state.database); this.h = new Harness(configuration(), state.store);
  const work = this.h.claim(); this.h.event({ type: 'CONSUME', intentId: work.id });
  state.store.close(); state.store = new SqliteStore(state.database);
});
When('使用关闭网页工具的新配置恢复任务', function (this: SpecWorld) {
  const config = configuration(); config.webTools = { enabled: false };
  this.h.engine = new TeamEngine(s(this).store!, config, () => this.h.now); this.h.engine.recover(this.h.room);
});
Then('待执行工作不再宣告联网能力且直接调用也会被拒绝', async function (this: SpecWorld) {
  const caps = this.h.engine.pending(this.h.room, this.h.task)[0]!.payload.capabilities;
  assert.deepEqual(caps, { localTools: true, findSkills: true, webSearch: false, webFetch: false });
  await requestSearch(this); assert(s(this).error?.includes('WEB_TOOLS_DISABLED')); assert.equal(s(this).fixture.calls.length, 0);
});
When('使用原配置恢复并重新执行联网工作', async function (this: SpecWorld) {
  this.h.engine = new TeamEngine(s(this).store!, this.h.config, () => this.h.now); this.h.engine.recover(this.h.room); await requestSearch(this);
});
Then('恢复领取与新的搜索调用应继续累计原有预算', function (this: SpecWorld) {
  assert.equal(this.h.context().usage.ordinary, 3); assert.equal(s(this).fixture.calls.length, 1); assert.equal(this.h.view().phase, 'checking');
  assert.equal(this.h.context().intents.find(i => i.kind === 'owner')!.attempt, 2);
});

Given('各 Bot 配置了不同的兼容模型服务', function (this: SpecWorld) {
  setup(this); const config = webModelConfig();
  for (const bot of config.bots) { bot.model = bot.id; config.models!.services[bot.id] = { baseUrl: `https://${bot.id.toLowerCase()}.example/v1`, model: bot.id }; }
  this.h = new Harness(config);
});
When('为负责人、协助成员和促进者生成工作意图', function (this: SpecWorld) {
  const check = () => assert.deepEqual(this.h.engine.pending(this.h.room, this.h.task)[0]!.payload.capabilities, { localTools: true, findSkills: true, webSearch: true, webFetch: true });
  check(); assert.equal(this.h.engine.pending(this.h.room, this.h.task)[0]!.model!.serviceId, 'A');
  this.h.help(); check(); assert.equal(this.h.engine.pending(this.h.room, this.h.task)[0]!.model!.serviceId, 'B');
  this.h.result(); this.h.event({ type: 'BLOCKED', reason: '需要来源' }); check();
});
Then('每种工作都应携带默认网页搜索和抓取能力', function (this: SpecWorld) {
  for (const work of this.h.context().intents.filter(i => ['owner', 'assistance', 'facilitator'].includes(i.kind))) assert.deepEqual(work.payload.capabilities, { localTools: true, findSkills: true, webSearch: true, webFetch: true });
});
Then('最终检查仍只使用原有检查额度', async function (this: SpecWorld) {
  this.h = new Harness(); this.h.event({ type: 'DELIVER', text: '结果', artifactIds: [] });
  await driver(this, { execute: async (_work, signal, scope) => {
    await assert.rejects(scope.webSearch({ query: 'SDK' }, signal), /WEB_TOOLS_NOT_ALLOWED/);
    return { type: 'check', passed: true, gaps: [] };
  } }).runOne(this.h.room, this.h.task);
  assert.equal(this.h.context().usage.checks, 1); assert.equal(this.h.context().usage.ordinary, 0); assert.equal(s(this).fixture.calls.length, 0);
});

Given('从群聊服务发起一个需要联网的任务', function (this: SpecWorld) {
  const state = setup(this);
  state.host = new WebService(configuration(), ':memory:', { execute: async (work, signal, scope) => {
    if (work.kind === 'check') return { type: 'check', passed: true, gaps: [] };
    await scope.webSearch({ query: 'SDK' }, signal); await scope.webFetch({ url: sourceUrl }, signal); return answer;
  } }, state.fixture.tools);
  state.room = state.host.createRoom().id;
  state.host.submit(state.room, { id: 'web-task', text: '联网核查来源' });
});
When('成员完成网页搜索与抓取', async function (this: SpecWorld) {
  const state = s(this);
  for (let n = 0; n < 100; n++) {
    state.snapshot = state.host!.snapshot(state.room!);
    if (state.snapshot.tasks[0]?.outcome === 'complete') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Web host did not finish');
});
Then('成员执行详情应包含工具开始、来源结果和完成状态', function (this: SpecWorld) {
  const events = s(this).snapshot!.events;
  for (const title of ['搜索网页', '读取网页', '网页搜索完成', '网页读取完成', '返回执行结果']) assert(events.some(e => e.title === title), title);
  assert(events.filter(e => e.kind === 'tool-result').every(e => e.detail.includes(sourceUrl)));
});
Then('详情和持久任务配置不应包含 Cloudflare 密钥', function (this: SpecWorld) {
  const state = s(this); const data = JSON.stringify([state.snapshot, state.host!.engine.view(state.room!)]);
  assert(!data.includes(webEnv.CLOUDFLARE_API_TOKEN)); assert(!data.includes('CLOUDFLARE_API_TOKEN'));
});
