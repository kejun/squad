import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Given, When, Then } from '@cucumber/cucumber';
import type { RoomSnapshot } from '../../src/web/contracts.js';
import type { Message, TaskContext } from '../../src/types.js';
import { conversationHistory } from '../../src/conversation.js';
import { artifactsForAgent, hasMessageDetails, messageArtifacts, ResultLinks, canReferenceArtifact } from '../../web/src/ResultLinks.js';
import { Details } from '../../web/src/Details.js';
import { Workspace } from '../../web/src/App.js';
import type { useWorkspace } from '../../web/src/api.js';
import { renderReportDetails, reportUiSnapshot } from '../artifact-ui-contract-fixture.js';
import { Harness } from '../helpers.js';
import type { SpecWorld } from './steps.js';

interface State { snapshot?: RoomSnapshot; html?: string; variant?: string; message?: Message; details?: boolean; reports?: string[][];
  referenceAvailable?: boolean; context?: TaskContext; history?: ReturnType<typeof conversationHistory>; target?: { taskId: string; messageId?: string; artifactId?: string } }
const states = new WeakMap<SpecWorld, State>();
function state(world: SpecWorld) { const value = states.get(world); assert(value); return value; }
const markdown = '# 完整报告\n\n[依据](https://example.com/evidence)\n\n<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))';
const htmlCode = '<!doctype html><html><script>alert(1)</script><body>完整代码</body></html>';

Given('历史消息同时引用本任务报告其他任务报告和不存在的报告', function (this: SpecWorld) { states.set(this, { snapshot: reportUiSnapshot() }); });
When('展示这条消息的报告入口', function (this: SpecWorld) {
  const s = state(this), snapshot = s.snapshot!, message = snapshot.messages[0]!;
  assert.deepEqual(messageArtifacts(snapshot, message).map(item => item.id), ['report']);
  s.html = renderToStaticMarkup(createElement(ResultLinks, { snapshot, message, onOpen() {} }));
});
Then('应只提供本任务中真实存在的报告入口', function (this: SpecWorld) { const html = state(this).html!; assert(html.includes('核查报告.md')); assert(!html.includes('其他报告.md')); assert(!html.includes('missing')); });

Given('历史详情的定位情况为{string}', function (this: SpecWorld, variant: string) {
  const targets: Record<string, State['target']> = { 任务不存在: { taskId: 'gone' }, 报告属于其他任务: { taskId: 'old', artifactId: 'foreign' }, 消息不存在: { taskId: 'old', messageId: 'gone' } };
  const target = targets[variant]; assert(target); states.set(this, { snapshot: reportUiSnapshot(), target });
});
When('按该定位打开历史详情', function (this: SpecWorld) { const s = state(this); s.html = renderReportDetails(s.snapshot!, s.target!); });
Then('应显示内容不可用且不展示其他任务或原报告正文', function (this: SpecWorld) { const html = state(this).html!; assert(html.includes('内容已不可用')); assert(!html.includes('新任务不得串入')); assert(!html.includes('旧报告独有正文。')); });

Given('历史回答为{string}且没有附带报告', function (this: SpecWorld, variant: string) {
  assert(variant === '简短回答' || variant === '旧协议长回答'); const snapshot = reportUiSnapshot(); snapshot.tasks[0]!.artifacts = [];
  const message: Message = { id: 'reply', taskId: 'old', kind: 'answer', author: 'A', text: variant === '简短回答' ? '可以。' : '这是旧消息的完整内容。'.repeat(90), at: 0 };
  snapshot.messages.push(message); states.set(this, { snapshot, message });
});
When('展示该历史回答的详情入口', function (this: SpecWorld) { const s = state(this); s.details = hasMessageDetails(s.snapshot!, s.message!); s.html = renderToStaticMarkup(createElement(ResultLinks, { snapshot: s.snapshot!, message: s.message!, onOpen() {} })); });
Then('详情入口应为{string}且可用时保留完整正文', function (this: SpecWorld, expected: string) {
  const s = state(this); assert(expected === '不显示' || expected === '可查看'); assert.equal(s.details, expected === '可查看');
  if (expected === '不显示') assert.equal(s.html, '');
  else assert(renderReportDetails(s.snapshot!, { taskId: 'old', messageId: s.message!.id }).includes(s.message!.text));
});

Given('负责人为A而已保存报告作者为B', function (this: SpecWorld) { states.set(this, { snapshot: reportUiSnapshot() }); });
When('汇集两名成员各自的报告', function (this: SpecWorld) { const s = state(this); s.reports = ['B', 'A'].map(id => artifactsForAgent(s.snapshot!, id).map(item => item.id)); });
Then('B应看到该报告而A不应被列为作者', function (this: SpecWorld) { assert.deepEqual(state(this).reports, [['report'], []]); });

