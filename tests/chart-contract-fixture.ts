import assert from 'node:assert/strict';
import { chartEdges, chartStep, eventLabel, phaseLabel, ruleLabel } from '../src/task-chart.js';
import { debugEventTemplate, TaskSandbox, taskGraph, type DebugFrame } from '../src/task-debug.js';

function send(box: TaskSandbox, type: string): DebugFrame {
  box.send(JSON.stringify(debugEventTemplate(box.snapshot, type))); return box.history.at(-1)!;
}
export function graphVocabularyContract() {
  const graph = taskGraph();
  const edge = chartEdges(graph).find(item => item.source === 'running' && item.target === 'coordinating');
  assert(edge);
  for (const [event, guard] of [['BLOCKED', 'canCoordinate'], ['TICK', 'shouldTick'], ['FAILURE_SIGNAL', 'repeated'],
    ['@always', 'reviewReady'], ['@always', 'deferredReady'], ['SUPERVISE', 'supervisionRepairs']])
    assert.equal(edge.rules.filter(rule => rule.event === event && rule.guards.includes(guard!)).length, 1);
  assert.equal(new Set(edge.rules.map(rule => rule.id)).size, edge.rules.length);
  const rule = graph.transitions.find(item => item.id === 'running:HELP:0')!;
  assert.equal(phaseLabel('waitingAssistance'), '等待协助'); assert.equal(eventLabel('HELP'), '请求协助');
  assert.equal(ruleLabel(rule), '请求协助 · HELP [事件身份、版本、权限和额度有效 · valid] / 更新任务与操作意图 · apply');
  assert.equal(phaseLabel('futurePhase'), 'futurePhase'); assert.equal(eventLabel('FUTURE_EVENT'), 'FUTURE_EVENT');
  assert.equal(ruleLabel({ id: 'future', source: 'running', target: null, event: 'FUTURE_EVENT', order: 0, guards: ['futureGuard'], actions: [] }), 'FUTURE_EVENT [futureGuard] / 空处理');
}
export function focusedGraphContract() {
  const graph = taskGraph(), edges = chartEdges(graph, 'waitingHuman');
  const sourceRules = graph.transitions.filter(rule => rule.source !== '*' && rule.target && rule.source !== rule.target
    && (rule.source === 'waitingHuman' || rule.target === 'waitingHuman'));
  assert.deepEqual(edges.flatMap(edge => edge.rules.map(rule => rule.id)).sort(), sourceRules.map(rule => rule.id).sort(),
    'focused overview must preserve every real local branch touching the selected state');
  for (const edge of edges) assert.deepEqual(edge.rules, sourceRules.filter(rule => rule.source === edge.source && rule.target === edge.target));
  const coordination = edges.find(edge => edge.source === 'coordinating' && edge.target === 'waitingHuman'); assert(coordination);
  for (const guard of ['decisionAsk', 'isCurrent', 'valid', 'businessBlockedByHuman', 'supervisionWaitsForHuman'])
    assert(coordination.rules.some(rule => rule.guards.includes(guard)));
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
