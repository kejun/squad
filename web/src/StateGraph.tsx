import { useId, useMemo, useState } from 'react';
import { stateTransitions, type MachineGraph } from '../../src/task-debug';

/** Positions are presentation hints only; all nodes and edges come from the machine. */
export function graphPositions(graph: MachineGraph) {
  const hints: Record<string, { x: number; y: number }> = {
    interpreting: { x: 170, y: 90 }, running: { x: 460, y: 250 }, checking: { x: 780, y: 250 },
    waitingAssistance: { x: 170, y: 440 }, coordinating: { x: 460, y: 440 }, waitingHuman: { x: 780, y: 440 },
    stopping: { x: 1090, y: 90 }, ended: { x: 1090, y: 250 },
  };
  return new Map(graph.states.map((id, index) => [id, hints[id] ?? { x: 170 + index % 4 * 300, y: 640 + Math.floor(index / 4) * 150 }]));
}
export function StateGraph({ graph, active, historical, focus, onFocus, onRule, onGlobals }: {
  graph: MachineGraph; active: string | undefined; historical?: string | undefined; focus: string;
  onFocus: (state: string) => void; onRule?: (id: string) => void; onGlobals?: () => void;
}) {
  const marker = useId().replaceAll(':', '');
  const [scale, setScale] = useState(1);
  const [local, setLocal] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const positions = useMemo(() => graphPositions(graph), [graph]);
  const related = new Set([focus, ...stateTransitions(graph, focus).flatMap(t => t.target ? [t.target] : []),
    ...graph.transitions.filter(t => t.target === focus && t.source !== '*').map(t => t.source)]);
  const visible = graph.states.filter(id => !local || related.has(id));
  const edges = new Map<string, { source: string; target: string; rules: typeof graph.transitions }>();
  for (const rule of graph.transitions) {
    if (!rule.target || rule.source === '*' || rule.source === rule.target || !visible.includes(rule.source) || !visible.includes(rule.target)) continue;
    const key = rule.source + ':' + rule.target;
    const edge = edges.get(key) ?? { source: rule.source, target: rule.target, rules: [] };
    edge.rules.push(rule); edges.set(key, edge);
  }
  const height = Math.max(570, ...[...positions.values()].map(p => p.y + 90));
  return <section className="debug-chart" aria-label="完整状态图">
    <div className="debug-chart-tools"><button aria-pressed={local} onClick={() => setLocal(value => !value)}>聚焦所选状态</button>
      <span>隐藏 {graph.states.length - visible.length}个状态 · 位置固定</span>
      <label>缩放 <input aria-label="状态图缩放" type="range" min="0.8" max="1.6" step="0.1" value={scale} onChange={e => setScale(Number(e.target.value))} /></label>
      <button onClick={() => setScale(1)}>恢复缩放</button>
    </div>
    <button className="debug-global-rules" onClick={onGlobals}>全局处理 · {graph.transitions.filter(t => t.source === '*').length}条规则 · 查看条件与适用范围</button>
    <div className="debug-chart-scroll">
      <svg className="debug-statechart" aria-label="任务状态图" role="group" viewBox={`0 0 1260 ${height}`} style={{ width: 1260 * scale, height: height * scale }}>
        <defs><marker id={marker} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10" fill="currentColor" /></marker></defs>
        {[...edges].map(([key, edge], index) => {
          const from = positions.get(edge.source)!, end = positions.get(edge.target)!;
          const forward = end.x > from.x, down = end.y > from.y;
          const startX = from.x + (forward ? 106 : -106), endX = end.x + (forward ? -106 : 106);
          const sameRow = from.y === end.y, sameColumn = from.x === end.x;
          const corridor = end.y > 350 || (from.y > 350 && end.y >= 200) ? 345 : 170;
          const routeY = corridor + (index % 3 - 1) * 12;
          let path: string, labelX: number, labelY: number;
          if (sameRow && forward) {
            path = `M${startX} ${from.y} H${endX}`;
            labelX = (startX + endX) / 2; labelY = from.y - 51;
          } else if (sameColumn) {
            const x = from.x + (down ? 15 : -15);
            path = `M${x} ${from.y + (down ? 36 : -36)} V${end.y + (down ? -36 : 36)}`;
            labelX = x; labelY = (from.y + end.y) / 2;
          } else if (sameRow) {
            const y = from.y + 85 + index % 3 * 12;
            path = `M${from.x} ${from.y + 36} V${y} H${end.x} V${end.y + 36}`;
            labelX = (from.x + end.x) / 2; labelY = y - 8;
          } else {
            const channelX = startX + (forward ? 20 : -20);
            path = `M${startX} ${from.y} H${channelX} V${routeY} H${end.x} V${end.y + (down ? -36 : 36)}`;
            labelX = (channelX + end.x) / 2; labelY = routeY - 8;
          }
          const event = edge.rules[0]!.event;
          const label = (event === '@always' ? '自动转移' : event) + (edge.rules.length > 1 ? ` +${edge.rules.length - 1}` : '');
          const main = (edge.source === 'running' && edge.target === 'checking') || (edge.source === 'checking' && edge.target === 'ended') || (edge.source === 'stopping' && edge.target === 'ended');
          const select = () => { setSelectedEdge(key); onRule?.(edge.rules[0]!.id); };
          return <g key={key} className={'debug-edge' + (main ? ' is-main' : '') + (selectedEdge === key ? ' is-selected' : '') + (edge.source === focus || edge.target === focus ? ' is-related' : '')}
            role="button" tabIndex={0} aria-label={`${edge.source} 到 ${edge.target} 的${edge.rules.length}条规则`}
            onClick={select} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}>
            <path className="debug-edge-hit" d={path} />
            <path d={path} markerEnd={'url(#' + marker + ')'} />
            <text style={{ fontSize: 14 / scale }} x={labelX} y={labelY} textAnchor="middle">{label}</text>
            <title>{edge.rules.map(t => t.event + ' [' + t.guards.join(', ') + ']').join('\n')}</title>
          </g>;
        })}
        {visible.map(id => {
          const point = positions.get(id)!;
          const internal = graph.transitions.filter(t => t.source === id && (!t.target || t.target === id)).length;
          return <g key={id} role="button" tabIndex={0} aria-label={'查看状态 ' + id} data-active={active === id}
            data-history={historical === id} aria-pressed={focus === id}
            className={'debug-node' + (active === id ? ' is-active' : '') + (focus === id ? ' is-selected' : '') + (historical === id ? ' is-historical' : '')}
            transform={`translate(${point.x} ${point.y})`}
            onClick={() => onFocus(id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(id); } }}>
            <rect x="-106" y="-36" width="212" height="72" rx="10" />
            <text style={{ fontSize: 16 / scale }} y="-7" textAnchor="middle">{id}</text><text style={{ fontSize: 14 / scale }} y="17" textAnchor="middle" className="debug-node-info">
              {active === id ? '最新 ' : ''}{historical === id ? '历史 ' : ''}· 内部 {internal}</text>
            {graph.initial === id && <text style={{ fontSize: 14 / scale }} x="0" y="-48" textAnchor="middle">初始状态</text>}
          </g>;
        })}
      </svg>
    </div>
  </section>;
}
