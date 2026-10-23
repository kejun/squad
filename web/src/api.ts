import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot, WebRoom } from "../../src/web/contracts";

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
  if (!response.ok) throw new Error(value.error ?? "请求失败，请重试。");
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
  const activeRoom = useRef(roomId);
  activeRoom.current = roomId;
  const chooseRoom = useCallback((id: string) => {
    setRoomId(id);
    try {
      localStorage.setItem("squad-room", id);
    } catch {
      /* Storage is optional. */
    }
    setError("");
  }, []);
  const refreshRooms = useCallback(async () => {
    const result = await api<{ rooms: WebRoom[] }>("/rooms");
    setRooms(result.rooms);
    return result.rooms;
  }, []);
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
          if (list[0]) chooseRoom(list[0].id);
          else {
            setRoomId(null);
            try {
              localStorage.removeItem("squad-room");
            } catch {
              /* Storage is optional. */
            }
          }
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
  }, [chooseRoom, refreshRooms]);
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
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setConnected(true);
        setRooms((previous) =>
          previous.map((room) => (room.id === next.room.id ? next.room : room)),
        );
      } catch {
        if (!controller.signal.aborted) setConnected(false);
      } finally {
        if (!controller.signal.aborted)
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
  }, [roomId]);
  const createRoom = useCallback(async () => {
    const room = await api<WebRoom>("/rooms", {});
    setRooms((previous) => [
      ...previous.filter((existing) => existing.id !== room.id),
      room,
    ]);
    chooseRoom(room.id);
    return room.id;
  }, [chooseRoom]);
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
  };
}
