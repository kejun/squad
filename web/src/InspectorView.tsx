import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { DebugEvent } from '../../src/task-debug';
import { createInspectorWindow, type InspectorSelection, type InspectorWindowStatus } from './inspector-window';

export function InspectorView({ snapshot, event, identity }: { snapshot: unknown; event: DebugEvent | undefined; identity: string }) {
  const latest = useRef<InspectorSelection>({ identity, frame: { snapshot, event } });
  latest.current = { identity, frame: { snapshot, event } };
  const session = useRef<ReturnType<typeof createInspectorWindow> | null>(null);
  const [status, setStatus] = useState<InspectorWindowStatus | null>(null);
  useEffect(() => () => { session.current?.dispose(); session.current = null; }, []);
  useEffect(() => { session.current?.update(latest.current); }, [snapshot, event, identity]);

  function open() {
    session.current ??= createInspectorWindow({
      // Keep opener: the official receiver uses it for its postMessage handshake.
      open: () => window.open('about:blank', '_blank'),
      listen(receive) {
        const listener = (message: MessageEvent) => receive(message);
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
      },
      watchClosed(check) { const timer = window.setInterval(check, 1000); return () => window.clearInterval(timer); },
    }, setStatus);
    session.current.open(latest.current);
  }
  return <>
    <button disabled={!snapshot} onClick={open} title="在新标签页打开官方 Inspector">官方 Inspector <ExternalLink size={14} aria-hidden="true" /></button>
    {status?.phase === 'blocked' && <p role="alert">浏览器阻止了新标签页，请允许弹窗后再次点击官方 Inspector。</p>}
    {status?.phase === 'error' && <p role="alert">{status.error}。请关闭官方标签页后重试，或继续使用本地图。</p>}
    {status && !['blocked', 'error', 'closed'].includes(status.phase) && <p role="status">
      {status.phase === 'connected' ? '官方 Inspector 已连接。' : '已在新标签页打开官方 Inspector。'}
      如出现401，请在Stately页面登录，再刷新该标签页。所选快照会发送到官方页面。
    </p>}
  </>;
}
