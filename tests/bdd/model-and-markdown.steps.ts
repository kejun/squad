import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Given, When, Then } from '@cucumber/cucumber';
import { TeamEngine, WorkRunner, OpenAICompatibleAdapter } from '../../src/index.js';
import { Harness, configuration } from '../helpers.js';
import { MessageText } from '../../web/src/MessageText.js';
import type { SpecWorld } from './steps.js';

interface ModelState { requests: { headers: Headers; body: Record<string, unknown> }[]; response?: string; status?: number; searches: number; secret: string; aborted: boolean; started?: Promise<void>; running?: Promise<boolean>; runner?: WorkRunner; transport?: typeof fetch }
const models = new WeakMap<SpecWorld, ModelState>();
const m = (w: SpecWorld) => { const value = models.get(w); assert(value); return value; };
function model(w: SpecWorld, opencode = false, retries = 1) {
  const config = configuration({ retries });
  config.models = { default: 'test', services: { test: { baseUrl: opencode ? 'https://opencode.ai/inference/go/openai/v1' : 'https://model.example.test/v1', model: 'test-model', apiKeyEnv: 'TEST_KEY' } } };
  w.h = new Harness(config); models.set(w, { requests: [], searches: 0, secret: 'test-secret-never-persist', aborted: false });
}
function response(output: unknown, finish = 'stop') { return new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(output) } }] }), { headers: { 'content-type': 'application/json' } }); }
function driver(w: SpecWorld) {
  const state = m(w);
  const adapter = new OpenAICompatibleAdapter(w.h.config, { env: { TEST_KEY: state.secret }, clock: () => 0, transport: async (url, init) => {
    state.requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (state.transport) return state.transport(url, init);
    if (state.status) return new Response(JSON.stringify({ error: { type: 'MissingSessionID', message: `sensitive echo ${state.secret}`, param: state.secret } }), { status: state.status });
    if (state.response === 'truncated') return response({ type: 'deliver', text: '截断结果', artifactIds: [] }, 'length');
    if (state.response === 'skills') return state.requests.length === 1 ? response({ type: 'findSkills', query: 'react testing' }) : response({ type: 'answer', text: '根据搜索资料给出建议' });
    const outputs = [{ type: 'help', target: 'B', question: '核查方案', expected: '依据' }, { type: 'answer', text: '核查结论' }, { type: 'deliver', text: '汇总方案', artifactIds: [] }, { type: 'check', passed: true, gaps: [] }];
    return response(outputs[state.requests.length - 1]);
  } });
  return new WorkRunner(w.h.engine, adapter, () => 0, async () => { state.searches++; return new Response(JSON.stringify({ skills: [{ id: 'example/review', name: 'review-skill', installs: 7, source: 'example/review' }] })); });
}
async function drain(w: SpecWorld) { const runner = driver(w); for (let n = 0; n < 20; n++) if (!(await runner.runOne(w.h.room, w.h.task))) return; assert.fail('模型请求未在有限步骤内结算'); }

Given('使用 OpenCode 兼容服务且任务具有稳定会话身份', function (this: SpecWorld) { model(this, true); });
When('同一任务依次执行负责人、协助、检查和恢复请求', async function (this: SpecWorld) { const first = driver(this); await first.runOne(this.h.room, this.h.task); await first.runOne(this.h.room, this.h.task); this.h.engine = new TeamEngine(this.h.store, this.h.config, () => 0); this.h.engine.recover(this.h.room); await drain(this); });
Then('所有请求应携带相同的哈希会话头与应用 User-Agent', function (this: SpecWorld) { assert.equal(m(this).requests.length, 4); const expected = createHash('sha256').update(this.h.task).digest('hex'); for (const request of m(this).requests) { assert.equal(request.headers.get('x-opencode-session'), expected); assert.equal(request.headers.get('user-agent'), 'squad-bots/0.1.0'); } });
Then('不应将原始会话身份放入请求头', function (this: SpecWorld) { for (const request of m(this).requests) assert(!JSON.stringify([...request.headers]).includes(this.h.task)); });
Given('供应商返回 HTTP 400 且包含错误代码与敏感回显', function (this: SpecWorld) { model(this, true); m(this).status = 400; });
When('模型适配器处理失败', async function (this: SpecWorld) { await drain(this); });
Then('应保留 MissingSessionID 与缺少会话头的提示', function (this: SpecWorld) { assert(this.h.context().reason.includes('MissingSessionID')); assert(this.h.context().reason.includes('x-opencode-session')); });
Then('错误记录不应包含凭据或供应商原始错误消息', function (this: SpecWorld) { const snapshot = JSON.stringify(this.h.context()); assert(!snapshot.includes(m(this).secret)); assert(!snapshot.includes('sensitive echo')); });
Given('模型请求的瞬态重试上限为 {int} 次', function (this: SpecWorld, limit: number) { model(this, false, limit); });
When('供应商持续返回 HTTP {int}', async function (this: SpecWorld, status: number) { m(this).status = status; await drain(this); });
Then('实际模型请求次数应为 {int} 且最终等待用户', function (this: SpecWorld, count: number) { assert.equal(m(this).requests.length, count); assert.equal(this.h.view().phase, 'waitingHuman'); });
Given('模型先请求搜索技能再返回答案', function (this: SpecWorld) { model(this); m(this).response = 'skills'; });
When('通过执行器完成该工作', async function (this: SpecWorld) { await driver(this).runOne(this.h.room, this.h.task); });
Then('模型请求、技能搜索和后续模型请求应分别计费于普通额度', function (this: SpecWorld) { assert.equal(m(this).requests.length, 2); assert.equal(m(this).searches, 1); assert.equal(this.h.context().usage.ordinary, 3); });
Then('搜索结果应作为资料返回且不安装技能', function (this: SpecWorld) { assert(JSON.stringify(m(this).requests[1]!.body).includes('review-skill')); assert(!this.h.context().intents.some(work => work.kind === 'tool')); });
Given('供应商返回被截断的结构化输出', function (this: SpecWorld) { model(this); m(this).response = 'truncated'; });
When('通过执行器处理该工作', async function (this: SpecWorld) { await driver(this).runOne(this.h.room, this.h.task); });
Then('应等待用户且不发布成功结果', function (this: SpecWorld) { assert.equal(this.h.view().phase, 'waitingHuman'); assert.equal(this.h.context().outcome, null); assert(!this.h.context().messages.some(message => message.kind === 'final')); });
Given('模型 HTTP 请求仍在等待响应', async function (this: SpecWorld) {
  model(this); let notify!: () => void; m(this).started = new Promise<void>(resolve => { notify = resolve; });
  m(this).transport = async (_url, init) => new Promise<Response>((_resolve, reject) => { const signal = init!.signal!; signal.addEventListener('abort', () => { m(this).aborted = true; reject(new Error('cancelled')); }, { once: true }); notify(); });
  m(this).runner = driver(this); m(this).running = m(this).runner!.runOne(this.h.room, this.h.task); await m(this).started;
});
When('用户停止该任务', async function (this: SpecWorld) { this.h.event({ type: 'STOP' }); await m(this).runner!.runOne(this.h.room, this.h.task); await m(this).running; });
Then('HTTP 请求应收到取消信号且不得发布迟到结果', function (this: SpecWorld) { assert(m(this).aborted); assert.equal(this.h.context().outcome, 'stopped'); assert(!this.h.context().messages.some(message => message.kind === 'final')); });

