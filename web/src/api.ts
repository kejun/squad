import { useCallback, useEffect, useRef, useState } from "react";
import type { DeletedRoom, RoomSnapshot, WebRoom } from "../../src/web/contracts";
import type { ArtifactSourceMetadata } from "../../src/types";
import { mergeRooms, roomList } from './room-list';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    readonly sourceCandidates?: ArtifactSourceMetadata[], readonly deletionVersion?: number) { super(message); }
}

export async function api<T>(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
  });
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error ?? "请求失败，请重试。", response.status, value.code, value.sourceCandidates, value.deletionVersion);
  return value as T;
}

const deletedStorageKey = 'squad-deleted-rooms';
function savedDeletions(): DeletedRoom[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(deletedStorageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is DeletedRoom => !!item && typeof item.roomId === 'string'
      && item.status === 'deleted' && Number.isSafeInteger(item.deletionVersion) && item.deletionVersion >= 0)
      .map(item => ({ roomId: item.roomId, deletionVersion: item.deletionVersion, status: 'deleted' })) : [];
  } catch { return []; }
}
export interface WorkspaceState {
  rooms: WebRoom[]; roomId: string | null; snapshot: RoomSnapshot | null; connected: boolean; error: string;
  setError: (value: string) => void; chooseRoom: (id: string) => void; createRoom: () => Promise<string>;
  refreshRooms: () => Promise<WebRoom[]>; setRoomArchived: (id: string, archived: boolean) => Promise<WebRoom>;
  deletedRooms?: DeletedRoom[];
  deleteRoom?: (room: WebRoom) => Promise<WebRoom | DeletedRoom>;
  retryRoomDeletion?: (room: WebRoom) => Promise<WebRoom | DeletedRoom>;
}

