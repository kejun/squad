import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import type { DeletedRoom, WebRoom } from '../../src/web/contracts';

const deletionLabel = { preparing: '正在准备删除', waiting: '删除等待核对', deleting: '正在清理会话', paused: '删除已暂停' };

export function RoomDeletion({ room, connected, onDelete, onRetry }: {
  room: WebRoom; connected: boolean;
  onDelete: (room: WebRoom) => Promise<WebRoom | DeletedRoom>;
  onRetry: (room: WebRoom) => Promise<WebRoom | DeletedRoom>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmedRoom, setConfirmedRoom] = useState<WebRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async (retry: boolean) => {
    if (inFlight.current || !connected) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await (retry ? onRetry(room) : onDelete(confirmedRoom ?? room));
      if (mounted.current) { setOpen(false); setConfirmedRoom(null); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '删除请求未确认，请重试。');
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const deletion = room.deletion;
  return <>
    <Button className="icon-button room-delete-action" aria-label={`${deletion ? '查看删除状态' : '删除归档群聊'} ${room.title}`}
      disabled={!connected || busy} onClick={() => { setConfirmedRoom(room); setOpen(true); setError(''); }}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
    </Button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal><Dialog.Backdrop className="host-approval-backdrop" />
        <Dialog.Popup className="host-approval-dialog" aria-busy={busy}>
          <div className="host-approval-heading">
            <Dialog.Title>{deletion ? deletionLabel[deletion.status] : '删除归档群聊'}</Dialog.Title>
            <Dialog.Close aria-label="关闭删除提示"><X size={18} /></Dialog.Close>
          </div>
          <Dialog.Description>{room.title}</Dialog.Description>
          {deletion ? <>
            <p role="status">{deletion.reason || '删除流程已保存，正在安全清理。'}</p>
            {deletion.remaining.length > 0 && <ul aria-label="删除剩余项">{deletion.remaining.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>}
            <p>全部清理核对完成后才会移除此会话。需要核对的执行可从该会话的待处理请求进入。</p>
          </> : <>
            <p>这将永久删除此群聊的任务、消息、产物、执行记录和可证明独占的运行文件，无法恢复。</p>
            <p>未完成工作将停止派发，等待安全结算或清理接管。未知效果仍需核对，其他会话和共享工程不会删除。</p>
          </>}
          {error && <p role="alert">{error}</p>}
          <div className="host-approval-actions">
            <Dialog.Close disabled={busy}>{deletion ? '暂时关闭' : '取消删除'}</Dialog.Close>
            {deletion ? deletion.canRetry && <Button className="primary" disabled={busy || !connected} onClick={() => { void submit(true); }}>重试清理</Button>
              : <Button className="primary" disabled={busy || !connected} onClick={() => { void submit(false); }}>{busy ? '提交中…' : '确认永久删除'}</Button>}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

export function RoomDeletionStatus({ room }: { room: WebRoom }) {
  if (!room.deletion) return null;
  return <div className="config-banner" role="status"><span>{deletionLabel[room.deletion.status]}：{room.deletion.reason || '正在安全清理，完成后移除会话。'}</span></div>;
}
