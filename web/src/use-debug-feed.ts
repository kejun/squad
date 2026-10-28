import { useEffect, useState } from 'react';
import type { DebugFeed } from '../../src/task-debug';
import { api } from './api';

export function mergeDebugFeed(previous: DebugFeed | null, next: DebugFeed): DebugFeed {
  const changedSession = !!previous && previous.sessionId !== next.sessionId;
  const all = [...(changedSession || next.truncated ? [] : previous?.records ?? []), ...next.records];
  const records: DebugFeed['records'] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (let index = all.length - 1; index >= 0 && records.length < 200; index--) {
    const record = all[index]!;
    const size = encoder.encode(JSON.stringify(record)).byteLength;
    if (bytes + size > 4 * 1024 * 1024) break;
    records.push(record); bytes += size;
  }
  return { ...next, records: records.reverse(),
    truncated: next.truncated || changedSession || !!previous?.truncated || records.length < all.length };
}

export function useDebugFeed(roomId: string | null, taskId: string, enabled: boolean) {
  const [feed, setFeed] = useState<DebugFeed | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setFeed(null); setError('');
    if (!roomId || !enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let session = '';
    async function poll() {
      try {
        const query = new URLSearchParams({ after: String(cursor) });
        if (session) query.set('session', session);
        if (taskId) query.set('task', taskId);
        const next = await api<DebugFeed>('/debug/rooms/' + encodeURIComponent(roomId!) + '?' + query, undefined, controller.signal);
        if (controller.signal.aborted) return;
        cursor = next.cursor; session = next.sessionId;
        setFeed(previous => mergeDebugFeed(previous, next));
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '观测连接中断');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 500);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [roomId, taskId, enabled]);
  return { feed, error };
}

