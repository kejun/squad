import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from '@base-ui/react/button';
import { ShieldAlert, X } from 'lucide-react';
import type { WebHostApproval } from '../../src/web/contracts';
import { api } from './api';

/** A projection of durable requests. Closing the dialog never sends a decision. */
export function HostApprovals({ roomId, requests, connected }: { roomId: string; requests: WebHostApproval[]; connected: boolean }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef(new Set<string>());
  const inFlight = useRef(false);
  const commandIds = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = requests.filter(r => !resolved.includes(r.approvalId));
  const active = pending.find(r => r.approvalId === activeId);
  const identity = pending.map(r => r.approvalId).join('\n');
  useEffect(() => {
    if (active) return;
    const next = pending.find(r => !seen.current.has(r.approvalId));
    if (next) { seen.current.add(next.approvalId); setActiveId(next.approvalId); setError(''); }
    else setActiveId(null);
  }, [identity, activeId]); // IDs identify immutable requests; polling doesn't reopen dismissed dialogs.
  const decide = async (request: WebHostApproval, decision: 'approve' | 'deny') => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const key = `${request.approvalId}:${decision}`;
    const id = commandIds.current.get(key) ?? crypto.randomUUID(); commandIds.current.set(key, id);
    try {
      await api(`/rooms/${encodeURIComponent(roomId)}/host-approval`, { id, taskId: request.taskId, workId: request.workId,
        operationId: request.operationId, approvalId: request.approvalId, decision });
      if (mounted.current) { setResolved(previous => [...previous, request.approvalId]); setActiveId(null); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '提交失败，请重试。'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  if (!pending.length) return null;
  return <div className="host-approvals">
    {pending.map(request => <Button key={request.approvalId} className="host-approval-card" onClick={() => { setActiveId(request.approvalId); setError(''); }}>
      <ShieldAlert size={16} aria-hidden="true" />等待宿主执行授权 <code>{request.executable.split('/').at(-1)}</code>
    </Button>)}
    <Dialog.Root open={!!active} onOpenChange={open => { if (!open && !busy) setActiveId(null); }}>
      <Dialog.Portal><Dialog.Backdrop className="host-approval-backdrop" />
        <Dialog.Popup className="host-approval-dialog" aria-busy={busy}>
          <div className="host-approval-heading"><Dialog.Title>请求在宿主执行命令</Dialog.Title>
            <Dialog.Close aria-label="暂时关闭授权提示" disabled={busy}><X size={18} /></Dialog.Close></div>
          {active && <>
            <Dialog.Description>本次将以 {active.account}@{active.host} 的权限执行，可访问工作区外的文件与网络。</Dialog.Description>
            <pre aria-label="请求执行的完整命令">{[active.executable, ...active.args].map(v => JSON.stringify(v)).join(' ')}</pre>
            <dl><dt>工作目录</dt><dd>{active.cwd}</dd><dt>请求原因</dt><dd>{active.reason}</dd></dl>
            {error && <p role="alert">{error}</p>}
            <div className="host-approval-actions">
              <Button disabled={busy || !connected} onClick={() => { void decide(active, 'deny'); }}>拒绝</Button>
              <Button className="primary" disabled={busy || !connected} onClick={() => { void decide(active, 'approve'); }}>{busy ? '提交中…' : '允许本次'}</Button>
            </div>
          </>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
