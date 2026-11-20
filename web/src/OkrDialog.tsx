import { useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { keyResultStatuses, type KeyResultStatus, type OkrObjective } from '../../src/types';
import { api } from './api';

const statusLabels: Record<KeyResultStatus, string> = {
  pending: '待推进', inProgress: '进行中', achieved: '已达成',
};

type Change =
  | { action: 'objective'; title: string }
  | { action: 'keyResult'; objectiveId: string; title: string }
  | { action: 'status'; keyResultId: string; status: KeyResultStatus };

export function OkrDialog({ roomId, objectives, open, onOpenChange, editable }: {
  roomId: string; objectives: OkrObjective[]; open: boolean;
  onOpenChange: (open: boolean) => void; editable: boolean;
}) {
  const [objectiveTitle, setObjectiveTitle] = useState('');
  const [addingTo, setAddingTo] = useState<string>();
  const [resultTitle, setResultTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ payload: string; id: string } | undefined>(undefined);
  const disabled = saving || !editable;

  async function save(change: Change) {
    if (disabled) return false;
    setSaving(true);
    setError('');
    const payload = JSON.stringify(change);
    const id = pending.current?.payload === payload ? pending.current.id : crypto.randomUUID();
    pending.current = { payload, id };
    try {
      await api(`/rooms/${roomId}/okr`, { id, ...change });
      pending.current = undefined;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
      return false;
    } finally { setSaving(false); }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="host-approval-backdrop" />
        <Dialog.Popup className="host-approval-dialog okr-dialog" aria-busy={saving}>
          <header className="host-approval-heading">
            <Dialog.Title>群聊 OKR</Dialog.Title>
            <Dialog.Close aria-label="关闭 OKR"><X size={18} /></Dialog.Close>
          </header>
          {error && <p role="alert">{error}</p>}
          {objectives.map(objective => (
            <section className="okr-objective" key={objective.id}>
              <h3>{objective.title}</h3>
              {objective.keyResults.map(result => (
                <label className="okr-result" key={result.id}>
                  <span>{result.title}</span>
                  <select aria-label={`${result.title}的状态`} value={result.status} disabled={disabled}
                    onChange={event => { void save({ action: 'status', keyResultId: result.id, status: event.target.value as KeyResultStatus }); }}>
                    {keyResultStatuses.map(status => <option value={status} key={status}>{statusLabels[status]}</option>)}
                  </select>
                </label>
              ))}
              {addingTo === objective.id ? (
                <form className="okr-form" onSubmit={event => {
                  event.preventDefault();
                  if (!resultTitle.trim()) return;
                  void save({ action: 'keyResult', objectiveId: objective.id, title: resultTitle.trim() }).then(saved => {
                    if (saved) { setAddingTo(undefined); setResultTitle(''); }
                  });
                }}>
                  <input aria-label="关键结果名称" placeholder="关键结果" maxLength={200} value={resultTitle} disabled={disabled}
                    onChange={event => setResultTitle(event.target.value)} />
                  <Button type="submit" disabled={disabled || !resultTitle.trim()}>添加</Button>
                  <Button disabled={disabled} onClick={() => { setAddingTo(undefined); setResultTitle(''); }}>取消</Button>
                </form>
              ) : <Button disabled={disabled} onClick={() => { setAddingTo(objective.id); setResultTitle(''); }}>添加关键结果</Button>}
            </section>
          ))}
          <form className="okr-form" onSubmit={event => {
            event.preventDefault();
            if (!objectiveTitle.trim()) return;
            void save({ action: 'objective', title: objectiveTitle.trim() }).then(saved => { if (saved) setObjectiveTitle(''); });
          }}>
            <input aria-label="目标名称" placeholder="目标" maxLength={200} value={objectiveTitle} disabled={disabled}
              onChange={event => setObjectiveTitle(event.target.value)} />
            <Button type="submit" disabled={disabled || !objectiveTitle.trim()}>新增目标</Button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
