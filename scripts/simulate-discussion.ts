import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { debugInput, taskGraph, TaskSandbox } from '../src/task-debug.js';
import { persistTask, restoreTask, stepTask, workLaneAvailable, type TaskSnapshot } from '../src/task.machine.js';
import type { Intent, TaskContext, TaskEvent } from '../src/types.js';

export interface SimulationFrame {
  event: Record<string, unknown>; phase: string; discussion: string | null; reply: string;
  completed: string[]; inflight: string[]; pending: string[];
  usage: TaskContext['usage']; outcome: string | null; epoch: number; goalVersion: number;
}
export interface SimulationCase {
  name: string; category: string; passed: boolean; error?: string; frames: SimulationFrame[];
}
export interface SimulationReport { cases: SimulationCase[]; total: number; passed: number; failed: number; responseOrders: number; eventSteps: number; states: string[]; totalStates: number }
type SimulationEvent = Record<string, unknown> & { type: TaskEvent['type'] };
const reviewers = ['B', 'builder-1', 'builder-2', 'builder-3'];

/** Every event runs the production XState conversion; the harness starts no executor or network. */
class Simulation {
  private current: TaskSnapshot;
  frames: SimulationFrame[] = [];
  sequence = 0;
  at = 0;
  constructor(ordinary = 30, assists = 5, analysis = false) {
    const input = debugInput();
    input.config.bots.push(...reviewers.slice(1).map(id => ({ id, name: id, instructions: '提供独立建议', tools: [] })));
    input.config.limits.ordinary = ordinary; input.config.limits.assists = assists;
    if (analysis) {
      input.config.inputAnalysis = { enabled: true };
      input.config.models = { default: 'simulation', services: { simulation: { baseUrl: 'http://127.0.0.1:9/v1', model: 'never-called' } } };
      input.message.text = '请制定方案，必须核对依据和恢复条件';
    }
    this.current = TaskSandbox.fromInput(JSON.stringify(input)).snapshot;
  }
  get c() { return this.current.context; }
  get phase() { return String(this.current.value); }
  send(body: SimulationEvent, expected = 'OK') {
    this.at = Math.max(this.at + 1, typeof body.at === 'number' ? body.at : 0);
    const event: SimulationEvent & { id: string; at: number } = { id: `simulation:${++this.sequence}`, ...body, at: this.at };
    const next = stepTask(this.current, event as TaskEvent);
    this.current = next;
    const c = next.context;
    this.frames.push({ event, phase: String(next.value), discussion: c.discussion?.status ?? null, reply: c.reply.code,
      completed: c.discussion?.results.map(result => result.target) ?? [],
      inflight: c.intents.filter(work => work.status === 'inflight').map(work => `${work.kind}:${work.target}:${work.id}`),
      pending: c.intents.filter(work => work.status === 'pending').map(work => `${work.kind}:${work.target}:${work.id}`),
      usage: structuredClone(c.usage), outcome: c.outcome, epoch: c.epoch, goalVersion: c.goalVersion });
    assert.equal(c.reply.code, expected, `${event.type}: ${c.reply.code} instead of ${expected}`);
    this.invariants();
    return next;
  }
  invariants() {
    const c = this.c;
    const inflight = c.intents.filter(work => work.kind !== 'cancel' && work.status === 'inflight');
    assert.equal(new Set(inflight.map(work => work.target)).size, inflight.length, '同一成员不能同时执行两份工作');
    assert(inflight.filter(work => !work.discussionId).length <= 1, '主工作不能并发改写');
    for (const bucket of ['ordinary', 'checks', 'assists', 'retries', 'replans'] as const)
      assert(c.usage[bucket] >= 0 && c.usage[bucket] <= c.config.limits[bucket], `${bucket} 超额`);
    if (c.discussion && !['delivered', 'cancelled'].includes(c.discussion.status)) {
      assert(!c.messages.some(message => message.kind === 'final'), '讨论交接前不得发布最终结果');
      assert(!c.intents.some(work => work.kind === 'check' && ['pending', 'inflight'].includes(work.status)), '讨论交接前不得检查旧草稿');
    }
    if (c.stopped) assert(!c.intents.some(work => work.kind !== 'cancel' && work.status === 'pending'), '停止后不能派发业务工作');
    assert.equal(new Set(c.discussion?.results.map(result => result.target)).size, c.discussion?.results.length ?? 0, '成员意见不能重复消费');
  }
  work(kind: Intent['kind'], target?: string, discussion = false, status = 'pending') {
    const work = this.c.intents.find(work => work.kind === kind && (!target || work.target === target)
      && !!work.discussionId === discussion && work.status === status);
    assert(work, `缺少 ${kind}:${target ?? '*'}:${status}`); return work;
  }
  claim(work: Intent) { this.send({ type: 'CLAIM', intentId: work.id }); return this.c.intents.find(item => item.id === work.id)!; }
  envelope(work: Intent) { return { workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, ...(work.discussionId ? { discussionId: work.discussionId } : {}) }; }
  start() { return this.claim(this.work('owner')); }
  invite() { this.send({ type: 'USER_INPUT', text: '所有人都参与讨论一下', reviewTargets: reviewers }); }
  plan() {
    const work = this.claim(this.work('facilitator', undefined, true));
    this.send({ type: 'DISCUSSION_PLAN', ...this.envelope(work), decision: { action: 'review', question: '讨论风险与替代方案', expected: '独立意见与依据', reason: '直接用户邀请' } });
  }
  members() { return this.c.intents.filter(work => work.discussionId === this.c.discussion?.id && work.kind === 'assistance' && work.status === 'pending').map(work => this.claim(work)); }
  result(work: Intent) { this.send({ type: 'DISCUSSION_RESULT', ...this.envelope(work), text: `${work.target} 的完整意见与依据`, status: 'success' }); }
  draft() { const work = this.work('owner', undefined, false, 'inflight'); this.send({ type: 'DELIVER', ...this.envelope(work), text: '已保存的方案师草稿', artifactIds: [] }); }
  summary() { const work = this.claim(this.work('discussionSummary', undefined, true)); this.result(work); }
  finish(expected: 'complete' | 'partial' = 'complete') {
    for (let n = 0; n < 24 && this.c.outcome === null; n++) {
      const available = this.c.intents.find(work => work.status === 'pending' && work.kind !== 'cancel' && workLaneAvailable(this.c, work));
      assert(available, `任务无法继续：${this.phase}/${this.c.discussion?.status}`);
      if (available.discussionId && available.kind === 'facilitator') { this.plan(); continue; }
      const work = this.claim(available);
      if (work.discussionId) this.result(work);
      else if (work.kind === 'owner') this.send({ type: 'DELIVER', ...this.envelope(work), text: '吸收讨论并完善后的方案', artifactIds: [] });
      else if (work.kind === 'check') this.send({ type: 'CHECK_RESULT', ...this.envelope(work), resultId: `check:${this.sequence}`, passed: true, gaps: [] });
      else assert.fail('意外的主工作：' + work.kind);
    }
    assert.equal(this.c.outcome, expected);
    assert.equal(this.c.messages.filter(message => message.kind === 'final').length, 1);
  }
  prepare(stage: string) {
    this.start(); this.invite();
    if (stage === 'planning') return;
    this.plan(); const members = this.members();
    if (stage === 'collecting') return;
    if (stage === 'one-result') { this.result(members[0]!); return; }
    members.forEach(work => this.result(work));
    if (stage === 'summarizing') return;
    this.summary(); assert.equal(this.c.discussion?.status, 'ready');
  }
  settle() { for (const work of this.c.intents.filter(work => work.kind !== 'cancel' && work.status === 'inflight')) this.send({ type: 'SETTLE', intentId: work.id }); }
  restore() { this.current = restoreTask(structuredClone(persistTask(this.current))); }
}

