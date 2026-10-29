import { useMemo, useState } from 'react';
import type { DebugFrame, MachineGraph, MachineTransition } from '../../src/task-debug';
import { branchStatus, contextChanges, contextOf, frameSummary, phaseNames, guardDescriptions } from '../../src/task-debug-view';

export function JsonDisclosure({ title, value, label }: { title: string; value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={e => setOpen(e.currentTarget.open)}><summary>{title}</summary>
    {open && <pre aria-label={label}>{JSON.stringify(value, null, 2)}</pre>}</details>;
}
const previewValue = (value: unknown) => {
  const text = value === undefined ? '∅' : JSON.stringify(value);
  return text.length > 500 ? text.slice(0, 500) + '…（完整值见原始快照）' : text;
};
export function DebugStepDetails({ frame, previous, graph, onRule, preview = false }: {
  frame: DebugFrame; previous?: DebugFrame | undefined; graph: MachineGraph; onRule: (rule: MachineTransition) => void; preview?: boolean;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const context = contextOf(frame);
  const compatible = frame.evidence?.definition === graph.definition;
  const changes = useMemo(() => showChanges && previous ? contextChanges(contextOf(previous), context) : undefined, [showChanges, previous, context]);
  const rules = graph.transitions.filter(t => (t.source === frame.from || t.source === '*') && t.event === frame.event.type)
    .sort((a, b) => Number(a.source === '*') - Number(b.source === '*') || a.order - b.order);
  const selected = compatible ? graph.transitions.filter(rule => frame.evidence?.evaluations.some(e => e.ruleId === rule.id && e.passed)) : [];
  return <section className="debug-step-details" aria-label={preview ? '预演步骤详情' : '步骤详情'}>
    <div className="debug-section-title"><h3>{preview ? '预演' : '选中步骤'}</h3><code>{frame.event.type}</code></div>
    <p className="debug-step-result">{frameSummary(frame, graph)}</p>
    <p>{frame.from ? phaseNames[frame.from] + ' → ' : ''}{phaseNames[frame.phase]} <code>{frame.phase}</code></p>
    <p className="debug-evidence-note">{preview ? '按当前草稿预演，尚未推进实验' : frame.evidence ? '当次转换采集' : '此记录未采集条件求值'}</p>
    {frame.evidence && <>
      <details className="debug-microsteps" open><summary>转换路径 · {frame.evidence.microsteps.length}步</summary>
        <ol>{frame.evidence.microsteps.map((step, i) => <li key={i}><span>{step.automatic ? '自动转移' : frame.event.type === '@init' ? '初始化' : '事件处理'}</span>
          <code>{step.from ?? '开始'} → {step.phase}</code></li>)}</ol>
      </details>
      {rules.length > 0 && <div className="debug-branches"><h3>事件分支</h3>{rules.map(rule => <button key={rule.id} onClick={() => onRule(rule)}>
        <span>{rule.source === '*' ? '全局' : rule.source} · {rule.order + 1}</span>
        <code>{rule.guards.join(' / ') || '无条件'} → {rule.target ?? '内部更新'}</code>
        {rule.guards.some(name => guardDescriptions[name]) && <span>{rule.guards.map(name => guardDescriptions[name] ?? name).join('；')}</span>}
        <span>{branchStatus(rule, frame, graph)}</span></button>)}</div>}
      <details><summary>条件求值顺序 · {frame.evidence.evaluations.length}次</summary>
        <ol className="debug-guard-evaluations">{frame.evidence.evaluations.map((e, i) => <li key={i}>
          <button disabled={!compatible} onClick={() => { const rule = graph.transitions.find(t => t.id === e.ruleId); if (rule) onRule(rule); }}>
            <code>{e.source === '*' ? '全局' : e.source} / {e.event === '@always' ? '自动转移' : e.event}</code>
            <span>{e.guard ?? '无条件'}：{e.passed ? '满足并命中' : '不满足'}</span>
          </button></li>)}</ol>
      </details>
      <div className="debug-changed-fields"><h3>关键变化</h3>
        <p>{frame.evidence.changed.length ? frame.evidence.changed.join(' · ') : '状态和上下文保持不变'}</p>
      </div>
      {selected.length > 0 && <details><summary>规则动作定义</summary>
        <ul>{selected.map(rule => <li key={rule.id}><code>{rule.event === '@always' ? '自动转移' : rule.event}</code>：{rule.actions.join('、') || '空处理'}</li>)}</ul>
        <p>动作定义与上下文计算不代表模型或工具已完成；执行请求与结果见工作记录。</p>
      </details>}
    </>}
    <details onToggle={e => setShowChanges(e.currentTarget.open)}><summary>字段差异</summary>
      {!previous ? <p>前置快照不可用，无法完整比较。</p> : showChanges && <>
        <div className="debug-diff-list">{changes?.changes.map(change => <div key={change.path}>
          <code>{change.path}</code><del>{previewValue(change.before)}</del><ins>{previewValue(change.after)}</ins>
        </div>)}</div>
        {!changes?.changes.length && <p>没有字段变化。</p>}{changes?.truncated && <p>差异超过200项，后续变化请查看原始快照。</p>}
      </>}
    </details>
    <JsonDisclosure title="原始事件" value={frame.event} />
    <JsonDisclosure title="完整上下文" value={context} label="任务上下文" />
    <JsonDisclosure title="记录信息" value={{ stepId: frame.stepId, transactionId: frame.transactionId,
      definitionFingerprint: frame.evidence?.definition, xstate: frame.evidence?.xstate, eventTime: frame.event.at }} />
  </section>;
}
