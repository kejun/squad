import { describe, expect, it } from 'vitest';
import { chartEdges, chartStep, eventLabel, phaseLabel, ruleLabel } from '../src/task-chart.js';
import { debugEventTemplate, TaskSandbox, taskGraph, type DebugFrame } from '../src/task-debug.js';
import { persistTask } from '../src/task.machine.js';

const graph = taskGraph();
function send(sandbox: TaskSandbox, event: string): DebugFrame {
  sandbox.send(JSON.stringify(debugEventTemplate(sandbox.snapshot, event)));
  return sandbox.history.at(-1)!;
}

describe('statechart projection of the real task model', () => {
  it('[BT_V32] retains every running-to-coordinating event and ordered guard branch on one edge', () => {
    const edge = chartEdges(graph).find(item => item.source === 'running' && item.target === 'coordinating');

    expect(edge?.rules.map(rule => ({ event: rule.event, guard: rule.guards[0], order: rule.order }))).toEqual([
      { event: 'BLOCKED', guard: 'canCoordinate', order: 0 },
      { event: 'TICK', guard: 'shouldTick', order: 0 },
      { event: 'FAILURE_SIGNAL', guard: 'repeated', order: 0 },
      { event: '@always', guard: 'reviewReady', order: 1 },
      { event: '@always', guard: 'deferredReady', order: 2 },
    ]);
  });

  it('[BT_V34] focused edges preserve both directions and every branch for the selected state', () => {
    const edges = chartEdges(graph, 'waitingHuman');

    expect(edges.map(edge => [edge.source, edge.target])).toEqual([
      ['interpreting', 'waitingHuman'], ['running', 'waitingHuman'], ['waitingAssistance', 'waitingHuman'],
      ['coordinating', 'waitingHuman'], ['waitingHuman', 'running'], ['checking', 'waitingHuman'],
    ]);
    expect(edges.find(edge => edge.source === 'coordinating')?.rules.map(rule => rule.guards)).toEqual([
      ['decisionAsk'], ['isCurrent'], ['valid'],
    ]);
  });

  it('[BT_V34] retains global and internal rule access outside the cross-state overview', () => {
    const overview = chartEdges(graph);

    expect(overview.flatMap(edge => edge.rules).some(rule => rule.source === '*' || rule.target === null || rule.source === rule.target)).toBe(false);
    expect(graph.transitions).toContainEqual(expect.objectContaining({ source: '*', event: '@always', target: 'interpreting', guards: ['analysisReady'] }));
    expect(graph.transitions).toContainEqual(expect.objectContaining({ source: 'ended', event: 'CONTINUE', target: 'running', guards: ['valid'] }));
    expect(graph.transitions).toContainEqual(expect.objectContaining({ source: 'ended', event: 'STOP', target: null, actions: [] }));
  });

  it('[BT_V33] projects an accepted help step from the captured rules and microsteps', () => {
    const sandbox = new TaskSandbox();
    const frame = send(sandbox, 'HELP');

    const result = chartStep(graph, frame);

    expect(result.status).toBe('recorded');
    expect(result.steps.map(step => [step.from, step.phase, step.automatic])).toEqual([['running', 'waitingAssistance', false]]);
    expect(result.rules.map(rule => rule.id)).toEqual(['running:HELP:0']);
  });

  it('[BT_V33] preserves the stop automatic microstep without changing the execution head', () => {
    const sandbox = new TaskSandbox();
    const frame = send(sandbox, 'STOP');
    const before = persistTask(sandbox.snapshot), headId = sandbox.headId;

    const result = chartStep(graph, frame);

    expect(result.steps.map(step => [step.from, step.phase, step.automatic])).toEqual([
      ['running', 'stopping', false], ['stopping', 'ended', true],
    ]);
    expect(result.rules.map(rule => rule.id)).toEqual(['*:STOP:0', 'stopping:@always:0']);
    expect(persistTask(sandbox.snapshot)).toEqual(before);
    expect(sandbox.headId).toBe(headId);
  });

  it('[BT_V33] displays a rejected help request without inventing a move to waiting assistance', () => {
    const sandbox = new TaskSandbox();
    const event = { ...debugEventTemplate(sandbox.snapshot, 'HELP'), target: 'A' };
    sandbox.send(JSON.stringify(event));

    const result = chartStep(graph, sandbox.history.at(-1)!);

    expect(sandbox.snapshot.context.reply.code).toBe('SELF_DEPENDENCY');
    expect(result.steps.map(step => [step.from, step.phase])).toEqual([['running', 'running']]);
    expect(result.rules.map(rule => rule.id)).toEqual(['*:*:0']);
  });

  it('[BT_V33] represents a repeated stop as empty local handling without the global stop path', () => {
    const sandbox = new TaskSandbox();
    send(sandbox, 'STOP');
    const frame = send(sandbox, 'STOP');

    const result = chartStep(graph, frame);

    expect(result.steps.map(step => [step.from, step.phase, step.changed])).toEqual([['ended', 'ended', []]]);
    expect(result.rules.map(rule => rule.id)).toEqual(['ended:STOP:0']);
    expect(result.rules[0]?.actions).toEqual([]);
  });

  it('[BT_V34] keeps ended resumable and reports the captured continue rule', () => {
    const sandbox = new TaskSandbox();
    send(sandbox, 'STOP');
    const frame = send(sandbox, 'CONTINUE');

    const result = chartStep(graph, frame);

    expect(result.steps.map(step => [step.from, step.phase])).toEqual([['ended', 'running']]);
    expect(result.rules.map(rule => rule.id)).toEqual(['ended:CONTINUE:0']);
  });

  it('[BT_V35] shows no captured path for a legacy record without diagnostic evidence', () => {
    const sandbox = new TaskSandbox();
    const { evidence: omitted, ...legacy } = send(sandbox, 'HELP');

    const result = chartStep(graph, legacy);

    expect(result).toEqual({ status: 'missing', note: '此记录未采集', steps: [], rules: [] });
  });

  it('[BT_V35] shows no captured path when the machine structure fingerprint differs', () => {
    const sandbox = new TaskSandbox();
    const frame = send(sandbox, 'HELP');
    const oldFrame = { ...frame, evidence: { ...frame.evidence!, definition: 'old-definition' } };

    const result = chartStep(graph, oldFrame);

    expect(result).toEqual({ status: 'incompatible', note: '机器结构版本不同', steps: [], rules: [] });
  });

  it('[BT_V32] labels the state, event, condition and action in Chinese while preserving rule identifiers', () => {
    const rule = graph.transitions.find(item => item.id === 'running:HELP:0')!;

    expect(phaseLabel('waitingAssistance')).toBe('等待协助');
    expect(eventLabel('HELP')).toBe('请求协助');
    expect(ruleLabel(rule)).toBe('请求协助 · HELP [事件身份、版本、权限和额度有效 · valid] / 更新任务与操作意图 · apply');
  });

  it('[BT_V32] preserves unknown source vocabulary rather than inventing a translation or condition', () => {
    expect(phaseLabel('futurePhase')).toBe('futurePhase');
    expect(eventLabel('FUTURE_EVENT')).toBe('FUTURE_EVENT');
    expect(ruleLabel({ id: 'future', source: 'running', target: null, event: 'FUTURE_EVENT', order: 0, guards: ['futureGuard'], actions: [] }))
      .toBe('FUTURE_EVENT [futureGuard] / 空处理');
  });
});
