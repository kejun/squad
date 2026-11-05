import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { type DebugFrame, type MachineGraph, type MachineTransition } from '../../src/task-debug';
import { chartEdges, chartStep, eventLabel, phaseLabel, ruleLabel, type ChartEdge } from '../../src/task-chart';
import { branchStatus, frameKey, frameSummary } from '../../src/task-debug-view';

/** Presentation hints only; states, rules and recorded paths come from the real machine. */
export function graphPositions(graph: MachineGraph) {
  const hints: Record<string, { x: number; y: number }> = {
    interpreting: { x: 170, y: 100 }, running: { x: 460, y: 280 }, checking: { x: 780, y: 280 },
    waitingAssistance: { x: 170, y: 490 }, coordinating: { x: 460, y: 490 }, waitingHuman: { x: 780, y: 490 },
    stopping: { x: 1090, y: 100 }, ended: { x: 1090, y: 280 },
  };
  return new Map(graph.states.map((id, index) => [id, hints[id] ?? { x: 170 + index % 4 * 300, y: 720 + Math.floor(index / 4) * 180 }]));
}

type Point = { x: number; y: number };
/** Dedicated corridors keep the eight task phases clear; new phases use a generic route. */
const routes: Record<string, { path: string; label: Point }> = {
  'interpreting:running': { path: 'M276 100 H320 V280 H354', label: { x: 320, y: 190 } },
  'interpreting:waitingHuman': { path: 'M170 138 V205 H925 V470 H886', label: { x: 620, y: 195 } },
  'running:waitingAssistance': { path: 'M354 280 H170 V452', label: { x: 170, y: 365 } },
  'running:coordinating': { path: 'M440 318 V452', label: { x: 415, y: 382 } },
  'running:waitingHuman': { path: 'M566 298 H610 V490 H674', label: { x: 610, y: 355 } },
  'running:checking': { path: 'M566 280 H674', label: { x: 620, y: 265 } },
  'waitingAssistance:running': { path: 'M190 452 V345 H390 V318', label: { x: 290, y: 335 } },
  'waitingAssistance:waitingHuman': { path: 'M170 528 V635 H780 V528', label: { x: 600, y: 625 } },
  'coordinating:waitingAssistance': { path: 'M354 490 H276', label: { x: 315, y: 475 } },
  'coordinating:running': { path: 'M480 452 V318', label: { x: 510, y: 408 } },
  'coordinating:waitingHuman': { path: 'M566 490 H674', label: { x: 620, y: 475 } },
  'coordinating:ended': { path: 'M566 510 H950 V300 H984', label: { x: 950, y: 410 } },
  'waitingHuman:running': { path: 'M760 452 V375 H550 V318', label: { x: 680, y: 365 } },
  'checking:ended': { path: 'M886 280 H984', label: { x: 935, y: 265 } },
  'checking:coordinating': { path: 'M760 318 V415 H540 V452', label: { x: 660, y: 405 } },
  'checking:waitingHuman': { path: 'M800 318 V452', label: { x: 830, y: 382 } },
  'stopping:ended': { path: 'M1090 138 V242', label: { x: 1090, y: 185 } },
  'ended:running': { path: 'M1090 318 V585 H325 V300 H354', label: { x: 780, y: 575 } },
};
function edgeRoute(edge: ChartEdge, positions: Map<string, Point>) {
  if (routes[edge.id]) return routes[edge.id]!;
  const from = positions.get(edge.source)!, to = positions.get(edge.target)!;
  if (edge.source === edge.target) return { path: `M${from.x + 106} ${from.y - 20} h35 v60 h-35`, label: { x: from.x + 145, y: from.y - 30 } };
  if (from.x === to.x) {
    const direction = Math.sign(to.y - from.y);
    return { path: `M${from.x} ${from.y + direction * 38} V${to.y - direction * 38}`, label: { x: from.x, y: (from.y + to.y) / 2 - 10 } };
  }
  const direction = Math.sign(to.x - from.x), start = from.x + direction * 106, end = to.x - direction * 106;
  const mid = (start + end) / 2;
  return { path: `M${start} ${from.y} H${mid} V${to.y} H${end}`, label: { x: mid, y: (from.y + to.y) / 2 - 10 } };
}

