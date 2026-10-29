import type { DebugFrame, MachineGraph, MachineTransition } from '../../src/task-debug';
import { branchStatus, guardDescriptions } from '../../src/task-debug-view';

export function DebugRules({ graph, focus, onFocus, selected, onSelect }: {
  graph: MachineGraph; focus: string; onFocus: (state: string) => void;
  selected: string | null; onSelect: (rule: MachineTransition) => void;
}) {
  const rules = graph.transitions.filter(t => focus === 'all' || t.source === focus || (focus !== '*' && t.source === '*'));
  const events = [...new Set(rules.map(t => t.event))];
  return <section className="debug-rules" aria-label="转移规则">
    <div className="debug-section-title"><h3>转移规则 · {rules.length}条</h3>
      <select aria-label="规则状态筛选" value={focus} onChange={e => onFocus(e.target.value)}>
        <option value="all">全部状态</option><option value="*">全局处理</option>
        {graph.states.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
    </div>
    <p className="debug-evidence-note">规则定义 · 条件待判断 · 隐藏 {graph.transitions.length - rules.length}条</p>
    {events.map(event => <details key={event} open={rules.some(t => t.id === selected && t.event === event) || undefined}>
      <summary><code>{event === '@always' ? '自动转移' : event}</code> · {rules.filter(t => t.event === event).length}个分支</summary>
      <div className="debug-rule-rows">{rules.filter(t => t.event === event).sort((a, b) => Number(a.source === '*') - Number(b.source === '*') || a.order - b.order).map(rule => {
        const shadowed = rule.source === '*' && rules.some(t => t.source === focus && t.event === rule.event && !t.guards.length && t.event !== '@always');
        return <button key={rule.id} aria-pressed={selected === rule.id} onClick={() => onSelect(rule)}>
          <span>{rule.source === '*' ? '全局' : rule.source} · 分支{rule.order + 1}</span>
          <code>{rule.guards.join(' / ') || '无条件'} → {rule.target ?? '内部更新'}</code>
          <span>{shadowed ? '被局部无条件处理遮蔽' : '条件待判断'} · {rule.actions.join('、') || '空处理'}</span>
        </button>;
      })}</div>
    </details>)}
  </section>;
}
export function DebugRuleDetails({ rule, graph, frame, onFill, canFill }: {
  rule: MachineTransition; graph: MachineGraph; frame?: DebugFrame | undefined; onFill: (event: string) => void; canFill: boolean;
}) {
  const relevant = frame && (frame.evidence?.evaluations.some(e => e.ruleId === rule.id)
    || (frame.event.type === rule.event && (rule.source === '*' || frame.from === rule.source))) ? frame : undefined;
  return <section className="debug-step-details" aria-label="规则详情"><h3>规则定义</h3>
    <p className="debug-step-result"><code>{rule.event === '@always' ? '自动转移' : rule.event}</code> → {rule.target ?? '保持当前状态'}</p>
    <dl><dt>来源与优先顺序</dt><dd>{rule.source === '*' ? '全局处理' : rule.source} · 第{rule.order + 1}分支</dd>
      <dt>条件</dt><dd><code>{rule.guards.join('、') || '无条件'}</code>
        {rule.guards.some(name => guardDescriptions[name]) && <p>{rule.guards.map(name => guardDescriptions[name] ?? name).join('；')}</p>}</dd>
      <dt>动作定义</dt><dd><code>{rule.actions.join('、') || '空处理'}</code></dd>
      <dt>{relevant ? '所选步骤的证据' : '候选规则'}</dt><dd>{branchStatus(rule, relevant, graph)}</dd></dl>
    {rule.event === '@always' ? <p>条件允许时自动处理，不能手工发送。</p> :
      <button disabled={!canFill} onClick={() => onFill(rule.event)}>在沙箱填写事件</button>}
    <p className="debug-evidence-note">同一事件按局部到全局、分支顺序查找；首项命中后不继续求值。</p>
  </section>;
}
