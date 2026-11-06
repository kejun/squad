import assert from 'node:assert/strict';
import { chartEdges, chartStep, eventLabel, phaseLabel, ruleLabel } from '../src/task-chart.js';
import { debugEventTemplate, TaskSandbox, taskGraph, type DebugFrame } from '../src/task-debug.js';

function send(box: TaskSandbox, type: string): DebugFrame {
  box.send(JSON.stringify(debugEventTemplate(box.snapshot, type))); return box.history.at(-1)!;
}
export function graphVocabularyContract() {
  const graph = taskGraph();
  const edge = chartEdges(graph).find(item => item.source === 'running' && item.target === 'coordinating');
  assert.deepEqual(edge?.rules.map(rule => ({ event: rule.event, guard: rule.guards[0], order: rule.order })), [
    { event: 'BLOCKED', guard: 'canCoordinate', order: 1 }, { event: 'TICK', guard: 'shouldTick', order: 0 },
    { event: 'FAILURE_SIGNAL', guard: 'repeated', order: 0 }, { event: '@always', guard: 'reviewReady', order: 1 },
    { event: '@always', guard: 'deferredReady', order: 2 },
  ]);
  const rule = graph.transitions.find(item => item.id === 'running:HELP:0')!;
  assert.equal(phaseLabel('waitingAssistance'), '等待协助'); assert.equal(eventLabel('HELP'), '请求协助');
  assert.equal(ruleLabel(rule), '请求协助 · HELP [事件身份、版本、权限和额度有效 · valid] / 更新任务与操作意图 · apply');
  assert.equal(phaseLabel('futurePhase'), 'futurePhase'); assert.equal(eventLabel('FUTURE_EVENT'), 'FUTURE_EVENT');
  assert.equal(ruleLabel({ id: 'future', source: 'running', target: null, event: 'FUTURE_EVENT', order: 0, guards: ['futureGuard'], actions: [] }), 'FUTURE_EVENT [futureGuard] / 空处理');
}
export function focusedGraphContract() {
  const graph = taskGraph(), edges = chartEdges(graph, 'waitingHuman');
  assert.deepEqual(edges.map(edge => [edge.source, edge.target]), [
    ['interpreting', 'waitingHuman'], ['running', 'waitingHuman'], ['waitingAssistance', 'waitingHuman'],
    ['coordinating', 'waitingHuman'], ['waitingHuman', 'running'], ['checking', 'waitingHuman'],
  ]);
  assert.deepEqual(edges.find(edge => edge.source === 'coordinating')?.rules.map(rule => rule.guards), [['decisionAsk'], ['isCurrent'], ['valid']]);
  assert(!chartEdges(graph).flatMap(edge => edge.rules).some(rule => rule.source === '*' || rule.target === null || rule.source === rule.target));
  assert(graph.transitions.some(rule => rule.source === '*' && rule.event === '@always' && rule.target === 'interpreting' && rule.guards.includes('analysisReady')));
  assert(graph.transitions.some(rule => rule.source === 'ended' && rule.event === 'CONTINUE' && rule.target === 'running' && rule.guards.includes('valid')));
  assert(graph.transitions.some(rule => rule.source === 'ended' && rule.event === 'STOP' && rule.target === null && rule.actions.length === 0));
}
export function unavailablePathContract(record: string) {
  const box = new TaskSandbox(), current = send(box, 'HELP'), graph = taskGraph();
  const { evidence, ...legacy } = current;
  const frame = record === '没有诊断证据' ? legacy : { ...current, evidence: { ...evidence!, definition: 'old-definition' } };
  assert.deepEqual(chartStep(graph, frame), record === '没有诊断证据'
    ? { status: 'missing', note: '此记录未采集', steps: [], rules: [] }
    : { status: 'incompatible', note: '机器结构版本不同', steps: [], rules: [] });
}
