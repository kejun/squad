import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, Play, RotateCcw, X } from 'lucide-react';
import { debugEventTemplate, debugInput, stateTransitions, taskGraph, TaskSandbox } from '../../src/task-debug';
import { persistTask, restoreTask, type TaskSnapshot } from '../../src/task.machine';
import { StateGraph } from './StateGraph';
import { useDebugFeed } from './use-debug-feed';

const InspectorView = lazy(() => import('./InspectorView').then(module => ({ default: module.InspectorView })));
const json = (value: unknown) => JSON.stringify(value, null, 2);

export function TaskDebug({ roomId, onClose }: { roomId: string | null; onClose: () => void }) {
  const graph = useMemo(taskGraph, []);
  const [mode, setMode] = useState<'live' | 'sandbox'>(roomId ? 'live' : 'sandbox');
  const [sandbox, setSandbox] = useState(() => new TaskSandbox());
  const [revision, setRevision] = useState(0);
  const [taskId, setTaskId] = useState('');
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [view, setView] = useState<'local' | 'inspector'>('local');
  const [eventType, setEventType] = useState('HELP');
  const [eventText, setEventText] = useState('');
  const [inputText, setInputText] = useState(() => json(debugInput()));
  const [error, setError] = useState('');
  const [focus, setFocus] = useState(graph.initial);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { feed, error: connectionError } = useDebugFeed(roomId, taskId, mode === 'live');
  const simSnapshot = useMemo(() => sandbox.snapshot, [sandbox, revision]);
  const liveRecords = feed?.records.filter(record => record.taskId === feed.current?.taskId) ?? [];
  const liveFrame = liveRecords.find(record => record.sequence === selectedSequence);
  const liveSnapshot = useMemo(() => {
    const value = liveFrame?.snapshot ?? feed?.current?.snapshot;
    if (!value) return null;
    try { return restoreTask(structuredClone(value)); } catch { return null; }
  }, [liveFrame, feed?.current?.snapshot]);
  const snapshot = mode === 'sandbox' ? simSnapshot : liveSnapshot;
  const frame = mode === 'sandbox' ? sandbox.history[sandbox.index] : liveFrame ?? liveRecords.at(-1);
  const phase = snapshot ? String(snapshot.value) : undefined;
  const events = useMemo(() => [...new Set(graph.transitions.map(t => t.event).filter(e => e !== '@always' && e !== '*'))].sort(), [graph]);
  const transitions = stateTransitions(graph, focus);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  useEffect(() => { if (phase) setFocus(phase); }, [phase]);
  useEffect(() => { if (mode === 'sandbox') setEventText(json(debugEventTemplate(simSnapshot, eventType))); }, [mode, simSnapshot, eventType]);

  const startSandbox = (seed?: TaskSnapshot | null, event = 'HELP') => {
    setSandbox(new TaskSandbox(seed ? structuredClone(persistTask(seed)) : undefined));
    setRevision(0); setMode('sandbox'); setEventType(event); setError(''); setView('local');
  };
  const send = () => {
    try { sandbox.send(eventText); setError(''); setRevision(n => n + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const reset = () => { sandbox.reset(); setRevision(n => n + 1); setError(''); };
  const chooseEvent = (event: string) => {
    if (event === '@always') return;
    const next = event === '*' ? 'UNKNOWN_EVENT' : event;
    if (mode === 'live') startSandbox(snapshot, next);
    else { setEventType(next); setError(''); }
  };

  return <div className="debug-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="task-debug" role="dialog" aria-modal="true" aria-labelledby="task-debug-title" ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), select, textarea, input, iframe, summary, [tabindex="0"]')];
          const first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="debug-header">
        <div><Bug size={18} /><h2 id="task-debug-title">状态机调试</h2><code>{graph.id}</code></div>
        <button aria-label="关闭状态机调试" ref={closeButton} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="debug-toolbar">
        <div className="debug-tabs" role="group" aria-label="调试模式">
          <button aria-pressed={mode === 'live'} disabled={!roomId} onClick={() => { setMode('live'); setError(''); setSelectedSequence(null); }}>实时观测</button>
          <button aria-pressed={mode === 'sandbox'} onClick={() => { setMode('sandbox'); setError(''); }}>沙箱仿真</button>
        </div>
        {mode === 'live' && <select aria-label="观测任务" value={taskId} onChange={event => { setTaskId(event.target.value); setSelectedSequence(null); }}>
          <option value="">当前或最近任务</option>{feed?.tasks.map(task => <option key={task.id} value={task.id}>{task.id} · {task.phase}</option>)}
        </select>}
        <button onClick={() => startSandbox()}>新建沙箱</button>
        {mode === 'live' && <button disabled={!snapshot} onClick={() => startSandbox(snapshot)}>复制到沙箱</button>}
        <div className="debug-view-toggle" role="group" aria-label="图形视图">
          <button aria-pressed={view === 'local'} onClick={() => setView('local')}>本地图</button>
          <button aria-pressed={view === 'inspector'} disabled={!snapshot} onClick={() => setView('inspector')}>官方 Inspector</button>
        </div>
      </div>
      {mode === 'live' && connectionError && <p className="debug-notice is-error" role="alert">观测连接中断：{connectionError}。当前显示最近收到的快照。</p>}
      {mode === 'live' && feed?.truncated && <p className="debug-notice" role="status">历史已裁剪或进程已重启，已重新同步当前快照。</p>}
      {mode === 'live' && !feed?.current && !connectionError && <p className="debug-notice">当前群还没有任务。可新建沙箱预览和仿真。</p>}
      <div className="debug-body">
        <main className="debug-main">
          <div className="debug-state-summary" aria-live="polite">
            <strong data-testid="debug-phase">{phase ?? '等待任务'}</strong>
            {snapshot && <><span>{snapshot.context.reply.code}</span><span>轮次 {snapshot.context.epoch} / 目标 {snapshot.context.goalVersion}</span>
              <span>普通额度 {snapshot.context.usage.ordinary}/{snapshot.context.config.limits.ordinary}</span></>}
            <span className="debug-mode-note">{mode === 'sandbox' ? '内存沙箱 · 无外部执行' : liveFrame ? '历史快照' : '已提交状态'}</span>
          </div>
          {view === 'local' || !snapshot
            ? <StateGraph graph={graph} active={phase} focus={focus} onFocus={setFocus} />
            : <Suspense fallback={<p role="status">加载 Inspector…</p>}><InspectorView snapshot={persistTask(snapshot)} event={frame?.event}
                identity={mode + ':' + (mode === 'live' ? feed?.sessionId + ':' + feed?.current?.taskId : 'sandbox')} /></Suspense>}
          <section className="debug-transitions" aria-label="状态转移">
            <h3>{focus} 的转移</h3>
            <div className="debug-transition-list">{transitions.map((transition, index) => <button key={index}
              disabled={transition.event === '@always'} onClick={() => chooseEvent(transition.event)}
              title={mode === 'live' ? '复制快照到沙箱后尝试该事件' : '填写事件参数'}>
              <code>{transition.event}</code><span>→ {transition.target ?? '保持当前状态'}</span>
              {transition.guards.length > 0 && <span className="debug-guard">[{transition.guards.join(', ')}]</span>}
              {transition.actions.length > 0 && <span>{transition.actions.join(', ')}</span>}
            </button>)}</div>
          </section>
        </main>
        <aside className="debug-side" aria-label="调试操作">
          {mode === 'sandbox' && <section>
            <div className="debug-section-title"><h3>发送事件</h3><button onClick={reset}><RotateCcw size={14} />重置</button></div>
            <select aria-label="事件类型" value={eventType} onChange={event => { setEventType(event.target.value); setError(''); }}>
              {!events.includes(eventType) && <option value={eventType}>{eventType}</option>}{events.map(event => <option key={event}>{event}</option>)}
            </select>
            <textarea aria-label="事件参数 JSON" spellCheck={false} value={eventText} maxLength={100000} onChange={event => setEventText(event.target.value)} />
            {error && <p className="debug-error" role="alert">{error}</p>}
            <button className="debug-run" onClick={send}><Play size={15} />单步执行</button>
            <details className="debug-input"><summary>初始输入</summary><textarea aria-label="初始输入 JSON" value={inputText} spellCheck={false} maxLength={100000} onChange={event => setInputText(event.target.value)} />
              <button onClick={() => { try { setSandbox(TaskSandbox.fromInput(inputText)); setRevision(0); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>应用初始输入</button>
            </details>
          </section>}
          <section className="debug-history">
            <div className="debug-section-title"><h3>事件历史</h3>{mode === 'live' && <button onClick={() => setSelectedSequence(null)}>跟随最新</button>}</div>
            <ol>{mode === 'sandbox' ? sandbox.history.map((item, index) => <li key={index}><button aria-pressed={sandbox.index === index}
              onClick={() => { sandbox.select(index); setRevision(n => n + 1); setError(''); }}>
              <code>{index}. {item.event.type}</code><span>{item.phase}</span>
            </button></li>) : liveRecords.map(item => <li key={item.sequence}><button aria-pressed={selectedSequence === item.sequence}
              onClick={() => setSelectedSequence(item.sequence)}><code>{item.sequence}. {item.event.type}</code><span>{item.phase}</span></button></li>)}</ol>
            {mode === 'live' && <p>仅保留当前进程最近的观测记录。</p>}
          </section>
          {snapshot && <section className="debug-context">
            <h3>上下文</h3>
            <details open><summary>reply · {snapshot.context.reply.code}</summary><pre>{json(snapshot.context.reply)}</pre></details>
            <details><summary>intents · {snapshot.context.intents.length}</summary><pre>{json(snapshot.context.intents)}</pre></details>
            <details><summary>context</summary><pre aria-label="任务上下文">{json(snapshot.context)}</pre></details>
          </section>}
        </aside>
      </div>
    </div>
  </div>;
}

