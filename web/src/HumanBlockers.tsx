import { useEffect, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { CircleAlert, X } from 'lucide-react';
import type { WebBlocker, WebBlockerAction } from '../../src/web/contracts';
import { api } from './api';

type Blocker = WebBlocker & { operation?: { workId: string; operationId: string; approvalId?: string }; scope?: 'task' | 'cleanup' };
interface OperationReview {
  processState: string; reviewDigest: string; operationId: string; sessionId: string;
  receipt: unknown; files: unknown[]; filesTruncated?: boolean;
}
function OperationReviewPanel({ roomId, blocker, connected }: { roomId: string; blocker: Blocker; connected: boolean }) {
  const [review, setReview] = useState<OperationReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  const identities = useRef(new Map<string, string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const read = async () => {
    if (!blocker.operation || busy || !connected) return;
    setBusy(true); setError(''); setSaved(false);
    const query = new URLSearchParams({ taskId: blocker.taskId, ...blocker.operation });
    try {
      const result = await api<OperationReview>(`/rooms/${encodeURIComponent(roomId)}/operation-review?${query}`);
      if (mounted.current) setReview(result);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '无法取得核对资料。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const confirm = async () => {
    if (!review || review.processState !== 'exited' || !blocker.operation || busy || !connected) return;
    setBusy(true); setError('');
    const id = identities.current.get(review.reviewDigest) ?? crypto.randomUUID(); identities.current.set(review.reviewDigest, id);
    try {
      await api(`/rooms/${encodeURIComponent(roomId)}/operation-reconcile`, { id, taskId: blocker.taskId,
        ...blocker.operation, reviewDigest: review.reviewDigest });
      if (mounted.current) setSaved(true);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '核对未确认，请重新读取。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section aria-label="执行效果核对">
    <Button disabled={busy || !connected} onClick={() => { void read(); }}>{review ? '重新读取执行记录' : '核对执行'}</Button>
    {review && <>
      <p>进程状态：{review.processState === 'exited' ? '已退出，可核对实际影响' : '尚未确认退出，暂不能结算'}</p>
      <pre aria-label="原执行回执和文件清单">{JSON.stringify({ receipt: review.receipt, files: review.files, filesTruncated: review.filesTruncated }, null, 2)}</pre>
      <Button disabled={busy || !connected || review.processState !== 'exited' || saved} onClick={() => { void confirm(); }}>确认已核对执行效果</Button>
    </>}
    {saved && <p role="status">核对已保存，等待任务状态同步。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function HumanBlockers({ roomId, blockers, connected, expiredTaskIds = [], availableHostApprovalIds = [] }: {
  roomId: string; blockers: Blocker[]; connected: boolean; expiredTaskIds?: readonly string[]; availableHostApprovalIds?: readonly string[];
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [extra, setExtra] = useState('');
  const [minutes, setMinutes] = useState('15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seen = useRef(new Set<string>());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const identities = useRef(new Map<string, string>());
  const key = (request: Blocker) => `${request.id}:${request.version}`;
  const pending = blockers.filter(request => request.status === 'open' && !acknowledged.includes(key(request)));
  const skipped = blockers.filter(request => request.status === 'skipped');
  const active = pending.find(request => key(request) === activeKey);
  const identity = pending.map(key).join('\n');
  const approvalIdentity = availableHostApprovalIds.join('\n');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (active) return;
    const next = pending.find(request => !seen.current.has(key(request))
      && !(request.operation?.approvalId && availableHostApprovalIds.includes(request.operation.approvalId)));
    if (next) { seen.current.add(key(next)); setActiveKey(key(next)); setText(''); setExtra(''); setError(''); }
    else setActiveKey(null);
  }, [identity, activeKey, approvalIdentity]);
  const decide = async (request: Blocker, action: WebBlockerAction) => {
    if (inFlight.current || !connected) return;
    if (action.requiresText && !text.trim()) { setError('请填写明确回复。'); return; }
    const extraOrdinary = extra ? Number(extra) : undefined;
    const newWindowMs = action.allowsNewWindowMs ? Number(minutes) * 60_000 : undefined;
    if (action.allowsExtraOrdinary && extraOrdinary !== undefined && (!Number.isSafeInteger(extraOrdinary) || extraOrdinary <= 0)) { setError('追加额度应为正整数。'); return; }
    if (action.allowsNewWindowMs && (!Number.isSafeInteger(newWindowMs) || newWindowMs! <= 0)) { setError('请填写有效的新处理时长。'); return; }
    const payload = { taskId: request.taskId, blockerId: request.id, blockerVersion: request.version, actionId: action.id,
      ...(text.trim() ? { text: text.trim() } : {}), ...(action.allowsExtraOrdinary && extraOrdinary !== undefined ? { extraOrdinary } : {}),
      ...(newWindowMs !== undefined ? { newWindowMs } : {}) };
    const serialized = JSON.stringify(payload);
    const id = identities.current.get(serialized) ?? crypto.randomUUID(); identities.current.set(serialized, id);
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(`/rooms/${encodeURIComponent(roomId)}/blocker-decision`, { id, ...payload });
      if (mounted.current) { setAcknowledged(previous => [...previous, key(request)]); setActiveKey(null); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '回复未确认，请重试。'); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  if (!pending.length && !skipped.length) return null;
  return <div className="host-approvals" aria-label="待处理请求">
    {!active && pending.some(request => request.scope !== 'cleanup' && request.requiredHuman && expiredTaskIds.includes(request.taskId))
      && <p role="status">自动处理窗口已耗尽，仍等待你的明确回复。</p>}
    {skipped.map(request => <p key={key(request)} role="status">已按你的明确授权跳过内容：{request.question}。未决执行效果仍需单独核对。</p>)}
    {pending.map(request => <Button className="host-approval-card" key={key(request)} onClick={() => { setActiveKey(key(request)); setError(''); }}>
      <CircleAlert size={16} />{request.title}：{request.question}
    </Button>)}
    <Dialog.Root open={!!active} onOpenChange={open => { if (!open) setActiveKey(null); }}>
      <Dialog.Portal><Dialog.Backdrop className="host-approval-backdrop" />
        <Dialog.Popup className="host-approval-dialog" aria-busy={busy}>
          <div className="host-approval-heading"><Dialog.Title>{active?.title ?? '需要你的处理'}</Dialog.Title>
            <Dialog.Close aria-label="暂时关闭处理提示"><X size={18} /></Dialog.Close></div>
          {active && <>
            <Dialog.Description>{active.question}</Dialog.Description>
            {active.scope !== 'cleanup' && expiredTaskIds.includes(active.taskId)
              && <p role="status">自动处理窗口已耗尽，仍等待你的明确回复。</p>}
            <p>{active.requiredHuman ? '需要你明确回复；关闭提示或等待不会代替你的决定。' : '请明确选择处理方式，跳过只省略指定内容。'}</p>
            {active.operation && !active.operation.approvalId ? <OperationReviewPanel key={key(active)} roomId={roomId} blocker={active} connected={connected} /> : <>
              {active.operation?.approvalId ? <>
                <p>请在宿主授权卡片核对完整命令并明确批准或拒绝；已过期的授权不能继续执行。关闭提示不会代替决定。</p>
                {availableHostApprovalIds.includes(active.operation.approvalId)
                  ? <Button disabled={busy} onClick={() => setActiveKey(null)}>查看宿主授权卡片</Button>
                  : <p>原授权当前不可用。你可以明确跳过此命令或停止任务；关闭提示仍会保留待处理状态。</p>}
              </> : <>
                <label>明确回复<textarea aria-label="决定回复" value={text} onChange={event => setText(event.target.value)} disabled={busy} /></label>
                {active.actions.some(action => action.allowsExtraOrdinary) && <label>追加执行额度<input aria-label="追加执行额度" type="number" min="1" step="1" value={extra} onChange={event => setExtra(event.target.value)} disabled={busy} /></label>}
                {active.actions.some(action => action.allowsNewWindowMs) && <label>新处理时长（分钟）<input aria-label="新处理时长（分钟）" type="number" min="1" value={minutes} onChange={event => setMinutes(event.target.value)} disabled={busy} /></label>}
              </>}
              <div className="host-approval-actions">{active.actions.map(action => <Button key={action.id} disabled={busy || !connected}
                onClick={() => { void decide(active, action); }}>{action.label}</Button>)}</div>
            </>}
            {error && <p role="alert">{error}</p>}
          </>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
