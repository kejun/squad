import type { MachineGraph, SandboxPreview } from '../../src/task-debug';
import { DebugStepDetails } from './DebugStepDetails';
import type { DebugFrame } from '../../src/task-debug';

const fieldNames: Record<string, string> = { question: '问题', expected: '期望结果', caller: '发起者', target: '目标成员', text: '内容',
  answer: '返回内容', status: '结果状态', passed: '检查通过', gaps: '缺口', reason: '原因', decision: '决策', requestId: '协助请求',
  workId: '执行请求', discussionId: '讨论轮次', intentId: '执行请求', resultId: '结果标识', artifactIds: '产物标识', extraOrdinary: '追加额度' };
export function DebugEventEditor({ type, text, stale, error, events, preview, head, graph, onType, onText, onTemplate, onPreview, onSend, onRule }: {
  type: string; text: string; stale: boolean; error: string; events: string[]; preview: SandboxPreview | null;
  head: DebugFrame; graph: MachineGraph; onType: (type: string) => void; onText: (text: string) => void;
  onTemplate: () => void; onPreview: () => void; onSend: () => void; onRule: (rule: MachineGraph['transitions'][number]) => void;
}) {
  let data: Record<string, unknown> | undefined;
  try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) data = value; } catch { /* JSON remains editable. */ }
  const fields = data ? Object.entries(data).filter(([key]) => !['type', 'id', 'at', 'fence'].includes(key)) : [];
  const change = (key: string, value: unknown) => onText(JSON.stringify({ ...data, [key]: value }, null, 2));
  return <section className="debug-event-editor" aria-label="沙箱事件编辑">
    <div className="debug-section-title"><h3>发送事件</h3><span>从实验最新步骤执行</span></div>
    <div className="debug-editor-toolbar">
      <select aria-label="事件类型" value={type} onChange={e => onType(e.target.value)}>
        {!events.includes(type) && <option value={type}>{type}</option>}
        <optgroup label="人工输入">{events.filter(e => ['USER_INPUT', 'HUMAN_DECISION', 'CONTINUE', 'STOP', 'RETRY_ASSISTANCE'].includes(e)).map(e => <option key={e}>{e}</option>)}</optgroup>
        <optgroup label="执行结果与内部控制">{events.filter(e => !['USER_INPUT', 'HUMAN_DECISION', 'CONTINUE', 'STOP', 'RETRY_ASSISTANCE'].includes(e)).map(e => <option key={e}>{e}</option>)}</optgroup>
      </select><button onClick={onTemplate}>重新生成模板</button><button onClick={onPreview}>预演</button>
      <button className="debug-run" onClick={onSend}>单步执行</button>
    </div>
    {stale && <p className="debug-notice">执行头已变化，已保留草稿。可重新生成当前模板。</p>}
    <div className="debug-event-fields">{fields.map(([key, value]) => <label key={key}>{fieldNames[key] ?? key}
      {typeof value === 'boolean' ? <select aria-label={'参数 ' + key} value={String(value)} onChange={e => change(key, e.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select>
        : typeof value === 'string' || typeof value === 'number' ? <input aria-label={'参数 ' + key} value={String(value)}
          onChange={e => change(key, typeof value === 'number' ? Number(e.target.value) : e.target.value)} />
          : <code>{JSON.stringify(value)}（在高级 JSON 中编辑）</code>}
    </label>)}</div>
    <details className="debug-event-json"><summary>高级 JSON</summary>
      <textarea aria-label="事件参数 JSON" spellCheck={false} maxLength={100000} value={text} onChange={e => onText(e.target.value)} />
    </details>
    {error && <p className="debug-error" role="alert">{error}</p>}
    {preview && <details className="debug-preview" open><summary>预演结果 · 尚未推进实验</summary>
      <DebugStepDetails frame={preview.frame} previous={head} graph={graph} onRule={onRule} preview />
    </details>}
  </section>;
}
