import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot, WebRoom } from "../../src/web/contracts";
import type { ArtifactSourceMetadata } from "../../src/types";
import { mergeRooms, roomList } from './room-list';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    readonly sourceCandidates?: ArtifactSourceMetadata[]) { super(message); }
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
  if (!response.ok) throw new ApiError(value.error ?? "请求失败，请重试。", response.status, value.code, value.sourceCandidates);
  return value as T;
}

export function useWorkspace() {
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
  const roomCache = useRef<WebRoom[]>([]);
  const acceptRooms = useCallback((incoming: WebRoom[]) => {
    roomCache.current = mergeRooms(roomCache.current, incoming);
    setRooms(roomCache.current);
    return roomCache.current;
  }, []);
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;
  const selectRoom = useCallback((id: string | null) => {
    activeRoom.current = id;
    setRoomId(id);
    try {
      if (id) localStorage.setItem("squad-room", id);
      else localStorage.removeItem("squad-room");
    } catch {
      /* Storage is optional. */
    }
    setError("");
  }, []);
  const chooseRoom = useCallback((id: string) => selectRoom(id), [selectRoom]);
  const refreshRooms = useCallback(async () => {
    const result = await api<{ rooms: WebRoom[] }>("/rooms");
    return acceptRooms(result.rooms);
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
        setConnected(true);
      } catch {
        if (!cancelled) {
          setConnected(false);
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
        const merged = acceptRooms([next.room]).find(room => room.id === roomId)!;
        setSnapshot({ ...next, room: merged });
        setConnected(true);
      } catch {
        if (!controller.signal.aborted) setConnected(false);
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
    const current = list.find(room => room.id === id)!;
    if (!current.archived) selectRoom(id);
    else if (activeRoom.current === id) selectRoom(roomList(list, false)[0]?.id ?? null);
    return current;
  }, [acceptRooms, selectRoom]);
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
  };
}
