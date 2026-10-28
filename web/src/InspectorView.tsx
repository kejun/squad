import { useEffect, useRef, useState } from 'react';
import { createActor } from 'xstate';
import { restoreTask, taskMachine } from '../../src/task.machine';
import { debugInput, type DebugEvent } from '../../src/task-debug';

export function InspectorView({ snapshot, event, identity }: { snapshot: unknown; event: DebugEvent | undefined; identity: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ snapshot, event });
  latest.current = { snapshot, event };
  const sink = useRef<((snapshot: unknown, event: DebugEvent | undefined) => void) | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    setError('');
    void import('@statelyai/inspect').then(({ createBrowserInspector }) => {
      if (disposed || !iframe.current) return;
      const inspector = createBrowserInspector({ iframe: iframe.current });
      stop = () => { sink.current = null; inspector.stop(); };
      // Metadata only: this actor is never started or sent business events.
      // Passing a real machine ref supplies logic.config; string-only registrations omit the graph in inspect 0.7.2.
      const restored = restoreTask(structuredClone(latest.current.snapshot));
      const metadata = createActor(taskMachine, { id: identity, snapshot: restored, input: debugInput() });
      inspector.actor(metadata, { status: 'active', value: restored.value, context: restored.context });
      sink.current = (value, trigger) => {
        const next = restoreTask(structuredClone(value));
        if (trigger) inspector.event(metadata, trigger);
        inspector.snapshot(metadata, { status: 'active', value: next.value, context: next.context }, trigger ? { event: trigger } : undefined);
      };
      sink.current(latest.current.snapshot, latest.current.event);
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Inspector 加载失败'); });
    return () => { disposed = true; stop?.(); };
  }, [identity]);
  useEffect(() => { sink.current?.(snapshot, event); }, [snapshot, event]);
  return <div className="debug-inspector">
    <p>此视图会将所选快照交给 Stately 托管界面。事件操作仍在本页的内存沙箱执行。</p>
    {error && <p role="alert">{error}。可切回本地图继续调试。</p>}
    <iframe ref={iframe} title="Stately Inspector" src="https://stately.ai/inspect" referrerPolicy="no-referrer" />
  </div>;
}

