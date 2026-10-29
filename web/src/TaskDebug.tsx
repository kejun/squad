import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, X } from 'lucide-react';
import { debugEventTemplate, debugInput, taskGraph, TaskSandbox, type DebugFrame, type MachineTransition, type SandboxPreview } from '../../src/task-debug';
import { persistTask, restoreTask, type TaskSnapshot } from '../../src/task.machine';
import { completionLabel, contextOf, frameKey, frameSummary, phaseNames, previousFrame, selectDebugFrame, waitingItems } from '../../src/task-debug-view';
import type { Phase } from '../../src/types';
import { StateGraph } from './StateGraph';
import { DebugRules, DebugRuleDetails } from './DebugRules';
import { DebugStepDetails, JsonDisclosure } from './DebugStepDetails';
import { DebugEventEditor } from './DebugEventEditor';
import { useDebugFeed } from './use-debug-feed';

const InspectorView = lazy(() => import('./InspectorView').then(module => ({ default: module.InspectorView })));
const json = (value: unknown) => JSON.stringify(value, null, 2);
type Draft = { type: string; text: string; headId: string; dirty: boolean };
const makeDraft = (sandbox: TaskSandbox, type = 'HELP'): Draft => ({ type, text: json(debugEventTemplate(sandbox.snapshot, type)), headId: sandbox.headId, dirty: false });

