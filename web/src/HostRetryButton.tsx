import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import type { WebFailedSandboxCommand } from '../../src/web/contracts';
import { api } from './api';

const reasons: Record<string, string> = { STOPPED: '任务已停止', STALE_WORK: '任务目标已变化', ROOM_BUSY: '另一任务已成为当前任务',
  UNRESOLVED_WORK: '等待当前操作结算或核对', WAIT_FOR_BOUNDARY: '等待讨论或评审结束', LOCAL_TOOLS_DISABLED: '本地工具权限已关闭',
  BUDGET_EXHAUSTED: '执行额度不足', HOST_RETRY_EFFECTS_REVIEW_REQUIRED: '请先核对上次命令的写入效果',
  INCOMPATIBLE_EXECUTION: '请先恢复任务', OWNER_UNAVAILABLE: '负责人不可用', LOCAL_RUNTIME_NOT_CONFIGURED: '本地运行时未开启' };

export function HostRetryButton({ roomId, command, connected }: { roomId: string; command: WebFailedSandboxCommand; connected: boolean }) {
  const [busy, setBusy] = useState(false), [requested, setRequested] = useState(false), [error, setError] = useState('');
  const sending = useRef(false), commandId = useRef<string | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = async () => {
    if (sending.current || !command.canRequest || !connected || requested) return;
    sending.current = true; setBusy(true); setError(''); commandId.current ??= crypto.randomUUID();
    try {
      await api(`/rooms/${encodeURIComponent(roomId)}/host-retry`, { id: commandId.current, taskId: command.taskId, workId: command.workId,
        operationId: command.operationId, sourceRequestHash: command.sourceRequestHash });
      if (mounted.current) setRequested(true);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '申请失败，请重试。'); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const already = requested || command.unavailableReason === 'HOST_RETRY_ALREADY_REQUESTED';
  return <section className="sandbox-failure" aria-label="失败的沙箱命令">
    <code>{[command.executable, ...command.args].map(value => JSON.stringify(value)).join(' ')}</code>
    <p>{command.error}</p>
    <Button disabled={!connected || busy || !command.canRequest || already} onClick={() => { void request(); }}>
      {busy ? '正在申请…' : already ? '已申请宿主执行' : '请求在宿主执行'}
    </Button>
    {!command.canRequest && !already && <span>{reasons[command.unavailableReason] ?? '当前记录不可申请宿主执行'}</span>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
