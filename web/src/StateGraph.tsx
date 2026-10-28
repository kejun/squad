import { useId, useState } from 'react';
import { stateTransitions, type MachineGraph } from '../../src/task-debug';

export function StateGraph({ graph, active, focus, onFocus }: {
  graph: MachineGraph; active: string | undefined; focus: string; onFocus: (state: string) => void;
}) {
  const marker = useId().replaceAll(':', '');
  const [scale, setScale] = useState(1);
  const positions = new Map(graph.states.map((id, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / graph.states.length;
    return [id, { x: 500 + Math.cos(angle) * 355, y: 300 + Math.sin(angle) * 215 }] as const;
  }));
  const source = positions.get(focus);
  const edges = new Map<string, string[]>();
  for (const transition of stateTransitions(graph, focus)) {
    if (!transition.target || transition.target === focus || !positions.has(transition.target)) continue;
    edges.set(transition.target, [...(edges.get(transition.target) ?? []), transition.event]);
  }
  return <div className="debug-chart">
    <div className="debug-chart-tools"><span>候选转移 · {focus}</span><label>缩放
      <input aria-label="状态图缩放" type="range" min="0.8" max="1.6" step="0.1" value={scale} onChange={e => setScale(Number(e.target.value))} />
    </label></div>
    <div className="debug-chart-scroll">
      <svg className="debug-statechart" aria-label="任务状态图" role="group" viewBox="0 0 1000 600" style={{ width: 1000 * scale, height: 600 * scale }}>
        <defs><marker id={marker} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10" fill="#a6b8b0" /></marker></defs>
        {source && [...edges].map(([target, events]) => {
          const end = positions.get(target)!;
          const dx = end.x - source.x, dy = end.y - source.y;
          const ratio = Math.min(0.42, 40 / Math.max(1, Math.abs(dy)), 105 / Math.max(1, Math.abs(dx)));
          const startX = source.x + dx * ratio, startY = source.y + dy * ratio;
          const endX = end.x - dx * ratio, endY = end.y - dy * ratio;
          const label = [...new Set(events)].filter(e => e !== '@always').slice(0, 2).join(' / ') || 'always';
          return <g key={target} className="debug-edge">
            <path d={'M' + startX + ' ' + startY + ' L' + endX + ' ' + endY} markerEnd={'url(#' + marker + ')'} />
            <text x={(startX + endX) / 2} y={(startY + endY) / 2 - 7} textAnchor="middle">{label}<title>{events.join(', ')}</title></text>
          </g>;
        })}
        {graph.states.map(id => {
          const point = positions.get(id)!;
          return <g key={id} role="button" tabIndex={0} aria-label={'查看状态 ' + id}
            data-active={active === id} aria-pressed={focus === id}
            className={'debug-node' + (active === id ? ' is-active' : '') + (focus === id ? ' is-selected' : '')}
            transform={'translate(' + point.x + ' ' + point.y + ')'}
            onClick={() => onFocus(id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFocus(id); } }}>
            <rect x="-101" y="-28" width="202" height="56" rx="12" />
            <text textAnchor="middle" dominantBaseline="middle">{id}</text>
            {active === id && <circle cx="-88" cy="0" r="4" />}
          </g>;
        })}
      </svg>
    </div>
  </div>;
}