export function TaskDebug({ roomId, onClose }: { roomId: string | null; onClose: () => void }) {
  const graph = useMemo(taskGraph, []);
  const [mode, setMode] = useState<'live' | 'sandbox'>(roomId ? 'live' : 'sandbox');
  const [sandboxes, setSandboxes] = useState(() => [new TaskSandbox()]);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const sandbox = sandboxes.find(item => item.id === sandboxId) ?? sandboxes[0]!;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({ [sandbox.id]: makeDraft(sandbox) }));
  const draft = drafts[sandbox.id]!;
  const [revision, setRevision] = useState(0);
  const [taskId, setTaskId] = useState('');
  const [liveSelection, setLiveSelection] = useState<{ session: string; task: string; key: string } | null>(null);
  const [view, setView] = useState<'run' | 'graph' | 'rules' | 'inspector'>('run');
  const [inputText, setInputText] = useState(() => json(debugInput()));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [preview, setPreview] = useState<SandboxPreview | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { feed, error: connectionError } = useDebugFeed(roomId, taskId, mode === 'live');
  const simSnapshot = useMemo(() => sandbox.snapshot, [sandbox, revision]);
  const liveSnapshot = useMemo(() => {
    if (!feed?.current?.snapshot) return null;
    try { return restoreTask(structuredClone(feed.current.snapshot)); } catch { return null; }
  }, [feed?.current?.snapshot]);
  const snapshot = mode === 'sandbox' ? simSnapshot : liveSnapshot;
  const phase = snapshot?.value as Phase | undefined;
  const frames: readonly DebugFrame[] = mode === 'sandbox' ? sandbox.history : feed?.records.filter(record => record.taskId === feed.current?.taskId) ?? [];
  const liveKey = liveSelection?.key ?? null;
  const frame = mode === 'sandbox' ? sandbox.selected : liveSelection && (liveSelection.session !== feed?.sessionId || liveSelection.task !== feed?.current?.taskId)
    ? undefined : selectDebugFrame(frames, liveKey);
  const history = mode === 'sandbox' ? sandbox.index !== sandbox.history.length - 1 : liveSelection !== null;
  const missing = history && !frame;
  const previous = frame ? previousFrame(frame, frames) : undefined;
  const rule = graph.transitions.find(item => item.id === selectedRule);
  const focused = focus ?? phase ?? graph.initial;
  const validPreview = mode === 'sandbox' && preview && sandbox.isPreviewCurrent(preview, draft.text) ? preview : null;
  const events = useMemo(() => [...new Set(graph.transitions.map(t => t.event).filter(e => e !== '@always' && e !== '*'))].sort(), [graph]);
  const waits = useMemo(() => snapshot ? waitingItems(snapshot.context) : [], [snapshot]);

  useEffect(() => {
    const previousElement = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; previousElement?.focus(); };
  }, []);

  const retain = (items: TaskSandbox[]) => {
    const kept = [...items];
    while (kept.length > 1 && (kept.length > 4 || kept.reduce((sum, item) => sum + item.bytes, 0) > 8 * 1024 * 1024)) kept.shift();
    if (kept.length < items.length) setNotice('已达到会话容量，较早的沙箱已移出列表。');
    setSandboxes(kept);
    setDrafts(old => Object.fromEntries(Object.entries(old).filter(([id]) => kept.some(item => item.id === id))));
  };
  const addSandbox = (next: TaskSandbox, event = 'HELP') => {
    retain([...sandboxes, next]);
    setDrafts(old => ({ ...old, [next.id]: makeDraft(next, event) }));
    setSandboxId(next.id); setMode('sandbox'); setError(''); setPreview(null); setSelectedRule(null); setView('run');
  };
  const startSandbox = (seed?: TaskSnapshot | null, event = 'HELP') => {
    try { addSandbox(new TaskSandbox(seed ? persistTask(seed) : undefined,
      seed ? { taskId: seed.context.taskId } : undefined), event); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const fork = () => {
    try {
      if (mode === 'sandbox') addSandbox(sandbox.fork());
      else if (frame && feed) addSandbox(new TaskSandbox(frame.snapshot, { taskId: feed.current!.taskId, stepId: frameKey(frame), runId: feed.sessionId }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const updateDraft = (next: Draft) => { setDrafts(old => ({ ...old, [sandbox.id]: next })); setPreview(null); setError(''); };
  const chooseEvent = (event: string) => {
    if (event === '@always') return;
    const type = event === '*' ? 'UNKNOWN_EVENT' : event;
    if (mode === 'live') startSandbox(snapshot, type);
    else updateDraft(makeDraft(sandbox, type));
  };
  const send = () => {
    try {
      sandbox.send(draft.text); setRevision(n => n + 1); setPreview(null); setError('');
      if (!draft.dirty) setDrafts(old => ({ ...old, [sandbox.id]: makeDraft(sandbox, draft.type) }));
      // Keep the current experiment if total memory requires evicting older runs.
      retain([...sandboxes.filter(item => item !== sandbox), sandbox]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const reset = () => {
    sandbox.reset(); setRevision(n => n + 1); updateDraft(makeDraft(sandbox, draft.type)); setSelectedRule(null);
  };
  const returnLatest = () => {
    if (mode === 'sandbox') { sandbox.select(sandbox.history.length - 1); setRevision(n => n + 1); }
    else setLiveSelection(null);
    setSelectedRule(null);
  };
  const selectRule = (next: MachineTransition) => { setSelectedRule(next.id); };
  const selectFrame = (next: DebugFrame, index: number) => {
    if (mode === 'sandbox') { sandbox.select(index); setRevision(n => n + 1); }
    else setLiveSelection({ session: feed!.sessionId, task: feed!.current!.taskId, key: frameKey(next) });
    setSelectedRule(null);
  };

  return <div className="debug-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="task-debug" role="dialog" aria-modal="true" aria-labelledby="task-debug-title" ref={dialog}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        if (event.key === 'Tab') {
          const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), select, textarea, input, iframe, summary, [tabindex="0"]')]
            .filter(node => !node.closest('[hidden]') && (!node.closest('details:not([open])') || (node.tagName === 'SUMMARY' && node.parentElement?.tagName === 'DETAILS' && !node.parentElement.parentElement?.closest('details:not([open])'))));
          const first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="debug-header"><div><Bug size={18} /><h2 id="task-debug-title">状态机调试</h2><code>{graph.id}</code></div>
        <button aria-label="关闭状态机调试" ref={closeButton} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="debug-toolbar">
        <div className="debug-tabs" role="group" aria-label="调试模式">
          <button aria-pressed={mode === 'live'} disabled={!roomId} onClick={() => { setMode('live'); setError(''); setPreview(null); }}>实时观测</button>
          <button aria-pressed={mode === 'sandbox'} onClick={() => { setMode('sandbox'); setError(''); }}>沙箱仿真</button>
        </div>
        {mode === 'live' ? <select aria-label="观测任务" value={taskId} onChange={e => { setTaskId(e.target.value); setLiveSelection(null); setSelectedRule(null); setFocus(null); }}>
          <option value="">当前或最近任务</option>{feed?.tasks.map(task => <option key={task.id} value={task.id}>{task.id} · {task.phase}</option>)}
        </select> : <select aria-label="选择沙箱" value={sandbox.id} onChange={e => { setSandboxId(e.target.value); setError(''); setPreview(null); setSelectedRule(null); }}>
          {sandboxes.map(item => <option key={item.id} value={item.id}>{item.id}{item.origin ? ' · 分支' : ''}</option>)}
        </select>}
        <button onClick={() => startSandbox()}>新建沙箱</button>
        {mode === 'live' && <button disabled={!snapshot} onClick={() => startSandbox(snapshot)}>复制最新到沙箱</button>}
        {mode === 'sandbox' && <button onClick={reset}>重置</button>}
        <details className="debug-advanced"><summary>高级</summary><div className="debug-advanced-content"><button disabled={!snapshot} onClick={() => setView('inspector')}>官方 Inspector</button>
          {mode === 'sandbox' && <><textarea aria-label="初始输入 JSON" value={inputText} maxLength={100000} spellCheck={false} onChange={e => setInputText(e.target.value)} />
            <button onClick={() => { try { addSandbox(TaskSandbox.fromInput(inputText)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>应用初始输入</button></>}
        </div></details>
      </div>
      <div className="debug-state-summary" aria-live="polite">
        <strong>{phase ? phaseNames[phase] : '等待任务'} <code data-testid="debug-phase">{phase}</code></strong>
        {snapshot && <><span>{snapshot.context.config.bots.find(bot => bot.id === snapshot.context.owner)?.name ?? snapshot.context.owner}</span>
          {completionLabel(snapshot.context) && <span>{completionLabel(snapshot.context)}</span>}
          <span>轮次 {snapshot.context.epoch} · 目标 {snapshot.context.goalVersion}</span><span>普通额度 {snapshot.context.usage.ordinary}/{snapshot.context.config.limits.ordinary}</span></>}
        <span className="debug-mode-note">{mode === 'sandbox' ? '实验最新状态 · 无外部执行' : connectionError ? '最近收到的快照 · 连接中断' : '最新已提交状态'}</span>
      </div>
      {mode === 'live' && connectionError && <p className="debug-notice is-error" role="alert">观测连接中断：{connectionError}。当前显示最近收到的快照。</p>}
      {mode === 'live' && feed?.truncated && <p className="debug-notice" role="status">历史已裁剪或进程已重启，已重新同步当前快照。</p>}
      {mode === 'sandbox' && sandbox.truncated && <p className="debug-notice" role="status">沙箱只保留最近100步及4MiB以内轨迹，较早记录已裁剪。</p>}
      {notice && <p className="debug-notice" role="status">{notice}</p>}
      {mode === 'live' && error && <p className="debug-error" role="alert">{error}</p>}
      <div className="debug-view-tabs" role="group" aria-label="调试视图">
        <button aria-pressed={view === 'run'} onClick={() => setView('run')}>当前运行</button>
        <button aria-pressed={view === 'graph'} onClick={() => setView('graph')}>完整状态图</button>
        <button aria-pressed={view === 'rules'} onClick={() => setView('rules')}>转移规则</button>
      </div>
      {history && <div className="debug-viewing-history"><p role="status">{missing ? '所选步骤已不在可用历史中' : '正在查看历史步骤 ' + frameKey(frame!)} · 最新状态 {phase}</p><button onClick={returnLatest}>返回最新</button></div>}
      <div className={'debug-body' + (view === 'graph' ? ' is-graph' : '')}>
        <main className="debug-main">
          {view === 'run' && <>
            <section className="debug-waiting" aria-label="当前等待事项"><h3>当前等待</h3>
              {!snapshot && <p>当前群还没有任务，可新建沙箱。</p>}
              <ul>{waits.map(item => <li key={item.id}><span>{item.text}</span><details><summary>依据</summary><code>{item.detail}</code></details></li>)}</ul>
            </section>
            <section className="debug-history" aria-label="本次运行轨迹">
              <div className="debug-section-title"><h3>本次运行 · {frames.length}条记录</h3></div>
              {mode === 'sandbox' && sandbox.origin && <details className="debug-origin"><summary>复制基线 · 来源步骤 {sandbox.origin.stepId?.split(':').at(-1) ?? '当前快照'}</summary>
                <code>任务 {sandbox.origin.taskId} · 运行 {sandbox.origin.runId ?? '未记录'} · 步骤 {sandbox.origin.stepId ?? '未记录'}</code></details>}
              <ol>{frames.map((item, index) => <li key={frameKey(item)}><button aria-label={'查看步骤 ' + index} aria-pressed={frame === item}
                onClick={() => selectFrame(item, index)}><span className="debug-history-event"><code>{index}. {item.event.type}</code><span>{item.phase}</span></span>
                <span>{frameSummary(item, graph)}</span></button></li>)}</ol>
              {!frames.length && <p>从当前基线开始观测，尚无可用的执行记录。</p>}
            </section>
          </>}
          {view === 'graph' && <><StateGraph graph={graph} active={phase} historical={history ? frame?.phase : undefined} focus={focused} onFocus={setFocus}
            onRule={id => { setSelectedRule(id); }} onGlobals={() => { setFocus('*'); setView('rules'); }} />
            <button className="debug-graph-rule-link" onClick={() => setView('rules')}>查看所选状态的全部规则 · {focused}</button></>}
          {view === 'rules' && <DebugRules graph={graph} focus={focused} onFocus={setFocus} selected={selectedRule} onSelect={selectRule} />}
          {view === 'inspector' && snapshot && <Suspense fallback={<p role="status">加载 Inspector…</p>}><InspectorView
            snapshot={frame?.snapshot ?? persistTask(snapshot)} event={frame?.event} identity={mode + ':' + (mode === 'live' ? feed?.sessionId + ':' + feed?.current?.taskId : sandbox.id)} /></Suspense>}
        </main>
        <aside className="debug-side" aria-label="调试详情" hidden={view === 'graph' && !rule}>
          {rule ? <><button onClick={() => setSelectedRule(null)}>{view === 'graph' ? '关闭规则详情' : '返回步骤详情'}</button><DebugRuleDetails rule={rule} graph={graph} frame={frame} onFill={chooseEvent} canFill={!!snapshot} /></>
            : frame ? <><div className="debug-section-title"><span>{history ? '历史步骤' : '最新步骤'}</span><button onClick={fork}>从此步新建沙箱</button></div>
              <DebugStepDetails key={frameKey(frame)} frame={frame} previous={previous} graph={graph} onRule={next => { selectRule(next); setFocus(next.source); setView('rules'); }} /></>
              : <><p>{missing ? '所选步骤已不在可用历史中，请返回最新。' : '选择一条运行记录查看解释。'}</p>
                {snapshot && <JsonDisclosure title="当前基线上下文" value={snapshot.context} label="任务上下文" />}</>}
        </aside>
      </div>
      {mode === 'sandbox' && <DebugEventEditor type={draft.type} text={draft.text} stale={draft.headId !== sandbox.headId} error={error}
        events={events} preview={validPreview} head={sandbox.history.at(-1)!} graph={graph}
        onType={chooseEvent} onText={text => {
          let type = draft.type; try { const value = JSON.parse(text); if (typeof value?.type === 'string') type = value.type; } catch { /* Keep editing. */ }
          updateDraft({ ...draft, text, type, dirty: true });
        }} onTemplate={() => updateDraft(makeDraft(sandbox, draft.type))}
        onPreview={() => { try { setPreview(sandbox.preview(draft.text)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}
        onSend={send} onRule={next => { selectRule(next); setView('rules'); setFocus(next.source); }} />}
    </div>
  </div>;
}
