import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { LoaderCircle, Trash2 } from 'lucide-react';
import type { DeletedRoom, WebRoom } from '../../src/web/contracts';

const deletionLabel = { preparing: '正在准备删除', waiting: '删除等待核对', deleting: '正在清理会话', paused: '删除已暂停' };

export function RoomDeletion({ room, connected, onDelete }: {
  room: WebRoom; connected: boolean;
  onDelete: (room: WebRoom) => Promise<WebRoom | DeletedRoom>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async () => {
    if (inFlight.current || !connected) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await onDelete(room); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '删除未提交，请重试。'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <>
    <Button className="icon-button room-delete-action" aria-label={`删除归档群聊 ${room.title}`} title="强制永久删除"
      disabled={!connected || busy} onClick={() => { void submit(); }}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
    </Button>
    {error && <span role="alert">{error}</span>}
  </>;
}

export function RoomDeletionStatus({ room }: { room: WebRoom }) {
  if (!room.deletion) return null;
  return <div className="config-banner" role="status"><span>{deletionLabel[room.deletion.status]}：{room.deletion.reason || '正在安全清理，完成后移除会话。'}</span></div>;
}