function* permutations(values: string[]): Generator<string[]> {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++) for (const rest of permutations(values.filter((_, index) => index !== i))) yield [values[i]!, ...rest];
}

export function runDiscussionSimulations(responseOrdersOnly = false): SimulationReport {
  const cases: SimulationCase[] = [];
  const run = (name: string, category: string, action: (s: Simulation) => void, ordinary = 30, assists = 5, analysis = false) => {
    const s = new Simulation(ordinary, assists, analysis);
    try { action(s); cases.push({ name, category, passed: true, frames: s.frames }); }
    catch (error) { cases.push({ name, category, passed: false, error: error instanceof Error ? error.message : String(error), frames: s.frames }); }
  };
  let responseOrders = 0;
  for (const order of permutations(['owner', ...reviewers, 'summary'])) {
    if (reviewers.some(target => order.indexOf(target) > order.indexOf('summary'))) continue;
    responseOrders++;
    run(order.join(' → '), '全部合法返回顺序', s => {
      s.start(); s.invite(); s.plan(); const members = s.members();
      for (const item of order) {
        if (item === 'owner') s.draft();
        else if (item === 'summary') s.summary();
        else s.result(members.find(work => work.target === item)!);
      }
      assert.equal(s.c.discussion?.status, 'delivered'); assert.equal(s.c.discussion.results.length, 4);
      assert.equal(s.c.messages.filter(message => message.text.includes('讨论汇总及成员原始意见已交给')).length, 1);
      s.finish();
      assert.equal(s.c.intents.filter(work => work.kind === 'owner' && work.attempt > 0).length, 2);
      assert.equal(s.c.intents.filter(work => work.kind === 'check' && work.attempt > 0).length, 1);
    });
  }
  assert.equal(responseOrders, 144);
  if (!responseOrdersOnly) {
    for (const stage of ['planning', 'collecting', 'one-result', 'summarizing', 'ready']) {
      run(`停止：${stage}`, '停止与迟到结果', s => {
        s.prepare(stage);
        const old = s.c.intents.find(work => work.discussionId && work.status === 'inflight');
        s.send({ type: 'STOP' }); assert.equal(s.c.discussion?.status, 'cancelled');
        if (old) s.send({ type: 'DISCUSSION_RESULT', ...s.envelope(old), text: '停止后的迟到意见', status: 'success' }, 'STOPPED');
        s.settle(); assert.equal(s.c.outcome, 'stopped');
        assert(!s.c.messages.some(message => message.kind === 'final'));
      });
      run(`新目标：${stage}`, '目标版本隔离', s => {
        s.prepare(stage); const old = s.c.intents.find(work => work.discussionId && work.status === 'inflight');
        s.send({ type: 'USER_INPUT', text: '新增硬约束', goal: { ...s.c.goal, constraints: ['新硬约束'] } });
        if (old) s.send({ type: 'DISCUSSION_RESULT', ...s.envelope(old), text: '旧版本意见', status: 'success' }, 'STALE_FENCE');
        assert.equal(s.c.discussion?.status, 'cancelled'); s.settle(); s.finish(); assert.equal(s.c.goalVersion, 2);
      });
      run(`持久化恢复两次：${stage}`, '恢复与结果去重', s => {
        s.prepare(stage); const before = s.c.discussion!.results.map(result => result.target);
        s.restore();
        s.send({ type: 'RECOVER', config: s.c.config }); s.send({ type: 'RECOVER', config: s.c.config });
        assert.deepEqual(s.c.discussion?.results.map(result => result.target), before); s.finish();
        assert.equal(s.c.discussion?.results.length, 4);
      });
    }
    for (const error of ['missing-fence', 'wrong-round', 'stale-fence', 'owner-work']) run(error, '无效结果身份', s => {
      s.prepare('collecting'); const member = s.work('assistance', 'B', true, 'inflight'); const owner = s.work('owner', undefined, false, 'inflight');
      const envelope: Record<string, unknown> = s.envelope(member);
      if (error === 'missing-fence') delete envelope.fence;
      if (error === 'wrong-round') envelope.discussionId = 'wrong-round';
      if (error === 'stale-fence') envelope.fence = { epoch: 99, goalVersion: 99 };
      if (error === 'owner-work') envelope.workId = owner.id;
      s.send({ type: 'DISCUSSION_RESULT', ...envelope, text: '非法身份结果', status: 'success' }, error === 'wrong-round' ? 'STALE_DISCUSSION' : error === 'stale-fence' ? 'STALE_FENCE' : 'DISCUSSION_WORK_REQUIRED');
      assert.equal(s.c.intents.find(work => work.id === member.id)?.status, 'inflight');
      assert.equal(s.c.intents.find(work => work.id === owner.id)?.status, 'inflight');
      s.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight').forEach(work => s.result(work));
      s.summary(); s.draft(); s.finish();
    });
    for (const stage of ['facilitator', 'assistance', 'discussionSummary'] as const) run(`工作失败：${stage}`, '部分失败', s => {
      s.start(); s.invite();
      let work: Intent;
      if (stage === 'facilitator') work = s.claim(s.work(stage, undefined, true));
      else {
        s.plan(); const members = s.members();
        if (stage === 'assistance') { work = members[0]!; members.slice(1).forEach(item => s.result(item)); }
        else { members.forEach(item => s.result(item)); work = s.claim(s.work(stage, undefined, true)); }
      }
      s.send({ type: 'WORK_FAILED', intentId: work.id, reason: '模拟服务故障', transient: false });
      s.draft(); s.finish('partial'); assert(s.c.discussion?.incomplete);
    });
    for (const limit of [2, 3, 4, 5, 6, 7, 8, 9]) run(`普通预算 ${limit}`, '预算边界', s => {
      s.start(); s.invite(); s.draft(); s.finish(limit < 8 ? 'partial' : 'complete');
    }, limit);
    for (const limit of [0, 1, 2, 3, 4]) run(`协助预算 ${limit}`, '预算边界', s => {
      s.start(); s.invite(); s.draft(); s.finish(limit < 4 ? 'partial' : 'complete');
    }, 30, limit);
    for (const kind of ['facilitator', 'assistance', 'discussionSummary'] as const) run(`额外请求不能使用汇总预留：${kind}`, '预算边界', s => {
      let work: Intent;
      if (kind === 'facilitator') { s.start(); s.invite(); work = s.claim(s.work(kind, undefined, true)); }
      else {
        s.prepare(kind === 'assistance' ? 'collecting' : 'summarizing');
        work = kind === 'assistance' ? s.work(kind, 'B', true, 'inflight') : s.claim(s.work(kind, undefined, true));
      }
      s.send({ type: 'CONSUME', intentId: work.id });
      const used = s.c.usage.ordinary;
      s.send({ type: 'CONSUME', intentId: work.id }, 'DISCUSSION_BUDGET_RESERVED');
      assert.equal(s.c.usage.ordinary, used);
      s.send({ type: 'WORK_FAILED', intentId: work.id, reason: 'DISCUSSION_BUDGET_RESERVED', transient: false });
      if (kind === 'assistance') s.c.intents.filter(item => item.discussionId && item.kind === 'assistance' && item.status === 'inflight').forEach(item => s.result(item));
      s.draft(); s.finish('partial');
    }, kind === 'facilitator' ? 5 : 8);
    run('主工作追加请求后重新计算参与人数', '预算边界', s => {
      const owner = s.start(); s.send({ type: 'CONSUME', intentId: owner.id }); s.invite();
      s.send({ type: 'CONSUME', intentId: owner.id }); s.plan();
      const members = s.members(); assert.equal(members.length, 3); members.forEach(work => s.result(work));
      s.draft(); s.finish('partial'); assert.equal(s.c.usage.ordinary, 8);
    }, 8);
    run('协调员格式修正使用有限重试并保留交接', '格式修正', s => {
      s.start(); s.invite(); const work = s.claim(s.work('facilitator', undefined, true));
      s.send({ type: 'CONSUME', intentId: work.id });
      s.send({ type: 'REGENERATE_MODEL_OUTPUT', intentId: work.id, issue: 'invalid_json' });
      s.send({ type: 'CONSUME', intentId: work.id });
      s.send({ type: 'DISCUSSION_PLAN', ...s.envelope(work), decision: { action: 'review', question: '讨论风险', expected: '依据', reason: '修正后的有效协议' } });
      s.draft(); s.finish(); assert.equal(s.c.usage.retries, 1); assert.equal(s.c.usage.ordinary, 9);
    });
    run('重复邀请与重复结果', '去重与成员互斥', s => {
      s.start(); s.invite(); const id = s.c.discussion!.id; s.invite(); assert.equal(s.c.discussion?.id, id);
      s.plan(); const members = s.members(); const usage = s.c.usage.ordinary;
      s.send({ type: 'CLAIM', intentId: members[0]!.id }, 'WORK_NOT_PENDING'); assert.equal(s.c.usage.ordinary, usage);
      s.result(members[0]!); s.send({ type: 'DISCUSSION_RESULT', ...s.envelope(members[0]!), text: '重复意见', status: 'success' }, 'UNKNOWN_OR_SETTLED_WORK');
      members.slice(1).forEach(work => s.result(work)); s.summary(); s.draft(); s.finish();
    });
    run('成员期限到达', '超时与监督', s => {
      s.prepare('collecting'); s.draft();
      const members = s.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight');
      s.at = Math.max(...members.map(work => work.deadline!));
      for (const work of members) s.send({ type: 'WORK_FAILED', intentId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, reason: 'Tool or model deadline exceeded', transient: false });
      assert(s.c.discussion?.results.every(result => result.status === 'timeout')); s.finish('partial');
    });
    run('讨论期间不空转监督', '超时与监督', s => {
      s.prepare('collecting'); s.send({ type: 'TICK', at: s.c.nextCheckAt }, 'INVALID_STATE');
      s.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight').forEach(work => s.result(work));
      s.summary(); s.draft(); s.finish();
    });
    run('主工作报告阻塞', '负责人接续', s => {
      s.prepare('collecting'); const owner = s.work('owner', undefined, false, 'inflight');
      s.send({ type: 'BLOCKED', ...s.envelope(owner), reason: '需要独立意见' });
      s.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight').forEach(work => s.result(work));
      s.summary(); assert.equal(s.work('owner').payload.previousBlocker, '需要独立意见'); s.finish();
    });
    run('主工作等待用户时不擅自重开', '负责人接续', s => {
      s.prepare('collecting'); const owner = s.work('owner', undefined, false, 'inflight');
      s.send({ type: 'WAIT_USER', ...s.envelope(owner), question: '需要用户选择' });
      s.c.intents.filter(work => work.discussionId && work.kind === 'assistance' && work.status === 'inflight').forEach(work => s.result(work)); s.summary();
      assert.equal(s.phase, 'waitingHuman'); assert.equal(s.c.discussion?.status, 'ready'); assert.equal(s.c.outcome, null);
      assert(!s.c.intents.some(work => work.kind === 'owner' && work.status === 'pending'));
    });
    run('停止后明确继续', '停止与迟到结果', s => {
      s.prepare('collecting'); s.send({ type: 'STOP' }); s.settle();
      s.send({ type: 'CONTINUE' }); assert.equal(s.c.epoch, 2); assert.equal(s.c.discussion?.status, 'cancelled'); s.finish();
    });
    run('恢复时成员撤销', '恢复与结果去重', s => {
      s.prepare('collecting'); const config = structuredClone(s.c.config); config.bots = config.bots.filter(bot => bot.id !== 'builder-3');
      s.send({ type: 'RECOVER', config }, 'INCOMPATIBLE_EXECUTION');
      assert.equal(s.phase, 'waitingHuman'); assert.equal(s.c.discussion?.status, 'cancelled');
    });
    run('协调员返回无效安排', '部分失败', s => {
      s.start(); s.invite(); const work = s.claim(s.work('facilitator', undefined, true));
      s.send({ type: 'DISCUSSION_PLAN', ...s.envelope(work), decision: { action: 'continue', reason: '试图绕过讨论' } }, 'INVALID_DISCUSSION_PLAN');
      s.draft(); s.finish('partial');
    });
    run('核查员正在主流程协助时只邀请三位空闲成员', '成员占用与交接', s => {
      const owner = s.start();
      s.send({ type: 'HELP', ...s.envelope(owner), caller: 'A', target: 'B', requestId: 'busy-B', question: '核查资料', expected: '依据' });
      const busy = s.claim(s.work('assistance', 'B'));
      s.invite(); assert(s.c.discussion?.skipped.some(item => item.target === 'B'));
      s.plan(); const members = s.members(); assert.equal(members.length, 3); members.forEach(work => s.result(work)); s.summary();
      assert.equal(s.phase, 'waitingAssistance');
      s.send({ type: 'HELP_RESULT', ...s.envelope(busy), requestId: 'busy-B', resultId: 'busy-B-result', status: 'success', answer: '主流程核查依据' });
      s.finish('partial');
    });
    run('原监督与继续执行流程', '主流程兼容', s => {
      const owner = s.start(); s.send({ type: 'BLOCKED', ...s.envelope(owner), reason: '需要调整方法' });
      assert.equal(s.phase, 'coordinating'); const coordinator = s.claim(s.work('facilitator'));
      s.send({ type: 'COORDINATE', ...s.envelope(coordinator), decision: { action: 'continue', reason: '采用已有新依据' } });
      s.finish();
    });
    run('原输入解析与交付流程', '主流程兼容', s => {
      assert.equal(s.phase, 'interpreting'); const interpretation = s.claim(s.work('interpretation'));
      s.send({ type: 'INTERPRETATION_RESULT', ...s.envelope(interpretation), inputId: s.c.inputAnalyses![0]!.id,
        spec: { action: 'request', objective: s.c.goal.text, constraints: s.c.goal.constraints, expectedOutputs: ['方案'], acceptanceCriteria: s.c.goal.criteria, references: [], confidence: 1, clarification: null } });
      s.finish();
    }, 30, 5, true);
  }
  const passed = cases.filter(item => item.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, responseOrders, eventSteps: cases.reduce((sum, item) => sum + item.frames.length, 0),
    states: [...new Set(cases.flatMap(item => item.frames.map(frame => frame.phase)))].sort(), totalStates: taskGraph().states.length, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runDiscussionSimulations();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/discussion-simulation.json', JSON.stringify({ sha, dirty, ...report }, null, 2) + '\n');
  const categories = [...new Set(report.cases.map(item => item.category))].map(category => {
    const items = report.cases.filter(item => item.category === category);
    return `| ${category} | ${items.length} | ${items.filter(item => item.passed).length} |`;
  });
  writeFileSync('reports/discussion-simulation.md', `# XState 后台讨论仿真\n\n源码 ${sha}；工作区${dirty ? '有未提交变更' : '干净'}。\n\n执行 ${report.total} 个场景、${report.eventSteps} 个真实事件步，通过 ${report.passed}，失败 ${report.failed}。包括全部 ${report.responseOrders} 种因果合法的结果返回顺序，访问 ${report.states.length}/${report.totalStates} 个顶层状态。每个事件步调用真实 stepTask，可能包含多个内部 always 转移。\n\n| 场景 | 数量 | 通过 |\n| --- | --- | --- |\n${categories.join('\n')}\n\n边界：四位评审成员，协调员汇总在成员结算后返回；单条轨迹步骤与预算有界。使用真实 XState 纯转换和沙箱，不调用模型、网页工具或外部服务；不构成任意事件序列的形式证明。完整逐步轨迹见 discussion-simulation.json。\n`);
  console.log(JSON.stringify({ sha, dirty, total: report.total, passed: report.passed, failed: report.failed, responseOrders: report.responseOrders, eventSteps: report.eventSteps, states: report.states, totalStates: report.totalStates,
    failures: report.cases.filter(item => !item.passed).map(item => ({ name: item.name, category: item.category, error: item.error, last: item.frames.at(-1) })) }, null, 2));
  if (report.failed) process.exitCode = 1;
}
