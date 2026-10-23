import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Given, When, Then } from '@cucumber/cucumber';
import { Tooltip } from '@base-ui/react/tooltip';
import type { RoomSnapshot, WebTask } from '../../src/web/contracts.js';
import type { useWorkspace } from '../../web/src/api.js';
import { Workspace } from '../../web/src/App.js';
import { Details } from '../../web/src/Details.js';
import { configuration } from '../helpers.js';
import type { SpecWorld } from './steps.js';

interface ViewState {
  mode: string; workspace: ReturnType<typeof useWorkspace>; snapshot: RoomSnapshot; html: string;
}
const views = new WeakMap<SpecWorld, ViewState>();
function view(world: SpecWorld) { const value = views.get(world); assert(value); return value; }
function prepare(world: SpecWorld, mode: string) {
  const room = { id: 'room1', title: '恢复方案', createdAt: 0 };
  const task: WebTask = {
    id: 'task1', goal: '验证恢复方案', owner: 'A', phase: mode === '等待回复' ? 'waitingHuman' : 'running',
    outcome: null, reason: '等待补充版本范围', usage: { ordinary: 3, checks: 1 }, limits: { ordinary: 300, checks: 30 },
    artifacts: [], board: [], trace: [],
  };
  const empty = mode === '空群' || mode === '成员空记录' || mode === '成员离线';
  const snapshot: RoomSnapshot = {
    room, agents: configuration().bots.map(bot => ({ ...bot, model: 'test-model' })),
    messages: empty ? [] : [{ id: 'M1', taskId: task.id, kind: 'user', author: 'user', text: task.goal, at: 0 }],
    tasks: empty ? [] : [task], activeTaskId: empty ? null : task.id,
    works: [], events: [], modelConfigured: true, serverTime: 0,
  };
  const workspace: ReturnType<typeof useWorkspace> = {
    rooms: [room], roomId: room.id, snapshot, connected: mode !== '离线' && mode !== '成员离线',
    error: mode === '发送失败' ? '发送失败，请稍后重试。' : '',
    setError() {}, chooseRoom() {}, createRoom: async () => room.id, refreshRooms: async () => [room],
  };
  const value = { mode, workspace, snapshot, html: '' }; views.set(world, value); return value;
}
function button(html: string, className: string) {
  const match = html.match(new RegExp(`<button\\b[^>]*class="${className}"[^>]*>[\\s\\S]*?</button>`));
  assert(match, `缺少 ${className} 按钮`); return match[0];
}

Given('群聊界面处于{string}', function (this: SpecWorld, mode: string) { prepare(this, mode); });
When('渲染精简后的群聊界面', function (this: SpecWorld) {
  const s = view(this); s.html = renderToStaticMarkup(createElement(Workspace, { workspace: s.workspace }));
});
Then('页面应保留群聊导航、成员入口和消息操作的可访问名称', function (this: SpecWorld) {
  const html = view(this).html;
  for (const name of ['群聊列表', '群聊消息', '群聊消息输入框', '发送消息', '查看方案师的执行过程', '查看任务详情']) {
    assert(html.includes(`aria-label="${name}"`), name);
  }
  assert.match(button(html, 'new-chat'), /新建群聊/);
  assert.match(html, /点名成员/);
});
Then('不应重复展示工作区标签、宣传文案和成员职责副标题', function (this: SpecWorld) {
  const html = view(this).html;
  for (const text of ['WORKSPACE', '我的协作空间', '我的工作区', '本地工作区', '每一位成员，过程可见',
    '和你的 Agent 团队一起', '按需协作，各司其职', 'A LITTLE TEAM', '从一个问题，到一次完整交付',
    '点名一位成员，或者直接开始聊天', '共同思考，逐步交付', '由你的模型驱动', '规划 · 交付', '核查 · 验证', '实现 · 构建']) {
    assert(!html.includes(text), text);
  }
});
Then('当前状态的提示、操作限制和错误反馈应保持可见', function (this: SpecWorld) {
  const s = view(this), html = s.html;
  if (s.mode === '空群') {
    assert.match(html, /<h2>想一起完成什么？<\/h2>/);
    for (const action of ['制定方案', '核查想法', '拆解任务']) assert(html.includes(action));
    assert.match(html, /placeholder="发送消息，或 @ 点名一位成员…"/);
  } else if (s.mode === '离线') {
    assert.match(html, /连接中断/);
    assert.match(html, /role="status"[^>]*>[\s\S]*?暂时无法连接本地服务/);
    assert.match(html, /<textarea\b[^>]*disabled=""/);
    assert.match(button(html, 'new-chat'), /disabled=""/);
    assert.match(button(html, 'stop-button'), /disabled=""/);
  } else {
    assert.match(html, /已连接/);
    assert(!/<textarea\b[^>]*disabled=""/.test(html));
    assert.match(button(html, 'stop-button'), /停止/);
    if (s.mode === '等待回复') {
      assert.match(html, /等待你的回复/);
      assert.match(html, /placeholder="回复成员，帮助团队继续…"/);
    } else {
      assert.match(html, /正在执行/);
      assert.match(html, /placeholder="补充当前工作…"/);
    }
    if (s.mode === '发送失败') assert.match(html, /role="alert"[^>]*>[\s\S]*?发送失败，请稍后重试。/);
  }
});