export function useWorkspace(): WorkspaceState {
  const [rooms, setRooms] = useState<WebRoom[]>([]);
  const [roomId, setRoomId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("squad-room");
    } catch {
      return null;
    }
  });
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [deletedRooms, setDeletedRooms] = useState<DeletedRoom[]>(savedDeletions);
  const deletedCache = useRef(deletedRooms);
  const roomCache = useRef<WebRoom[]>([]);
  const commandIds = useRef(new Map<string, string>());
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;
  const selectRoom = useCallback((id: string | null) => {
    if (id && deletedCache.current.some(room => room.roomId === id)) return;
    activeRoom.current = id;
    setRoomId(id);
    setSnapshot(previous => previous?.room.id === id ? previous : null);
    try {
      if (id) localStorage.setItem("squad-room", id);
      else localStorage.removeItem("squad-room");
    } catch {
      /* Storage is optional. */
    }
    setError("");
  }, []);
  const acceptRooms = useCallback((incoming: WebRoom[], tombstones: DeletedRoom[] = []) => {
    if (tombstones.length) {
      const latest = new Map(deletedCache.current.map(room => [room.roomId, room]));
      for (const room of tombstones) {
        const previous = latest.get(room.roomId);
        if (!previous || room.deletionVersion > previous.deletionVersion)
          latest.set(room.roomId, { roomId: room.roomId, deletionVersion: room.deletionVersion, status: 'deleted' });
      }
      deletedCache.current = [...latest.values()];
      setDeletedRooms(deletedCache.current);
      try { localStorage.setItem(deletedStorageKey, JSON.stringify(deletedCache.current)); } catch { /* Optional browser storage. */ }
    }
    roomCache.current = mergeRooms(roomCache.current, incoming, deletedCache.current);
    setRooms(roomCache.current);
    if (activeRoom.current && deletedCache.current.some(room => room.roomId === activeRoom.current)) {
      const next = roomCache.current.find(room => !room.archived) ?? roomCache.current[0];
      selectRoom(next?.id ?? null);
    }
    return roomCache.current;
  }, [selectRoom]);
  const chooseRoom = useCallback((id: string) => selectRoom(id), [selectRoom]);
  const refreshRooms = useCallback(async () => {
    const result = await api<{ rooms: WebRoom[]; deletedRooms?: DeletedRoom[] }>("/rooms");
    return acceptRooms(result.rooms, result.deletedRooms);
  }, [acceptRooms]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const list = await refreshRooms();
        if (cancelled) return;
        if (
          !activeRoom.current ||
          !list.some((room) => room.id === activeRoom.current)
        ) {
          selectRoom(roomList(list, false)[0]?.id ?? null);
        }
        if (!activeRoom.current) setConnected(true);
        timer = setTimeout(() => { void load(); }, 2500);
      } catch {
        if (!cancelled) {
          if (!activeRoom.current) setConnected(false);
          timer = setTimeout(() => {
            void load();
          }, 2500);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectRoom, refreshRooms]);
  useEffect(() => {
    if (!roomId) {
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(null);
    async function poll() {
      try {
        const next = await api<RoomSnapshot>(
          `/rooms/${roomId}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted || activeRoom.current !== roomId) return;
        const merged = acceptRooms([next.room], next.deletedRooms).find(room => room.id === roomId);
        if (!merged || activeRoom.current !== roomId) return;
        setSnapshot({ ...next, room: merged });
        setConnected(true);
      } catch (cause) {
        if (!controller.signal.aborted && roomId && activeRoom.current === roomId) {
          if (cause instanceof ApiError && cause.status === 410 && cause.code === 'ROOM_DELETED') {
            acceptRooms([], [{ roomId, deletionVersion: cause.deletionVersion ?? 0, status: 'deleted' }]);
            setConnected(true);
          } else setConnected(false);
        }
      } finally {
        if (!controller.signal.aborted && activeRoom.current === roomId)
          timer = setTimeout(() => {
            void poll();
          }, 1000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [roomId, acceptRooms]);
  const createRoom = useCallback(async () => {
    const room = await api<WebRoom>("/rooms", {});
    acceptRooms([room]);
    chooseRoom(room.id);
    return room.id;
  }, [chooseRoom, acceptRooms]);
  const setRoomArchived = useCallback(async (id: string, archived: boolean) => {
    const room = await api<WebRoom>(`/rooms/${encodeURIComponent(id)}/${archived ? 'archive' : 'restore'}`, { id: crypto.randomUUID() });
    const list = acceptRooms([room]);
    const current = list.find(room => room.id === id);
    if (!current) throw new ApiError('该群聊已删除。', 410, 'ROOM_DELETED');
    if (!current.archived) selectRoom(id);
    else if (activeRoom.current === id) selectRoom(roomList(list, false)[0]?.id ?? null);
    return current;
  }, [acceptRooms, selectRoom]);
  const deleteRequest = useCallback(async (room: WebRoom, retry: boolean) => {
    const body = retry ? { deletionId: room.deletion!.id, expectedDeletionVersion: room.deletion!.version }
      : { expectedArchiveVersion: room.archiveVersion ?? 0 };
    const key = JSON.stringify([room.id, retry, body]);
    const id = commandIds.current.get(key) ?? crypto.randomUUID();
    commandIds.current.set(key, id);
    const result = await api<WebRoom | DeletedRoom>(`/rooms/${encodeURIComponent(room.id)}/${retry ? 'delete-retry' : 'delete'}`, { id, ...body });
    if ('status' in result && result.status === 'deleted') acceptRooms([], [result]);
    else acceptRooms([result as WebRoom]);
    return result;
  }, [acceptRooms]);
  const deleteRoom = useCallback((room: WebRoom) => deleteRequest(room, false), [deleteRequest]);
  const retryRoomDeletion = useCallback((room: WebRoom) => deleteRequest(room, true), [deleteRequest]);
  return {
    rooms,
    roomId,
    snapshot,
    connected,
    error,
    setError,
    chooseRoom,
    createRoom,
    refreshRooms,
    setRoomArchived,
    deletedRooms,
    deleteRoom,
    retryRoomDeletion,
  };
}