Given('已保存的报告内容类型为{string}', function (this: SpecWorld, variant: string) {
  assert(variant === 'Markdown含链接和嵌入脚本' || variant === 'HTML代码文件'); const snapshot = reportUiSnapshot(), report = snapshot.tasks[0]!.artifacts[0]!;
  report.name = variant === 'HTML代码文件' ? 'demo.html' : 'report.md'; report.content = variant === 'HTML代码文件' ? htmlCode : markdown;
  states.set(this, { snapshot });
});
When('打开该报告的完整详情', function (this: SpecWorld) { const s = state(this); s.html = renderReportDetails(s.snapshot!, { taskId: 'old', artifactId: 'report' }); });
Then('应按{string}展示完整正文且保留导出入口', function (this: SpecWorld, expected: string) {
  const html = state(this).html!; assert(html.includes('aria-label="导出详情"')); assert(!html.includes('<script>')); assert(!html.includes('href="javascript:'));
  if (expected === '安全Markdown') { assert(html.includes('<h1>完整报告</h1>')); assert(html.includes('href="https://example.com/evidence"')); }
  else { assert.equal(expected, '字面源码'); assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert(html.includes('&lt;body&gt;完整代码&lt;/body&gt;')); }
});

Given('一个已结束任务仅部分交付且消息含完整报告详情', function (this: SpecWorld) { const snapshot = reportUiSnapshot(); snapshot.tasks[0]!.outcome = 'partial'; snapshot.messages[0]!.kind = 'final'; states.set(this, { snapshot }); });
When('展示任务工作区', function (this: SpecWorld) {
  const s = state(this), snapshot = s.snapshot!;
  const workspace: ReturnType<typeof useWorkspace> = { rooms: [snapshot.room], roomId: snapshot.room.id, snapshot, connected: true, error: '', setError() {}, chooseRoom() {}, createRoom: async () => snapshot.room.id, setRoomArchived: async () => { throw new Error('Unexpected archive action'); }, refreshRooms: async () => [snapshot.room] };
  s.html = renderToStaticMarkup(createElement(Workspace, { workspace }));
});
Then('应标明部分交付而不是成功完成且不展开完整正文', function (this: SpecWorld) { const html = state(this).html!; assert(html.includes('部分交付')); assert(!html.match(/class="delivery-label"[^>]*>([\s\S]*?)<\/span>/)?.[1]?.includes('lucide-check')); assert(!html.includes('完整核查结果。')); assert(!html.includes('旧报告独有正文。')); });

Given('历史消息摘要很短但保留的完整正文超过上下文预算', function (this: SpecWorld) {
  const harness = new Harness(), context = harness.context();
  context.messages.push({ id: 'oversized-detail', taskId: context.taskId, kind: 'answer', author: 'A', at: 1, text: '短摘要', detailText: '完整资料'.repeat(25_000) });
  harness.store.close(); states.set(this, { context });
});
When('准备供新任务使用的历史上下文', function (this: SpecWorld) { const s = state(this); s.history = conversationHistory([s.context!]); });
Then('应标明截断并排除超预算消息且不改变保存的完整正文', function (this: SpecWorld) {
  const s = state(this), history = s.history!; assert.equal(history.truncated, true); assert(!history.messages.some(message => message.id === 'oversized-detail'));
  const total = history.messages.reduce((size, message) => size + message.text.length + (message.detailText?.length ?? 0), 0) + history.artifacts.reduce((size, artifact) => size + artifact.content.length, 0);
  assert(total <= 96_000); assert.equal(s.context!.messages.at(-1)!.detailText!.length, 100_000);
});

Given('旧成功任务的Markdown报告发布清单为{string}', function (this: SpecWorld, publication: string) {
  const snapshot = reportUiSnapshot();
  assert.equal(snapshot.tasks[0]!.phase, 'ended'); assert.equal(snapshot.tasks[0]!.outcome, 'complete');
  if (publication === '已确认清单包含该报告') snapshot.tasks[0]!.currentArtifactIds = ['report'];
  else { assert.equal(publication, '旧快照没有发布清单'); assert.equal(snapshot.tasks[0]!.currentArtifactIds, undefined); }
  states.set(this, { snapshot });
});
When('用户打开这份旧Markdown报告预览', function (this: SpecWorld) {
  const s = state(this), task = s.snapshot!.tasks[0]!;
  s.referenceAvailable = canReferenceArtifact(task, task.artifacts[0]!);
  s.html = renderToStaticMarkup(createElement(Details, { snapshot: s.snapshot!, target: { taskId: task.id, artifactId: 'report' }, agent: null, connected: true, onClose() {}, onReference() {} }));
});
Then('这份报告的引用到新任务能力应为{string}', function (this: SpecWorld, expected: string) {
  assert(expected === '可用' || expected === '不可用');
  const s = state(this), available = expected === '可用';
  assert.equal(s.referenceAvailable, available);
  assert.equal(s.html!.includes('aria-label="引用到新任务"'), available);
  assert(s.html!.includes('旧报告独有正文。'));
});