Given('群聊中已有成员的交付消息', function (this: SpecWorld) {
  const s = prepare(this, '已交付');
  s.snapshot.messages.push({ id: 'M2', taskId: 'task1', kind: 'final', author: 'A', text: '已完成恢复方案。', at: 1 });
  s.snapshot.tasks[0]!.phase = 'ended'; s.snapshot.tasks[0]!.outcome = 'complete'; s.snapshot.activeTaskId = null;
});
Then('作者和头像应保留可访问的执行过程入口及作者处的展开图标', function (this: SpecWorld) {
  const html = view(this).html;
  for (const name of ['author-button', 'message-avatar-button']) {
    assert.match(button(html, name), /aria-label="查看方案师的执行过程"/);
  }
  assert.match(button(html, 'author-button'), /方案师/);
  assert.match(button(html, 'author-button'), /<svg[^>]*lucide-chevron-right/);
});
Then('消息应保留正文和交付标记并移除重复的 AGENT 标签与底部过程按钮', function (this: SpecWorld) {
  const html = view(this).html;
  assert(html.includes('已完成恢复方案。'));
  assert.match(html, /class="delivery-label"[^>]*>[\s\S]*?交付/);
  assert(!html.includes('>AGENT<'));
  assert(!html.includes('view-process'));
});

Given('查看{string}详情', function (this: SpecWorld, mode: string) { prepare(this, mode); });
When('渲染精简后的详情面板', function (this: SpecWorld) {
  const s = view(this);
  s.html = renderToStaticMarkup(createElement(Tooltip.Provider, {}, createElement(Details, {
    snapshot: s.snapshot, agent: s.mode === '任务空产物' ? null : s.snapshot.agents[0]!,
    connected: s.workspace.connected, onClose() {},
  })));
});
Then('空状态不应附带重复的使用说明或自动同步文案', function (this: SpecWorld) {
  for (const text of ['执行过程会显示在这里', '成员交付的文件会保存在这里', '执行记录自动同步', '当前任务']) {
    assert(!view(this).html.includes(text), text);
  }
});
Then('详情的必要身份、状态、预算或离线提示应保留', function (this: SpecWorld) {
  const s = view(this);
  assert(s.html.includes('aria-label="关闭详情"'));
  if (s.mode === '任务空产物') {
    for (const text of ['验证恢复方案', '暂无产物', '负责人', '方案师', '执行请求', '3 / 300', '交付检查', '1 / 30', '等待补充版本范围']) {
      assert(s.html.includes(text), text);
    }
  } else {
    for (const text of ['方案师', '还没有执行记录', 'test-model', s.snapshot.agents[0]!.instructions]) assert(s.html.includes(text), text);
    if (s.mode === '成员离线') assert.match(s.html, /role="status">连接中断，等待重新连接/);
    else { assert(s.html.includes('空闲')); assert(!s.html.includes('class="detail-foot"')); }
  }
});