const markdown = new WeakMap<SpecWorld, { text: string; html?: string }>();
const md = (w: SpecWorld) => { const value = markdown.get(w); assert(value); return value; };
Given('群消息包含{string}格式的 Markdown', function (this: SpecWorld, format: string) { markdown.set(this, { text: ({ 标题列表和引用: '# 方案\n\n**重点**\n\n> 依据\n\n1. 验证恢复', 表格和任务清单: '| 成员 | 工作 |\n| --- | --- |\n| A | 方案 |\n\n- [x] 已完成\n- [ ] 待验证\n\n~~旧方案~~', 普通换行: '第一行\n第二行' } as Record<string, string>)[format]! }); });
When('渲染该消息', function (this: SpecWorld) { md(this).html = renderToStaticMarkup(createElement(MessageText, { text: md(this).text, agents: this.h.config.bots.map(bot => ({ ...bot, model: null })), onAgent() {} })); });
Then('应生成对应的{string}且保留正文内容', function (this: SpecWorld, structure: string) { const html = md(this).html!; const expected = ({ 标题列表引用节点: ['<h1>方案</h1>', '<strong>重点</strong>', '<blockquote>', '<ol>', '验证恢复'], 'GFM 表格与复选框': ['<table>', '<th>成员</th>', 'type="checkbox"', 'checked=""', '<del>旧方案</del>'], 段内换行: ['第一行<br/>', '第二行'] } as Record<string, string[]>)[structure]!; for (const text of expected) assert(html.includes(text), text); });
Given('消息同时包含成员正文点名、代码点名、邮件地址和已有链接', function (this: SpecWorld) { markdown.set(this, { text: '@A **@B** @unknown mail@A.com [@A](https://example.com)\n\n`@A`\n\n```ts\n  const member = "@B";\n```' }); });
Then('只有正文中已知成员的点名应成为过程入口按钮', function (this: SpecWorld) { assert.equal(md(this).html!.match(/<button/g)?.length, 2); });
Then('代码缩进、邮件地址、未知成员和已有链接应保留原意', function (this: SpecWorld) { for (const text of ['<code>@A</code>', '  const member', '@unknown', 'mailto:mail@A.com', 'href="https://example.com" target="_blank"']) assert(md(this).html!.includes(text), text); });
Given('消息包含原始脚本、带事件属性的 HTML 和可执行 URL', function (this: SpecWorld) { markdown.set(this, { text: '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[恶意链接](javascript:alert%281%29)\n\n![图片](https://example.com/image.png)' }); });
Then('不应输出脚本、事件处理器或可执行 URL', function (this: SpecWorld) { for (const text of ['<script', 'onerror', 'javascript:']) assert(!md(this).html!.includes(text)); });
Then('合法图片应保留且延迟加载', function (this: SpecWorld) { assert(md(this).html!.includes('https://example.com/image.png')); assert(md(this).html!.includes('loading="lazy"')); });
Given('消息包含脚注引用和对应注释', function (this: SpecWorld) { markdown.set(this, { text: '结论[^source]\n\n[^source]: 依据说明' }); });
Then('应保留脚注目标与返回引用的链接', function (this: SpecWorld) { assert(md(this).html!.includes('href="#user-content-fn-source"')); assert(md(this).html!.includes('href="#user-content-fnref-source"')); });
Then('消息内跳转不应另开窗口', function (this: SpecWorld) { assert(!md(this).html!.includes('target="_blank"')); });