export function StateGraph({ graph, active, historical, focus, frame, onFocus, onRule, onGlobals }: {
  graph: MachineGraph; active: string | undefined; historical?: string | undefined; focus: string; frame?: DebugFrame | undefined;
  onFocus: (state: string) => void; onRule?: (id: string) => void; onGlobals?: () => void;
}) {
  const marker = useId().replaceAll(':', '');
  const [scale, setScale] = useState(1);
  const [local, setLocal] = useState(false);
  const [pathOnly, setPathOnly] = useState(false);
  const [selection, setSelection] = useState<{ title: string; rules: MachineTransition[] } | null>(null);
  const selectedStep = frame ? frameKey(frame) + ':' + frame.evidence?.definition : null;
  useEffect(() => { setSelection(null); }, [selectedStep]);
  const branches = useRef<HTMLElement>(null);
  useEffect(() => {
    branches.current?.scrollIntoView?.({ block: 'nearest' });
    branches.current?.querySelector<HTMLButtonElement>('button[aria-label]')?.focus({ preventScroll: true });
  }, [selection]);
  const positions = useMemo(() => graphPositions(graph), [graph]);
  const step = chartStep(graph, frame);
  const overview = chartEdges(graph), filtered = chartEdges(graph, local ? focus : undefined);
  const recorded = new Map<string, ChartEdge>();
  for (const micro of step.steps) {
    if (!micro.from || !positions.has(micro.from) || !positions.has(micro.phase)) continue;
    const id = micro.from + ':' + micro.phase;
    const rules = step.rules.filter(rule => (rule.source === micro.from || rule.source === '*') && (rule.target === micro.phase || (!rule.target && micro.from === micro.phase)));
    recorded.set(id, { id, source: micro.from, target: micro.phase, rules });
  }
  const edges = pathOnly ? [...recorded.values()] : filtered;
  const involved = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  if (local) involved.add(focus);
  const visible = graph.states.filter(id => pathOnly ? step.steps.some(micro => micro.from === id || micro.phase === id) : !local || involved.has(id));
  const globals = graph.transitions.filter(rule => rule.source === '*');
  const internal = graph.transitions.filter(rule => rule.source !== '*' && (!rule.target || rule.source === rule.target));
  const height = Math.max(675, ...[...positions.values()].map(p => p.y + 100));
  const chooseRules = (title: string, rules: MachineTransition[]) => setSelection({ title, rules });
  const switchPath = (value: boolean) => { setPathOnly(value); setSelection(null); };
  return <section className="debug-chart" aria-label="完整状态图">
    <div className="debug-chart-tools">
      <div className="debug-chart-modes" role="group" aria-label="状态图范围">
        <button aria-pressed={!pathOnly} onClick={() => switchPath(false)}>阶段概览</button>
        <button aria-pressed={pathOnly} onClick={() => switchPath(true)}>所选步骤路径</button>
        <button aria-pressed={local} disabled={pathOnly} onClick={() => { setLocal(value => !value); setSelection(null); }}>聚焦所选状态</button>
      </div>
      <label>缩放 <input aria-label="状态图缩放" type="range" min="0.8" max="1.6" step="0.1" value={scale} onChange={e => setScale(Number(e.target.value))} /></label>
      <button onClick={() => setScale(1)}>恢复缩放</button>
    </div>
    <div className="debug-chart-caption">
      <p>{pathOnly ? '当次诊断路径' : `阶段概览 · ${edges.length}条局部连线`} · 隐藏 {graph.states.length - visible.length}个状态 · 位置固定</p>
      <p>{pathOnly ? '只显示所选步骤采集的转移，包含自动微步和同状态处理。' : `候选结构，条件待判断。全局转移 ${globals.length}条、内部处理 ${internal.length}条另列；聚合连线可展开全部分支。`}</p>
      {!pathOnly && local && <p>仅显示与{phaseLabel(focus)}相接的局部转移，隐藏 {overview.length - filtered.length}条局部连线。</p>}
      <div className="debug-chart-legend"><span className="legend-active">最新状态</span><span className="legend-history">历史位置</span><span className="legend-recorded">所选步骤的真实路径</span></div>
    </div>
    <section className="debug-chart-step" aria-label="所选步骤路径">
      <div className="debug-section-title"><h3>{frame ? eventLabel(frame.event.type) : '所选步骤'}{!pathOnly && frame && ` · ${frame.from && frame.from !== frame.phase ? phaseLabel(frame.from) + ' → ' + phaseLabel(frame.phase) : frameSummary(frame, graph)}`}</h3><span>{step.note}</span></div>
      {step.status === 'recorded' ? <>
        {pathOnly && <ol>{step.steps.map((micro, index) => <li key={index}>
          <span>{index + 1}. {micro.from ? phaseLabel(micro.from) : '起点'} → <strong>{phaseLabel(micro.phase)}</strong></span>
          <span>{micro.automatic ? '自动处理' : frame ? eventLabel(frame.event.type) : '处理'} · {micro.changed.length ? `上下文变化 ${micro.changed.length}项` : '状态和上下文保持不变'}</span>
        </li>)}</ol>}
        {pathOnly && frame && <p>{frame.from && frame.from !== frame.phase ? phaseLabel(frame.from) + ' → ' + phaseLabel(frame.phase) : frameSummary(frame, graph)}</p>}
        {pathOnly && step.rules.length > 0 && <button onClick={() => chooseRules('所选步骤命中的规则', step.rules)}>查看所选步骤命中的规则 · {step.rules.length}条</button>}
      </> : <p>{step.note}，无法关联实际路径；仍可查看阶段概览与规则定义。</p>}
    </section>
    <div className="debug-chart-scroll">
      <svg className="debug-statechart" aria-label="任务状态图" role="group" viewBox={`0 0 1260 ${height}`} style={{ width: 1260 * scale, height: height * scale }}>
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="context-stroke" /></marker></defs>
        {edges.map(edge => {
          const { path, label } = edgeRoute(edge, positions);
          const events = [...new Set(edge.rules.map(rule => eventLabel(rule.event)))];
          const actual = pathOnly && recorded.has(edge.id);
          const selected = selection?.rules === edge.rules || (selection?.title === `${phaseLabel(edge.source)} → ${phaseLabel(edge.target)}`);
          const select = () => chooseRules(`${phaseLabel(edge.source)} → ${phaseLabel(edge.target)}`, edge.rules);
          const main = ['running:checking', 'checking:ended', 'stopping:ended'].includes(edge.id);
          return <g key={edge.id} className={'debug-edge' + (main ? ' is-main' : '') + (selected ? ' is-selected' : '') + (actual ? ' is-recorded' : '') + (edge.source === focus || edge.target === focus ? ' is-related' : '')}
            role="button" tabIndex={0} aria-label={`${phaseLabel(edge.source)} 到 ${phaseLabel(edge.target)} 的${edge.rules.length}条规则`}
            onClick={select} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}>
            <path className="debug-edge-hit" d={path} />
            <path d={path} markerEnd={'url(#' + marker + ')'} />
            <text style={{ fontSize: 14 / scale }} x={label.x} y={label.y} textAnchor="middle">{events.length === 1 ? events[0] : `${events.length}种事件`} {edge.rules.length > 1 ? `· ${edge.rules.length}分支` : ''}</text>
            <title>{edge.rules.map(ruleLabel).join('\n') || '当次诊断微步'}</title>
          </g>;
        })}
        {visible.map(id => {
          const point = positions.get(id)!;
          const rules = internal.filter(rule => rule.source === id);
          const select = () => { onFocus(id); setSelection(null); };
          return <Fragment key={id}>
            <g role="button" tabIndex={0} aria-label={'查看状态 ' + id} data-active={active === id}
              data-history={historical === id} aria-pressed={focus === id}
              className={'debug-node phase-' + id + (active === id ? ' is-active' : '') + (focus === id ? ' is-selected' : '') + (historical === id ? ' is-historical' : '')}
              transform={`translate(${point.x} ${point.y})`}
              onClick={select} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}>
              <rect x="-106" y="-38" width="212" height="76" rx="12" />
              <text style={{ fontSize: 16 / scale }} y="-16" textAnchor="middle">{phaseLabel(id)}</text>
              <text style={{ fontSize: 14 / scale }} y="5" textAnchor="middle" className="debug-node-info">{id}</text>
              <text className="debug-node-status" style={{ fontSize: 14 / scale }} y="-50" textAnchor="middle">{[graph.initial === id && '初始', active === id && '最新', historical === id && '历史'].filter(Boolean).join(' · ')}</text>
            </g>
            <g className="debug-node-internal" role="button" tabIndex={0} aria-label={'查看内部规则 ' + id}
              onClick={() => chooseRules(`${phaseLabel(id)} · 内部处理`, rules)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseRules(`${phaseLabel(id)} · 内部处理`, rules); } }}>
              <text x={point.x} y={point.y + 27} textAnchor="middle" style={{ fontSize: 14 / scale }}>内部处理 {rules.length}条</text>
            </g>
          </Fragment>;
        })}
      </svg>
    </div>
    {selection && <section className="debug-chart-branches" aria-label="连线分支" ref={branches}>
      <div className="debug-section-title"><h3>{selection.title} · {selection.rules.length}条规则</h3><button onClick={() => setSelection(null)}>收起分支</button></div>
      <div>{selection.rules.map(rule => <button key={rule.id} aria-label={'查看规则 ' + rule.id} onClick={() => onRule?.(rule.id)}>
        <span>{rule.source === '*' ? '全局' : phaseLabel(rule.source)} · 分支 {rule.order + 1} → {rule.target ? phaseLabel(rule.target) : '保持当前状态'}</span>
        <span>{ruleLabel(rule)}</span><span>{branchStatus(rule, frame && ((frame.event.type === rule.event && (rule.source === '*' || rule.source === frame.from)) || step.rules.includes(rule)) ? frame : undefined, graph)}</span>
      </button>)}</div>
      {!selection.rules.length && <p>未采集可关联的规则；阶段顺序来自诊断微步。</p>}
    </section>}
    <section className="debug-chart-globals" aria-label="全局转移与内部处理">
      <button className="debug-global-rules" onClick={onGlobals}>全局处理 · {globals.length}条规则 · 查看条件与适用范围</button>
      <p>局部条件均未命中才回退全局分支；局部无条件处理会遮蔽同名全局事件。全局自动处理仍受各自守卫限制。</p>
      <div className="debug-global-targets">{graph.states.map(id => {
        const rules = globals.filter(rule => rule.target === id);
        return rules.length > 0 && <button key={id} aria-label={'查看全局进入 ' + id} onClick={() => chooseRules(`全局进入${phaseLabel(id)}`, rules)}>{phaseLabel(id)} · {rules.length}</button>;
      })}</div>
      <p>内部处理包含不切换阶段的更新、自环、拒绝和空处理；点击节点下方入口逐项查看。</p>
    </section>
  </section>;
}
